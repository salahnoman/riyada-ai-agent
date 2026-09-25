require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const {
  customerSupportSystemPrompt,
  ownerAssistantSystemPrompt,
  callSummaryPrompt,
} = require('./knowledge-base');

const {
  ANTHROPIC_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  OWNER_WHATSAPP_NUMBER,
  COMPANY_NAME = 'الشركة',
  PORT = 3000,
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ------------------------------------------------------------------
// تخزين مؤقت في الذاكرة (يُمسح عند إعادة تشغيل السيرفر)
// لمشروع فعلي بحمل عالي، انقلها لقاعدة بيانات (Redis/Postgres)
// ------------------------------------------------------------------
const callSessions = new Map();   // CallSid -> { history: [], lines: [] }
const waSessions = new Map();     // whatsapp number -> { history: [] }

async function askClaude(systemPrompt, history) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: systemPrompt,
    messages: history,
  });
  const textBlock = msg.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text.trim() : 'عذراً، ما قدرت أفهم طلبك.';
}

// ============================================================
// 1) المكالمات الصوتية
// ============================================================

// Twilio يستدعي هذا الرابط أول ما تدخل مكالمة
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  callSessions.set(callSid, { history: [], lines: [] });

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    language: 'ar-SA',
    speechTimeout: 'auto',
    action: '/voice/gather',
    method: 'POST',
  });
  gather.say(
    { language: 'ar-SA', voice: 'Polly.Zeina' },
    `أهلاً بك في ${COMPANY_NAME}، كيف أقدر أساعدك؟`
  );
  // لو ما رد المتصل بشي
  twiml.say({ language: 'ar-SA', voice: 'Polly.Zeina' }, 'ما وصلني رد، مع السلامة.');
  res.type('text/xml').send(twiml.toString());
});

// Twilio يرسل هنا نص كلام المتصل بعد ما يحوله من صوت لنص
app.post('/voice/gather', async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const session = callSessions.get(callSid) || { history: [], lines: [] };

  const twiml = new VoiceResponse();

  if (!speech) {
    const gather = twiml.gather({
      input: 'speech',
      language: 'ar-SA',
      speechTimeout: 'auto',
      action: '/voice/gather',
      method: 'POST',
    });
    gather.say({ language: 'ar-SA', voice: 'Polly.Zeina' }, 'عذراً ما سمعتك، ممكن تعيد؟');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  session.history.push({ role: 'user', content: speech });
  session.lines.push(`العميل: ${speech}`);

  let reply;
  try {
    reply = await askClaude(customerSupportSystemPrompt(COMPANY_NAME), session.history);
  } catch (err) {
    console.error('Claude error (voice):', err);
    reply = 'عذراً، صار خلل تقني. أحد الموظفين بيتواصل معك قريباً.';
  }
  session.history.push({ role: 'assistant', content: reply });
  session.lines.push(`المساعد: ${reply}`);
  callSessions.set(callSid, session);

  const looksLikeGoodbye = /مع السلامة|وداع|شكرا|يعطيك العافية/.test(speech);

  if (looksLikeGoodbye) {
    twiml.say({ language: 'ar-SA', voice: 'Polly.Zeina' }, reply);
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: 'speech',
      language: 'ar-SA',
      speechTimeout: 'auto',
      action: '/voice/gather',
      method: 'POST',
    });
    gather.say({ language: 'ar-SA', voice: 'Polly.Zeina' }, reply);
  }

  res.type('text/xml').send(twiml.toString());
});

// اضبط هذا كـ "Call Status Changes" webhook في إعدادات رقم Twilio
// يشتغل لما تنتهي المكالمة -> يرسل ملخص للمالك عبر واتساب
app.post('/voice/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const fromNumber = req.body.From;
  res.sendStatus(200); // رد فوري لتويليو، والمعالجة تكمل بالخلفية

  if (callStatus !== 'completed') return;

  const session = callSessions.get(callSid);
  if (!session || session.lines.length === 0) return;

  const transcript = session.lines.join('\n');
  callSessions.delete(callSid);

  try {
    const summary = await askClaude(
      'أنت تلخص مكالمات لصاحب شركة بشكل مباشر ومختصر.',
      [{ role: 'user', content: callSummaryPrompt(transcript, COMPANY_NAME) }]
    );

    if (OWNER_WHATSAPP_NUMBER) {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: OWNER_WHATSAPP_NUMBER,
        body: `📞 مكالمة جديدة من ${fromNumber}\n\n${summary}`,
      });
    }
  } catch (err) {
    console.error('Error sending call summary:', err);
  }
});

// ============================================================
// 2) واتساب — نفس الرقم لمحادثات العملاء ولأوامرك الشخصية
// ============================================================

app.post('/whatsapp', async (req, res) => {
  const from = req.body.From;          // مثال: whatsapp:+9665xxxxxxxx
  const text = (req.body.Body || '').trim();
  const twiml = new MessagingResponse();

  if (!text) {
    res.type('text/xml').send(twiml.toString());
    return;
  }

  const isOwner = OWNER_WHATSAPP_NUMBER && from === OWNER_WHATSAPP_NUMBER;
  const session = waSessions.get(from) || { history: [] };
  session.history.push({ role: 'user', content: text });

  let reply;
  try {
    const systemPrompt = isOwner
      ? ownerAssistantSystemPrompt(COMPANY_NAME)
      : customerSupportSystemPrompt(COMPANY_NAME);
    reply = await askClaude(systemPrompt, session.history);
  } catch (err) {
    console.error('Claude error (whatsapp):', err);
    reply = 'عذراً، صار خلل تقني، حاول مرة ثانية بعد شوي.';
  }

  session.history.push({ role: 'assistant', content: reply });
  waSessions.set(from, session);

  // إشعار المالك برسالة عميل جديد (إلا إذا كان هو المتكلم أصلاً)
  if (!isOwner && OWNER_WHATSAPP_NUMBER) {
    twilioClient.messages
      .create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: OWNER_WHATSAPP_NUMBER,
        body: `💬 رسالة عميل جديدة من ${from}:\n"${text}"\n\nرد المساعد: ${reply}`,
      })
      .catch((err) => console.error('Error notifying owner:', err));
  }

  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

app.get('/', (req, res) => {
  res.send(`${COMPANY_NAME} AI Agent is running ✅`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

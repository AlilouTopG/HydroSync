// 🧠 AI Co-Pilot Smart Chat Endpoint (Gemini Powered)
app.post('/api/chat', async (req, res) => {
  try {
    const { message, systemState } = req.body;

    // 1. الفحص المتأخر (Lazy Evaluation) لضمان قراءة المفتاح من الـ Environment لحظة الطلب
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.error('[AI Chat] ERROR: GEMINI_API_KEY is not defined in environment variables.');
      return res.status(500).json({ reply: "[System Alert] AI Co-Pilot is offline. API Key is missing on the server." });
    }

    // 2. التهيئة المحلية للمكتبة
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);

    // 3. تأمين متغيرات الحالة لتجنب أخطاء (Undefined)
    const safeState = systemState || { safety: "UNKNOWN", activeZone: "ALL" };

    const prompt = `You are the AI Co-Pilot for "HydroSync SCADA".
    Act as a Senior Automation Engineer. Be concise, technical, and professional. Respond in the same language the operator uses. Do not use markdown.
    System State: Safety=${safeState.safety} | Zone=${safeState.activeZone}
    Operator Query: "${message}"`;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);

    res.json({ reply: result.response.text() });
    
  } catch (error) {
    console.error('[AI Chat] API Integration Error:', error.message);
    res.status(500).json({ reply: `[System Alert] Cloud AI communication error: ${error.message}` });
  }
});
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

try {
  const result = await model.generateContent('Say hello in JSON format like {"msg":"hello"}. ONLY valid JSON.');
  console.log('SUCCESS:', result.response.text());
} catch (err) {
  console.error('ERROR:', err.message);
  console.error(err.stack);
}

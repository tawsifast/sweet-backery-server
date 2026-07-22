// Run: node --env-file=.env test-gemini.mjs
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Keep in sync with model used in src/index.ts
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

async function test() {
  try {
    const result = await model.generateContent(
      'You are a bakery assistant. Respond in JSON: {"reply": "your message", "suggestions": ["q1", "q2"]}. Say hello as a bakery assistant.'
    );
    console.log('SUCCESS:', result.response.text());
  } catch (err) {
    console.error('ERROR:', err.message);
  }
}

test();

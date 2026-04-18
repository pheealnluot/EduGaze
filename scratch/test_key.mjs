// Test the Gemini key directly (bypass proxy) to isolate the issue
const key = process.env.GEMINI_API_KEY;
console.log('Key loaded:', key ? key.slice(0, 12) + '...' : 'MISSING');

const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    contents: [{role:'user', parts:[{text:'Say hello'}]}],
    generationConfig: {temperature:0.1, maxOutputTokens:20}
  })
});
console.log('Direct Gemini STATUS:', resp.status);
const t = await resp.text();
console.log('BODY:', t.slice(0, 300));

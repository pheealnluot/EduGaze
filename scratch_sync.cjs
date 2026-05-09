const fs = require('fs');

const serverCode = fs.readFileSync('server.js', 'utf8');
const lines = serverCode.split('\n');

const start = lines.findIndex(l => l.includes("app.post('/api/spot-char-generate'"));
const end = lines.findIndex((l, i) => i > start && l.trim() === '});' && lines[i-1].includes('res.json({ imageData'));

const block = lines.slice(start + 1, end).join('\n'); 

let fnCode = fs.readFileSync('functions/spot-char-fn.js', 'utf8');
const fnLines = fnCode.split('\n');
const fnStart = fnLines.findIndex(l => l.includes("const { theme: rawTheme"));
const fnEnd = fnLines.findIndex((l, i) => i > fnStart && l.trim() === '});' && fnLines[i-1].includes('res.json({ imageData'));

const before = fnLines.slice(0, fnStart).join('\n');
const after = fnLines.slice(fnEnd).join('\n');

let newBody = block;
newBody = newBody.replace(
  /const imgPath = path\.join\(__dirname, 'public', targetImageUrl\);\s*const imgBuffer = readFileSync\(imgPath\);\s*let tMime = 'image\/png';/,
  `console.log('[SpotChar] Downloading target image: ' + targetImageUrl);
      const targetUrl = 'https://edugaze.tissuepeanut.com/' + targetImageUrl;
      const imgRes = await fetch(targetUrl);
      if (!imgRes.ok) throw new Error('Download failed');
      const arrayBuffer = await imgRes.arrayBuffer();
      const imgBuffer = Buffer.from(arrayBuffer);
      let tMime = 'image/png';`
);

newBody = newBody.replace(/GEMINI_API_KEY = process\.env\.GEMINI_API_KEY \|\| '';/g, '');
newBody = newBody.replace(/GEMINI_API_KEY/g, 'apiKey');

const newFnCode = before + '\n' + newBody + '\n' + after;

fs.writeFileSync('functions/spot-char-fn.js', newFnCode);
console.log('Done syncing spot-char-fn.js');

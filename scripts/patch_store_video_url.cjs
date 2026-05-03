// patch_store_video_url.cjs — store window._compVideoUrl when adventure starts
const fs = require('fs');
const path = 'public/js/app.js';
let c = fs.readFileSync(path, 'utf8');

// Insert after _qsHistorySave(rawUrl); line
const insertAfter = '  _qsHistorySave(rawUrl);\r\n';
const funcStart = c.indexOf('window.startComprehensionFromQuizSettings = async () =>');
const insertIdx = c.indexOf(insertAfter, funcStart);
if (insertIdx === -1) { console.error('Insert point not found'); process.exit(1); }
const insertPos = insertIdx + insertAfter.length;

const patch = '  window._compVideoUrl = rawUrl; // stored for replay button\r\n';
c = c.slice(0, insertPos) + patch + c.slice(insertPos);
fs.writeFileSync(path, c);
console.log('Done — stored _compVideoUrl at offset', insertPos);

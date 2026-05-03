// patch_restore_comp.cjs — add comp cleanup to restoreHeaderFromQuizMode
const fs = require('fs');
const path = 'public/js/app.js';
let c = fs.readFileSync(path, 'utf8');

// insert the cleanup lines right after the saveQuizReportNow() call inside restoreHeaderFromQuizMode
const insertAfter = '  saveQuizReportNow();\r\n';
const insertAtIdx = c.indexOf(insertAfter, c.indexOf('function restoreHeaderFromQuizMode()'));
if (insertAtIdx === -1) { console.error('Insert point not found'); process.exit(1); }
const insertPos = insertAtIdx + insertAfter.length;

const patch =
  '\r\n  // If a comprehension adventure was running, restore patched quiz-engine globals\r\n' +
  '  if (window._compQuizRestoreFns) { window._compQuizRestoreFns(); window._compQuizRestoreFns = null; }\r\n';

c = c.slice(0, insertPos) + patch + c.slice(insertPos);
fs.writeFileSync(path, c);
console.log('Done — inserted comp restore hook at offset', insertPos);

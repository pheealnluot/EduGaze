// patch_register_restore.cjs — register _compQuizRestoreFns in _compQuizRunTextQuiz
const fs = require('fs');
const path = 'public/js/app.js';
let c = fs.readFileSync(path, 'utf8');

// Insert after the _restore arrow function definition closing brace
const insertAfter = '    quizSettings.hintThreshold  = _origHint;\n  };\n';
const idx = c.indexOf(insertAfter, c.indexOf('function _compQuizRunTextQuiz'));
if (idx === -1) { console.error('Insert point not found'); process.exit(1); }
const insertPos = idx + insertAfter.length;

const patch =
  '\n  // Register for exit-cleanup in case user double-taps Exit mid-adventure\n' +
  '  window._compQuizRestoreFns = _restore;\n';

c = c.slice(0, insertPos) + patch + c.slice(insertPos);
fs.writeFileSync(path, c);
console.log('Done at', insertPos);

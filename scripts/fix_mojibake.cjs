const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../public/js/app.js');
let content = fs.readFileSync(filePath, 'utf8');

// Helper: replace a known hex-encoded mojibake string with a proper Unicode string
function fixHex(hexFrom, strTo) {
  const bufFrom = Buffer.from(hexFrom, 'hex');
  const strFrom = bufFrom.toString('utf8');
  const before = content;
  content = content.split(strFrom).join(strTo);
  if (content !== before) {
    console.log(`Fixed: ${JSON.stringify(strFrom)} -> ${JSON.stringify(strTo)}`);
  }
}

// ⏭ Skip to Quiz  (hex: c383c2a2c382c28fc382c2ad)
fixHex('c383c2a2c382c28fc382c2ad', '\u23ed');

// ⏳ Finalising/Please wait  (hex: c383c2a2c382c28fc382c2b3)
fixHex('c383c2a2c382c28fc382c2b3', '\u23f3');

// ⚠ Generation failed — Cancel
// The "⚠ " prefix hex: c383c2a2c385c2a1c382c2a0
fixHex('c383c2a2c385c2a1c382c2a0', '\u26a0');

// The " —" em-dash in "Generation failed — Cancel"
// hex: c383c2a2c3a2e2809ac2acc3a2e282acc29d
fixHex('c383c2a2c3a2e2809ac2acc3a2e282acc29d', '\u2014');

fs.writeFileSync(filePath, content, 'utf8');
console.log('\nDone fixing remaining mojibake in app.js');

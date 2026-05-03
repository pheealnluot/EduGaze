// patch_video_autoskip.cjs — fix issue 2: don't auto-launch video immediately when
// questions arrive and skipPressed=true. Instead re-enable the skip button so user
// can choose when to proceed.
const fs = require('fs');
const path = 'public/js/app.js';
let c = fs.readFileSync(path, 'utf8');

const oldSnippet = "      if (skipPressed) {\n        const videoOv = document.getElementById('comp-quiz-video-overlay');\n        if (videoOv) videoOv.remove();\n        _compQuizRunTextQuiz(qs, eduLevel);\n      } else {";

const newSnippet = "      if (skipPressed) {\n        // User pressed skip early — questions now ready, re-enable button so\n        // they can confirm (avoids auto-cutting the video unexpectedly)\n        const skipBtn = document.getElementById('comp-quiz-video-skip');\n        if (skipBtn) {\n          skipBtn.disabled = false;\n          skipBtn.style.opacity = '1';\n          skipBtn.innerHTML = '⏭ Skip to Quiz';\n          skipBtn.style.borderColor = '#34d399';\n          skipBtn.style.color = '#34d399';\n          // Single-click now launches immediately\n          skipBtn.onclick = () => {\n            const videoOv = document.getElementById('comp-quiz-video-overlay');\n            if (videoOv) videoOv.remove();\n            _compQuizRunTextQuiz(qs, eduLevel);\n          };\n        }\n      } else {";

if (!c.includes(oldSnippet)) {
  // try CRLF version
  const oldCrlf = oldSnippet.replace(/\n/g, '\r\n');
  if (c.includes(oldCrlf)) {
    const newCrlf = newSnippet.replace(/\n/g, '\r\n');
    c = c.replace(oldCrlf, newCrlf);
    console.log('Replaced (CRLF version)');
  } else {
    console.error('Pattern not found'); process.exit(1);
  }
} else {
  c = c.replace(oldSnippet, newSnippet);
  console.log('Replaced (LF version)');
}

fs.writeFileSync(path, c);
console.log('Done');

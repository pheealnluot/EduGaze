// patch_comp_text_quiz.cjs
// Replaces _compQuizRunTextQuiz so it piggybacks the real quiz engine (renderQuizBoard)
// instead of the custom renderer. This gives 100% quiz parity for free.
const fs   = require('fs');
const path = 'public/js/app.js';
let c = fs.readFileSync(path, 'utf8');

// ── locate the block to replace ───────────────────────────────────────────
const startMarker = '// ── Text quiz (after video) ───────────────────────────────────────────────';
const endMarker   = '// ── Image-quadrant quiz ───────────────────────────────────────────────────';
const s = c.indexOf(startMarker);
const e = c.indexOf(endMarker, s);
if (s === -1 || e === -1) { console.error('Markers not found', s, e); process.exit(1); }
console.log('Replacing chars', s, 'to', e);

// ── replacement ───────────────────────────────────────────────────────────
const newBlock = [
  '// ── Text quiz (after video) — uses the real quiz engine for 100% parity ────',
  'function _compQuizRunTextQuiz(questions, eduLevel) {',
  '  window._compFromQuizQuestions = questions;',
  '  window._compFromQuizTotal     = questions.length;',
  '  window._compFromQuizIdx       = 1; // 0 served immediately below',
  '',
  '  // Translate a comprehension question → quiz question shape',
  '  const _mkQ = (cq) => {',
  '    const correctAns = (cq.answers || []).find(a => String(a.id) === String(cq.correctId));',
  '    return {',
  '      question: cq.question,',
  '      answers:  (cq.answers || []).map(a => ({ id: a.id, text: a.text, imageKeyword: \'\' })),',
  '      correctId: cq.correctId,',
  '      correctAnswerIds: [cq.correctId],',
  '      subject: \'Comprehension\',',
  '      // hint shown by quiz hint system on wrong answer(s)',
  '      hint: [',
  '        cq.explanation || \'\',',
  '        correctAns ? `The correct answer is "${correctAns.text}"` : \'\'',
  '      ].filter(Boolean).join(\' — \'),',
  '      _isCompQuestion: true,',
  '    };',
  '  };',
  '',
  '  // Save and patch quiz-engine globals',
  '  const _origGenerate    = window.generateQuizQuestion;',
  '  const _origContentTypes = quizSettings.contentTypes;',
  '  const _origTarget      = quizSettings.correctTarget;',
  '  const _origHint        = quizSettings.hintThreshold;',
  '',
  '  const _restore = () => {',
  '    window.generateQuizQuestion = _origGenerate;',
  '    quizSettings.contentTypes   = _origContentTypes;',
  '    quizSettings.correctTarget  = _origTarget;',
  '    quizSettings.hintThreshold  = _origHint;',
  '  };',
  '',
  '  // Text-only (no image pipeline); show hint on 1st wrong; win when all answered',
  '  quizSettings.contentTypes  = [\'text\'];',
  '  quizSettings.hintThreshold = 1;',
  '  quizSettings.correctTarget = questions.length;',
  '',
  '  // Override generateQuizQuestion to serve next comprehension question',
  '  window.generateQuizQuestion = () => {',
  '    const nextIdx = window._compFromQuizIdx;',
  '    if (nextIdx >= questions.length) {',
  '      // All done — restore engine; quiz will call showQuizWin() on next correct',
  '      _restore();',
  '      // Bump correctTarget to current score so the win triggers immediately',
  '      quizSettings.correctTarget = quizScore;',
  '      showQuizWin();',
  '      return;',
  '    }',
  '    window._compFromQuizIdx++;',
  '    quizWrongAttempts = 0;',
  '    const q = _mkQ(questions[nextIdx]);',
  '    quizCurrentQ = q;',
  '    renderQuizBoard(q);',
  '  };',
  '',
  '  // Enter standard quiz mode (full header, score bar, correct layout)',
  '  setQuizMode();',
  '  document.getElementById(\'quiz-settings-overlay\')?.classList.remove(\'show\');',
  '  quizScore = 0;',
  '  quizWrongAttempts = 0;',
  '  updateQuizScoreBar();',
  '',
  '  // Render first question',
  '  const firstQ = _mkQ(questions[0]);',
  '  quizCurrentQ = firstQ;',
  '  renderQuizBoard(firstQ);',
  '}',
  '',
  ''
].join('\n');

fs.writeFileSync(path, c.slice(0, s) + newBlock + c.slice(e));
console.log('Done. Old block was', e - s, 'chars; new block is', newBlock.length, 'chars');

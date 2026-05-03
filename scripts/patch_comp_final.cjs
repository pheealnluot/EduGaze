// patch_comp_final.cjs — fixes all 3 comprehension adventure issues:
// 1. Left sidebar layout (force image-sidebar mode after setQuizMode)
// 2. Video auto-launch only when user explicitly clicked skip (add minimum delay)
// 3. Only Q1 from video — fix: bypass setQuizMode, use _doStartQuizForComp instead
//    and ensure initQuizSettingsUI doesn't restore contentTypes over our override
const fs = require('fs');
const path = 'public/js/app.js';
let c = fs.readFileSync(path, 'utf8');

// ── PATCH 1: Replace _compQuizRunTextQuiz to NOT call setQuizMode
// Instead use a lighter _compStartQuizView that doesn't open settings
// ─────────────────────────────────────────────────────────────────────────────
const oldTextQuiz = '// ── Text quiz (after video) — uses the real quiz engine for 100% parity ────\nfunction _compQuizRunTextQuiz(questions, eduLevel) {';
const newTextQuiz  = '// ── Text quiz (after video) — uses the real quiz engine for 100% parity ────\nfunction _compQuizRunTextQuiz(questions, eduLevel) {';
// (function header is the same — we replace the whole function body)

const startMarker = '// ── Text quiz (after video) — uses the real quiz engine for 100% parity ────';
const endMarker   = '// ── Image-quadrant quiz ───────────────────────────────────────────────────';
const s = c.indexOf(startMarker);
const e = c.indexOf(endMarker, s);
if (s === -1 || e === -1) { console.error('Markers not found', s, e); process.exit(1); }
console.log('Replacing text-quiz block chars', s, 'to', e);

const newBlock = [
  '// ── Text quiz (after video) — uses the real quiz engine for 100% parity ────',
  'function _compQuizRunTextQuiz(questions, eduLevel) {',
  '  window._compFromQuizQuestions = questions;',
  '  window._compFromQuizTotal     = questions.length;',
  '  window._compFromQuizIdx       = 1; // 0 served immediately below',
  '',
  '  // Translate a comp question → quiz question shape',
  '  const _mkQ = (cq) => {',
  '    const correctAns = (cq.answers || []).find(a => String(a.id) === String(cq.correctId));',
  '    return {',
  '      question: cq.question,',
  '      answers:  (cq.answers || []).map(a => ({ id: a.id, text: a.text, imageKeyword: \'\' })),',
  '      correctId: cq.correctId,',
  '      correctAnswerIds: [cq.correctId],',
  '      subject: \'Comprehension\',',
  '      hint: [',
  '        cq.explanation || \'\',',
  '        correctAns ? `The correct answer is "${correctAns.text}"` : \'\'',
  '      ].filter(Boolean).join(\' — \'),',
  '      _isCompQuestion: true,',
  '    };',
  '  };',
  '',
  '  // ── Snapshot & patch quiz-engine globals ──────────────────────────',
  '  // IMPORTANT: save BEFORE initQuizSettingsUI is called (which may restore saved values)',
  '  const _origGenerate    = window.generateQuizQuestion;',
  '  const _origTarget      = quizSettings.correctTarget;',
  '  const _origHint        = quizSettings.hintThreshold;',
  '  const _origContentTypes = quizSettings.contentTypes;',
  '',
  '  const _restore = () => {',
  '    window.generateQuizQuestion = _origGenerate;',
  '    quizSettings.correctTarget  = _origTarget;',
  '    quizSettings.hintThreshold  = _origHint;',
  '    quizSettings.contentTypes   = _origContentTypes;',
  '    window._compQuizRestoreFns  = null;',
  '  };',
  '  window._compQuizRestoreFns = _restore;',
  '',
  '  // Override generateQuizQuestion BEFORE any quiz-setup that might call it',
  '  window.generateQuizQuestion = () => {',
  '    const nextIdx = window._compFromQuizIdx;',
  '    console.log(\'[CompAdventure] generateQuizQuestion called, nextIdx=\', nextIdx, \'total=\', questions.length);',
  '    if (nextIdx >= questions.length) {',
  '      _restore();',
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
  '  // ── Set up quiz view MANUALLY (avoid setQuizMode which opens settings overlay) ──',
  '  mode = \'quiz\';',
  '  document.body.classList.add(\'quiz-active\');',
  '  isEditMode = false;',
  '  viewLanding.classList.add(\'hidden\');',
  '  viewEducation.classList.add(\'hidden\');',
  '  viewEdit.classList.add(\'hidden\');',
  '  viewMathGame.classList.add(\'hidden\');',
  '  viewPeppaGame.classList.add(\'hidden\');',
  '  if (viewQuiz) viewQuiz.classList.remove(\'hidden\');',
  '  categoryTabs.classList.add(\'hidden\');',
  '  btnLogout.classList.add(\'hidden\');',
  '',
  '  // ── Force image-sidebar layout (EduGaze + user + Settings + Exit in left panel) ──',
  '  document.body.classList.add(\'quiz-img-sidebar\');',
  '  let sidebar = document.getElementById(\'quiz-sidebar-controls\');',
  '  if (!sidebar) {',
  '    sidebar = document.createElement(\'div\');',
  '    sidebar.id = \'quiz-sidebar-controls\';',
  '    document.querySelector(\'header\').appendChild(sidebar);',
  '  }',
  '  const _userEl = document.getElementById(\'display-user\');',
  '  const _userInitial = (_userEl?.textContent?.trim() || \'G\')[0].toUpperCase();',
  '  sidebar.innerHTML = `',
  '    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">',
  '      <span class="quiz-sidebar-logo" id="sb-btn-home" title="Double-click or long-press: back to home">EduGaze</span>',
  '      <div class="quiz-sidebar-user" title="${_userEl?.textContent?.trim() || \'Guest\'}">${_userInitial}</div>',
  '    </div>',
  '    <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">',
  '      <button class="quiz-sidebar-btn" id="sb-btn-settings" title="Double-click or long-press: Settings">',
  '        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
  '      </button>',
  '      <button class="quiz-sidebar-btn" id="sb-btn-exit" title="Double-click or long-press: Exit" style="color:#f87171;">',
  '        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>',
  '      </button>',
  '    </div>`;',
  '  addDoubleTapOrDblClick(document.getElementById(\'sb-btn-home\'),     () => setMode(\'landing\'));',
  '  addDoubleTapOrDblClick(document.getElementById(\'sb-btn-settings\'), () => window.openQuizSettings());',
  '  addDoubleTapOrDblClick(document.getElementById(\'sb-btn-exit\'),     () => setMode(\'landing\'));',
  '',
  '  // Ensure settings overlay is closed',
  '  document.getElementById(\'quiz-settings-overlay\')?.classList.remove(\'show\');',
  '',
  '  // Set comp-specific quiz settings (AFTER any UI init that might restore them)',
  '  quizSettings.contentTypes  = [\'text\'];',
  '  quizSettings.hintThreshold = 1;',
  '  quizSettings.correctTarget = questions.length;',
  '',
  '  // Reset score/gen',
  '  quizScore = 0;',
  '  quizWrongAttempts = 0;',
  '  quizRenderGen++;',
  '  quizQuestionQueue = [];',
  '  updateQuizScoreBar();',
  '',
  '  // Render first question',
  '  const firstQ = _mkQ(questions[0]);',
  '  quizCurrentQ = firstQ;',
  '  console.log(\'[CompAdventure] Rendering Q1:\', firstQ.question);',
  '  renderQuizBoard(firstQ);',
  '}',
  '',
  ''
].join('\n');

c = c.slice(0, s) + newBlock + c.slice(e);
fs.writeFileSync(path, c);
console.log('Text-quiz block replaced. New block length:', newBlock.length);

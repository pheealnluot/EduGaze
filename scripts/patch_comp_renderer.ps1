$file = "public\js\app.js"
$content = Get-Content $file -Raw -Encoding UTF8

# Match from "// -- Shared question renderer" comment through the closing brace of _compQuizRenderQuestion
# (stops just before the Font-fit helper comment)
$pattern = '(?s)(// ── Shared question renderer for comp-from-quiz flows ────────────────────\r?\nfunction _compQuizRenderQuestion\(\) \{).*?(\r?\n\}\r?\n\r?\n// Font-fit helper)'

$replacement = @'
// ── Shared question renderer for comp-from-quiz flows ────────────────────
function _compQuizRenderQuestion() {
  const isImgMode = document.body.classList.contains('quiz-comp-img');
  const questions = window._compFromQuizQuestions || [];
  const idx       = window._compFromQuizIdx || 0;
  const q = questions[idx];

  if (!q) {
    const score = window._compFromQuizScore || 0;
    const total = window._compFromQuizTotal || 0;
    document.body.classList.remove('quiz-comp-img');
    const imgQ = document.getElementById('comp-img-quadrant');
    const qQ   = document.getElementById('comp-q-quadrant');
    if (imgQ) imgQ.style.display = 'none';
    if (qQ)  qQ.style.display  = 'none';
    const winOv    = document.getElementById('comp-win-overlay');
    const winMsg   = document.getElementById('comp-win-message');
    const winScore = document.getElementById('comp-win-score');
    if (winMsg)   winMsg.textContent   = '\uD83C\uDF89 Adventure Complete!';
    if (winScore) winScore.textContent = `You answered ${score} out of ${total} correctly!`;
    if (winOv)    winOv.style.display  = 'flex';
    return;
  }

  // Debug console on first question
  if (idx === 0) {
    console.group('%c\uD83C\uDFAC Comprehension \u2014 Generated Questions', 'color:#a78bfa;font-size:1rem;font-weight:bold;');
    questions.forEach((cq, i) => {
      console.group(`%cQ${i + 1}: ${cq.question}`, 'color:#34d399;font-weight:600;');
      (cq.answers || []).forEach(a => {
        const ok = String(a.id) === String(cq.correctId);
        console.log(`%c  ${ok ? '\u2713' : '\u2717'} [${a.id}] ${a.text}`, ok ? 'color:#34d399' : 'color:#94a3b8');
      });
      if (cq.explanation) console.log('%c  \uD83D\uDCD6 ' + cq.explanation, 'color:#60a5fa;font-style:italic;');
      console.groupEnd();
    });
    console.groupEnd();
  }

  const scoreBadge = document.getElementById('comp-score-badge');
  if (scoreBadge) scoreBadge.textContent = `\u2B50 ${window._compFromQuizScore || 0}`;
  const counter = document.getElementById('comp-q-counter');
  if (counter) counter.textContent = `Q ${idx + 1} / ${window._compFromQuizTotal || questions.length}`;

  if (!isImgMode) {
    const qEl = document.getElementById('comp-display-question');
    if (qEl) qEl.textContent = q.question;
  } else {
    const qtEl = document.getElementById('comp-q-quadrant-text');
    if (qtEl) { qtEl.textContent = q.question; _fitTextToBox(qtEl, document.getElementById('comp-q-quadrant')); }
  }

  const oldEx = document.getElementById('comp-explanation-panel');
  if (oldEx) oldEx.remove();

  const grid = document.getElementById('comp-answers-grid');
  if (!grid) return;
  grid.innerHTML = '';
  delete grid.dataset.answered;

  const fontSizeClass = `quiz-font-${quizSettings.fontSize || 'medium'}`;
  const renderGen     = (window._compRenderGen = (window._compRenderGen || 0) + 1);

  (q.answers || []).forEach((answer) => {
    const isCorrect = String(answer.id) === String(q.correctId);

    const card = document.createElement('div');
    card.className = 'quiz-answer-card';
    Object.assign(card.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', width: '100%', padding: '1.2rem', boxSizing: 'border-box',
      textAlign: 'center', background: '#20293a', border: 'none', borderRadius: '16px',
      transition: 'transform 0.2s ease, background 0.2s ease',
      position: 'relative', overflow: 'hidden', cursor: 'pointer', userSelect: 'none',
    });

    const textSpan = document.createElement('span');
    textSpan.className = `quiz-answer-text ${fontSizeClass}`;
    Object.assign(textSpan.style, {
      color: '#f2f5f9', fontWeight: '700', textAlign: 'center', display: 'block',
      width: '100%', overflowWrap: 'break-word', pointerEvents: 'none',
      position: 'relative', zIndex: '10',
    });
    textSpan.textContent = answer.text;
    card.appendChild(textSpan);

    const progressBar = document.createElement('div');
    progressBar.className = 'absolute bottom-0 left-0 h-1.5 bg-violet-500/40 transition-none z-10';
    progressBar.style.width = '0%';
    card.appendChild(progressBar);

    let svgOverlay = null;
    const removeOverlay = () => { if (svgOverlay && svgOverlay.parentNode === card) { card.removeChild(svgOverlay); svgOverlay = null; } };
    const addOverlay    = () => {
      if (!svgOverlay) {
        svgOverlay = document.createElement('div');
        svgOverlay.className = 'absolute inset-0 flex items-center justify-center z-20 pointer-events-none';
        svgOverlay.innerHTML = '<svg class="w-28 h-28 transform -rotate-90"><circle cx="56" cy="56" r="44" class="text-slate-700/80" stroke-width="7" stroke="currentColor" fill="transparent"/><circle cx="56" cy="56" r="44" class="text-violet-400" style="opacity:0.55" stroke-width="7" stroke-dasharray="276.46" stroke-dashoffset="276.46" stroke-linecap="round" stroke="currentColor" fill="transparent"/></svg>';
        card.appendChild(svgOverlay);
      }
    };

    let dwellTimer = null;
    const dwellMs  = quizSettings.dwellTimeMs || 0;
    const startDwell = () => {
      if (!dwellMs || grid.dataset.answered) return;
      let start = null;
      const animate = (t) => {
        if (window._compRenderGen !== renderGen || grid.dataset.answered) { stopDwell(); return; }
        if (!start) start = t;
        const elapsed  = t - start;
        const progress = Math.min((elapsed / dwellMs) * 100, 100);
        progressBar.style.width = `${progress}%`;
        if (progress > 0) {
          addOverlay();
          const circle = svgOverlay ? svgOverlay.querySelector('circle:last-child') : null;
          if (circle) {
            const circ = 44 * 2 * Math.PI;
            circle.style.strokeDashoffset = circ - (progress / 100) * circ;
          }
        }
        if (progress >= 100) { stopDwell(); _compQuizSelectAnswer(answer, q, q.answers, grid, isCorrect); }
        else { dwellTimer = requestAnimationFrame(animate); }
      };
      dwellTimer = requestAnimationFrame(animate);
    };
    const stopDwell = () => {
      if (dwellTimer) { cancelAnimationFrame(dwellTimer); dwellTimer = null; }
      progressBar.style.width = '0%';
      removeOverlay();
    };

    card.addEventListener('mouseenter', () => {
      if (!card.dataset.answered && card.dataset.state !== 'wrong') card.style.background = '#364154';
      startDwell();
    });
    card.addEventListener('mouseleave', () => {
      stopDwell();
      if (card.dataset.state === 'wrong') card.style.background = 'rgba(239,68,68,0.18)';
      else if (!card.dataset.answered) card.style.background = '#20293a';
    });
    card.addEventListener('click', () => _compQuizSelectAnswer(answer, q, q.answers, grid, isCorrect));
    card.addEventListener('touchstart', (e) => { e.preventDefault(); startDwell(); });
    card.addEventListener('touchend',   (e) => { e.preventDefault(); stopDwell(); _compQuizSelectAnswer(answer, q, q.answers, grid, isCorrect); });
    card.addEventListener('touchcancel',(e) => { e.preventDefault(); stopDwell(); });

    grid.appendChild(card);
  });
}

// Font-fit helper'@

if ($content -match $pattern) {
    Write-Host "Pattern matched — applying replacement"
    $newContent = $content -replace $pattern, $replacement
    [System.IO.File]::WriteAllText((Resolve-Path $file).Path, $newContent, [System.Text.Encoding]::UTF8)
    Write-Host "Done. File updated."
} else {
    Write-Host "Pattern NOT matched — check the regex"
}

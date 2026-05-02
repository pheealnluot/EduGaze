// ═══════════════════════════════════════════════════════════════════════════
// COMPREHENSION ADVENTURE — Full game mode logic
// Loaded by index.html as a module alongside app.js
// ═══════════════════════════════════════════════════════════════════════════

// ── Education levels (mirrors app.js list) ──────────────────────────────
const _COMP_EDU_LEVELS = [
  'N1','N2','K1','K2',
  'P1','P2','P3','P4','P5','P6',
  'S1','S2','S3','S4','S5',
  'J1','J2','U1','U2','U3'
];

// ── Default subjects list (shown as chips) ───────────────────────────────
const _COMP_DEFAULT_SUBJECTS = [
  'Animals','Space','Dinosaurs','Ocean','Weather','Plants',
  'History','Science','Geography','Art','Music','Sports',
  'Technology','Food','Transport','Human Body'
];

// ── State ─────────────────────────────────────────────────────────────────
let _compSettings = {
  mediums: ['video'],
  videoDurationMin: 3,
  passageLength: 'short',
  soundsDurationSec: 90,
  numQuestions: 5,
  subjects: ['Animals'],
  educationLevel: 'P2',
  dwellTimeMs: 0,
  voiceOver: false,
  qReadEnabled: false,
  qReadTimeMs: 2000,
  aReadEnabled: false,
  aReadTimeMs: 2000,
};
let _compPhase = 'idle';    // 'settings'|'sourcing'|'media'|'questions'|'done'
let _compMedia = null;      // sourced media object
let _compQuestions = [];    // array of quiz-format question objects
let _compQIdx = 0;
let _compScore = 0;
let _compTotal = 0;
let _compTtsUtterance = null;
let _compMediaProgressTimer = null;
let _compMediaStartMs = 0;

// ── View helper ──────────────────────────────────────────────────────────
const _$ = id => document.getElementById(id);

let _compInitialized = false; // true after first open — preserves user settings

// ── Mode entry point ─────────────────────────────────────────────────────
window.setComprehensionMode = function () {
  const overlay = _$('comp-settings-overlay');
  if (overlay) overlay.style.display = 'flex';

  _initCompSettings();
  if (!_compInitialized) {
    _wireCompControls();
    _compInitialized = true;
  }
};

// ── Initialize settings UI ────────────────────────────────────────────────
function _initCompSettings() {
  // Inherit from quizSettings only on first open — preserves user edits on re-open
  if (!_compInitialized) {
    try {
      if (window.quizSettings) {
        const qs = window.quizSettings;
        _compSettings.subjects = (qs.subjects && qs.subjects.length) ? [...qs.subjects] : _compSettings.subjects;
        _compSettings.educationLevel = qs.educationLevel || _compSettings.educationLevel;
        _compSettings.dwellTimeMs = qs.dwellTimeMs ?? _compSettings.dwellTimeMs;
        _compSettings.voiceOver = qs.voiceOver ?? _compSettings.voiceOver;
        _compSettings.qReadEnabled = qs.qReadEnabled ?? _compSettings.qReadEnabled;
        _compSettings.qReadTimeMs = qs.qReadTimeMs ?? _compSettings.qReadTimeMs;
        _compSettings.aReadEnabled = qs.aReadEnabled ?? _compSettings.aReadEnabled;
        _compSettings.aReadTimeMs = qs.aReadTimeMs ?? _compSettings.aReadTimeMs;
      }
    } catch(e) {}
  }

  // Subjects — free text input + chip quick-picks
  const subjGrid = _$('comp-subjects-grid');
  if (subjGrid) {
    // Inject the text input above the grid (only once)
    let subjInput = _$('comp-subject-freetext');
    if (!subjInput) {
      subjInput = document.createElement('input');
      subjInput.id = 'comp-subject-freetext';
      subjInput.type = 'text';
      subjInput.placeholder = 'Type any subject, e.g. Volcanoes, Jazz Music…';
      subjInput.style.cssText = `width:100%;box-sizing:border-box;margin-bottom:10px;
        background:#0f172a;border:1px solid rgba(13,148,136,0.35);border-radius:10px;
        padding:8px 12px;color:#f1f5f9;font-size:0.85rem;outline:none;
        transition:border-color 0.2s;`;
      subjInput.addEventListener('focus', () => subjInput.style.borderColor = 'rgba(13,148,136,0.8)');
      subjInput.addEventListener('blur',  () => subjInput.style.borderColor = 'rgba(13,148,136,0.35)');
      subjGrid.parentElement.insertBefore(subjInput, subjGrid);
    }
    // Pre-fill with current selection
    subjInput.value = _compSettings.subjects.join(', ');

    // Live update: typing overrides chip selection
    subjInput.oninput = () => {
      const parsed = subjInput.value.split(',').map(s => s.trim()).filter(Boolean);
      _compSettings.subjects = parsed.length ? parsed : ['Animals'];
      // Reflect in chips
      subjGrid.querySelectorAll('.comp-subject-chip').forEach(btn => {
        btn.classList.toggle('active-subj', _compSettings.subjects.includes(btn.textContent));
      });
    };

    // Build chip grid
    subjGrid.innerHTML = '';
    _COMP_DEFAULT_SUBJECTS.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'comp-subject-chip' + (_compSettings.subjects.includes(s) ? ' active-subj' : '');
      btn.textContent = s;
      btn.onclick = () => {
        const idx = _compSettings.subjects.indexOf(s);
        if (idx >= 0) {
          if (_compSettings.subjects.length > 1) _compSettings.subjects.splice(idx, 1);
        } else {
          _compSettings.subjects.push(s);
        }
        btn.classList.toggle('active-subj', _compSettings.subjects.includes(s));
        // Keep text box in sync
        if (subjInput) subjInput.value = _compSettings.subjects.join(', ');
      };
      subjGrid.appendChild(btn);
    });
  }

  // Education level grid
  const eduGrid = _$('comp-edu-grid');
  if (eduGrid) {
    eduGrid.innerHTML = '';
    _COMP_EDU_LEVELS.forEach(lvl => {
      const btn = document.createElement('button');
      btn.className = 'comp-edu-chip' + (lvl === _compSettings.educationLevel ? ' active-edu' : '');
      btn.textContent = lvl;
      btn.onclick = () => {
        _compSettings.educationLevel = lvl;
        eduGrid.querySelectorAll('.comp-edu-chip').forEach(b => b.classList.remove('active-edu'));
        btn.classList.add('active-edu');
        if (_$('comp-edu-display')) _$('comp-edu-display').textContent = lvl;
      };
      eduGrid.appendChild(btn);
    });
  }
  if (_$('comp-edu-display')) _$('comp-edu-display').textContent = _compSettings.educationLevel;

  // Dwell
  if (_$('comp-dwell-input')) _$('comp-dwell-input').value = _compSettings.dwellTimeMs;
  if (_$('comp-dwell-slider')) _$('comp-dwell-slider').value = _compSettings.dwellTimeMs;

  // Voice over
  if (_$('comp-vo-enabled')) _$('comp-vo-enabled').checked = _compSettings.voiceOver;

  // qRead
  if (_$('comp-qread-enabled')) _$('comp-qread-enabled').checked = _compSettings.qReadEnabled;
  if (_$('comp-qread-input')) _$('comp-qread-input').value = _compSettings.qReadTimeMs;
  if (_$('comp-qread-slider')) _$('comp-qread-slider').value = _compSettings.qReadTimeMs;
  _updateCompReadControls('qread', _compSettings.qReadEnabled);

  // aRead
  if (_$('comp-aread-enabled')) _$('comp-aread-enabled').checked = _compSettings.aReadEnabled;
  if (_$('comp-aread-input')) _$('comp-aread-input').value = _compSettings.aReadTimeMs;
  if (_$('comp-aread-slider')) _$('comp-aread-slider').value = _compSettings.aReadTimeMs;
  _updateCompReadControls('aread', _compSettings.aReadEnabled);

  // Medium chips — mark Video active by default
  document.querySelectorAll('#comp-medium-grid .comp-medium-chip').forEach(chip => {
    const med = chip.dataset.medium;
    chip.classList.toggle('active-medium', _compSettings.mediums.includes(med));
  });
  // YouTube paste section visibility
  _updateYtPasteVisibility();
}

function _updateYtPasteVisibility() {
  const section = _$('comp-yt-paste-section');
  if (section) section.style.display = _compSettings.mediums.includes('video') ? 'flex' : 'none';
}

// ── YouTube URL parser ────────────────────────────────────────────────────
function _parseYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// State: custom video pasted by user
let _compCustomVideoId = null;
let _compCustomVideoTitle = null;

window._compClearCustomVideo = function() {
  _compCustomVideoId = null;
  _compCustomVideoTitle = null;
  const fb = _$('comp-yt-url-feedback');
  const clearBtn = _$('comp-yt-clear-btn');
  const input = _$('comp-yt-url-input');
  if (fb) fb.innerHTML = '';
  if (clearBtn) clearBtn.style.display = 'none';
  if (input) { input.style.borderColor = 'rgba(13,148,136,0.3)'; input.value = ''; }
};

function _updateCompReadControls(type, enabled) {
  const controls = _$(`comp-${type}-controls`);
  if (controls) {
    controls.style.opacity = enabled ? '1' : '0.4';
    controls.style.pointerEvents = enabled ? '' : 'none';
  }
}

function _updateCompLengthRows() {
  const hasVideo = _compSettings.mediums.includes('video');
  const hasText = _compSettings.mediums.includes('text');
  const hasSounds = _compSettings.mediums.includes('sounds');
  const videoRow = _$('comp-len-video');
  const textRow = _$('comp-len-text');
  const soundsRow = _$('comp-len-sounds');
  if (videoRow) videoRow.style.display = hasVideo ? 'flex' : 'none';
  if (textRow) textRow.style.display = hasText ? 'flex' : 'none';
  if (soundsRow) soundsRow.style.display = hasSounds ? 'flex' : 'none';
}

// ── Wire controls ─────────────────────────────────────────────────────────
function _wireCompControls() {
  // Medium chips toggle (plain divs — single click event, no double-fire)
  document.querySelectorAll('#comp-medium-grid .comp-medium-chip').forEach(chip => {
    chip.onclick = () => {
      const med = chip.dataset.medium;
      const idx = _compSettings.mediums.indexOf(med);
      if (idx >= 0) {
        if (_compSettings.mediums.length > 1) {
          _compSettings.mediums.splice(idx, 1);
          chip.classList.remove('active-medium');
        }
      } else {
        _compSettings.mediums.push(med);
        chip.classList.add('active-medium');
      }
      _updateCompLengthRows();
      _updateYtPasteVisibility();
      // Clear custom video if Video is deselected
      if (med === 'video' && !_compSettings.mediums.includes('video')) window._compClearCustomVideo();
    };
  });

  // YouTube URL paste input
  const ytInput = _$('comp-yt-url-input');
  const ytFeedback = _$('comp-yt-url-feedback');
  const ytClearBtn = _$('comp-yt-clear-btn');
  if (ytInput) {
    ytInput.addEventListener('input', () => {
      const val = ytInput.value.trim();
      if (!val) { window._compClearCustomVideo(); return; }
      const id = _parseYouTubeId(val);
      if (id) {
        _compCustomVideoId = id;
        _compCustomVideoTitle = null; // will be shown as URL
        ytInput.style.borderColor = '#10b981';
        if (ytFeedback) ytFeedback.innerHTML = `<span style="color:#34d399;">✓ Video ID detected: <code style="background:rgba(16,185,129,0.12);padding:1px 6px;border-radius:4px;">${id}</code> — AI will use this video</span>`;
        if (ytClearBtn) ytClearBtn.style.display = '';
      } else {
        _compCustomVideoId = null;
        ytInput.style.borderColor = '#ef4444';
        if (ytFeedback) ytFeedback.innerHTML = `<span style="color:#f87171;">✗ Not a recognised YouTube URL — paste the full link</span>`;
        if (ytClearBtn) ytClearBtn.style.display = 'none';
      }
    });
  }

  // Video length
  const vSlider = _$('comp-video-len-slider');
  const vDisplay = _$('comp-video-len-display');
  if (vSlider) vSlider.oninput = () => {
    _compSettings.videoDurationMin = +vSlider.value;
    if (vDisplay) vDisplay.textContent = vSlider.value;
  };

  // Sounds length
  const sSlider = _$('comp-sounds-len-slider');
  const sDisplay = _$('comp-sounds-len-display');
  if (sSlider) sSlider.oninput = () => {
    _compSettings.soundsDurationSec = +sSlider.value;
    if (sDisplay) sDisplay.textContent = sSlider.value + 's';
  };

  // Text length chips
  document.querySelectorAll('.comp-len-chip').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.comp-len-chip').forEach(b => b.classList.remove('active-len'));
      btn.classList.add('active-len');
      _compSettings.passageLength = btn.dataset.len;
    };
  });

  // Num questions
  const nqSlider = _$('comp-numq-slider');
  const nqDisplay = _$('comp-numq-display');
  if (nqSlider) nqSlider.oninput = () => {
    _compSettings.numQuestions = +nqSlider.value;
    if (nqDisplay) nqDisplay.textContent = nqSlider.value;
  };

  // Dwell sync
  const dwInput = _$('comp-dwell-input'), dwSlider = _$('comp-dwell-slider');
  if (dwInput) dwInput.oninput = () => { _compSettings.dwellTimeMs = +dwInput.value; if (dwSlider) dwSlider.value = dwInput.value; };
  if (dwSlider) dwSlider.oninput = () => { _compSettings.dwellTimeMs = +dwSlider.value; if (dwInput) dwInput.value = dwSlider.value; };

  // Voice over
  const voChk = _$('comp-vo-enabled');
  if (voChk) voChk.onchange = () => { _compSettings.voiceOver = voChk.checked; };

  // qRead
  const qrChk = _$('comp-qread-enabled');
  const qrIn = _$('comp-qread-input'), qrSl = _$('comp-qread-slider');
  if (qrChk) qrChk.onchange = () => { _compSettings.qReadEnabled = qrChk.checked; _updateCompReadControls('qread', qrChk.checked); };
  if (qrIn) qrIn.oninput = () => { _compSettings.qReadTimeMs = +qrIn.value; if (qrSl) qrSl.value = qrIn.value; };
  if (qrSl) qrSl.oninput = () => { _compSettings.qReadTimeMs = +qrSl.value; if (qrIn) qrIn.value = qrSl.value; };

  // aRead
  const arChk = _$('comp-aread-enabled');
  const arIn = _$('comp-aread-input'), arSl = _$('comp-aread-slider');
  if (arChk) arChk.onchange = () => { _compSettings.aReadEnabled = arChk.checked; _updateCompReadControls('aread', arChk.checked); };
  if (arIn) arIn.oninput = () => { _compSettings.aReadTimeMs = +arIn.value; if (arSl) arSl.value = arIn.value; };
  if (arSl) arSl.oninput = () => { _compSettings.aReadTimeMs = +arSl.value; if (arIn) arIn.value = arSl.value; };
}

// ── Stage switcher (only for game stages — NOT settings, which is fixed modal) ─
function _showCompStage(stage) {
  _compPhase = stage;
  const sourcingOv = _$('comp-sourcing-overlay');
  const mediaStage = _$('comp-media-stage');
  const qStage = _$('comp-question-stage');

  // Hide all game stages
  [sourcingOv, mediaStage, qStage].forEach(el => {
    if (el) el.style.display = 'none';
  });

  if (stage === 'sourcing' && sourcingOv) sourcingOv.style.display = 'flex';
  else if (stage === 'media' && mediaStage)  mediaStage.style.display = 'flex';
  else if (stage === 'questions' && qStage)  qStage.style.display = 'flex';
}

// ── API call helper ───────────────────────────────────────────────────────
async function _compApiCall(body) {
  const res = await fetch('/api/comprehension-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// ── START ADVENTURE ───────────────────────────────────────────────────────
window.startComprehensionAdventure = async function () {
  // Update app mode so handleAuthStateChanged doesn't reset to landing mid-session
  if (window.setMode) {
    // Use the internal mode setter without triggering the comprehension settings overlay
    window._compSetModeOnly = true;
    try { window.setMode('comprehension'); } catch(e) {}
    window._compSetModeOnly = false;
  }

  // Close win overlay if visible
  const winOv = _$('comp-win-overlay');
  if (winOv) winOv.style.display = 'none';

  // Hide the fixed settings modal
  const settingsOv = _$('comp-settings-overlay');
  if (settingsOv) settingsOv.style.display = 'none';

  // Reveal the game view full-screen
  ['view-landing','view-education','view-edit','view-math-game',
   'view-peppa-game','view-quiz','view-admin','view-my-reports'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const gameView = _$('view-comprehension');
  if (gameView) {
    gameView.classList.remove('hidden');
    gameView.style.cssText = 'display:flex;flex-direction:column;position:fixed;inset:0;z-index:500;background:#0a0f1a;';
  }

  // Stop any active TTS
  if (_compTtsUtterance) { try { speechSynthesis.cancel(); } catch(e) {} _compTtsUtterance = null; }
  clearInterval(_compMediaProgressTimer);

  // If user pasted a custom URL, force video medium
  const customId = _compCustomVideoId;
  const medium = customId ? 'video'
    : _compSettings.mediums[Math.floor(Math.random() * _compSettings.mediums.length)];
  const subject = _compSettings.subjects[Math.floor(Math.random() * _compSettings.subjects.length)] || 'general knowledge';

  // Show sourcing spinner
  _showCompStage('sourcing');
  const srcLabel = _$('comp-sourcing-label');
  const srcSub   = _$('comp-sourcing-sublabel');

  try {
    let mediaData;

    if (customId) {
      // ── User pasted a specific YouTube URL — skip sourcing entirely ──────
      if (srcLabel) srcLabel.textContent = 'Using your video — generating questions…';
      if (srcSub)   srcSub.textContent   = 'AI is analysing the video content…';
      mediaData = {
        medium: 'video',
        videoId: customId,
        youtubeUrl: `https://www.youtube.com/watch?v=${customId}`,
        title: `YouTube video (${customId})`,
        description: `User-supplied video about ${subject}`,
        channel: '',
        durationMin: _compSettings.videoDurationMin,
      };
      window._compClearCustomVideo(); // reset for next session

    } else {
      // ── Normal flow: Gemini sources media ────────────────────────────────
      if (srcLabel) srcLabel.textContent = `Finding the perfect ${medium} about ${subject}…`;
      if (srcSub)   srcSub.textContent   = 'Asking AI to choose content and prepare comprehension questions…';

      mediaData = await _compApiCall({
        phase: 'source',
        medium,
        subject,
        educationLevel: _compSettings.educationLevel,
        numQuestions: _compSettings.numQuestions,
        videoDurationMin: _compSettings.videoDurationMin,
        passageLength: _compSettings.passageLength,
      });

      // Backend signals all video attempts failed — fall back to text
      if (mediaData.error === 'no_valid_video') {
        if (window.showToast) window.showToast('No embeddable video found — switching to text mode', 'info');
        mediaData.medium = 'text';
        mediaData.passage = `Let's learn about ${subject}!`;
      }
    }

    _compMedia = mediaData;

    // Phase 2: generate comprehension questions
    if (srcLabel) srcLabel.textContent = 'Generating comprehension questions…';
    const qData = await _compApiCall({
      phase: 'questions',
      medium: mediaData.medium,
      subject,
      educationLevel: _compSettings.educationLevel,
      numQuestions: _compSettings.numQuestions,
      mediaContent: mediaData,
    });

    _compQuestions = (qData.questions || []).map((q, i) => ({
      ...q,
      _id: `comp_q_${i}`,
      _subject: subject,
      correctId: String(q.correctId),
      correctAnswerIds: [String(q.correctId)],
    }));
    _compTotal = _compQuestions.length;
    _compScore = 0;
    _compQIdx  = 0;

    // Show media stage
    _playCompMedia(mediaData);

  } catch (err) {
    console.error('[ComprehensionAdventure] Error:', err);
    // Restore the settings overlay so the user can try again
    const gameView2 = _$('view-comprehension');
    if (gameView2) gameView2.style.cssText = 'display:none;';
    _showCompStage('sourcing'); // reset internal phase
    const settingsOv2 = _$('comp-settings-overlay');
    if (settingsOv2) settingsOv2.style.display = 'flex';
    if (window.showToast) window.showToast(`Error: ${err.message}`, 'error');
  }
};



// ── PLAY MEDIA ────────────────────────────────────────────────────────────
function _playCompMedia(media) {
  _showCompStage('media');

  // Hide all media containers
  ['comp-video-iframe','comp-image-container','comp-text-container','comp-sounds-container'].forEach(id => {
    const el = _$(id);
    if (el) el.style.display = 'none';
  });

  const titleEl = _$('comp-media-title');
  const progressEl = _$('comp-media-progress');
  const skipBtn = _$('comp-skip-btn');
  const continueBtn = _$('comp-continue-btn');
  if (continueBtn) continueBtn.style.display = 'none';
  if (skipBtn) skipBtn.style.display = '';
  if (progressEl) progressEl.style.width = '0%';

  const durationMs = (media.medium === 'video') ? (_compSettings.videoDurationMin * 60 * 1000)
    : (media.medium === 'sounds') ? (_compSettings.soundsDurationSec * 1000)
    : 30000; // for image/text, 30s reading time default

  if (titleEl) titleEl.textContent = media.title || 'Content';

  // Start progress bar
  _compMediaStartMs = Date.now();
  clearInterval(_compMediaProgressTimer);
  _compMediaProgressTimer = setInterval(() => {
    const elapsed = Date.now() - _compMediaStartMs;
    const pct = Math.min(100, (elapsed / durationMs) * 100);
    if (progressEl) progressEl.style.width = pct + '%';
    if (pct >= 80 && continueBtn) {
      continueBtn.style.display = '';
    }
    if (pct >= 100) {
      clearInterval(_compMediaProgressTimer);
      window.onCompMediaComplete();
    }
  }, 500);

  // ── Show correct media type ──────────────────────────────────────────
  if (media.medium === 'video') {
    const iframe = _$('comp-video-iframe');
    const ytLinkBtn = _$('comp-yt-link-btn');
    if (iframe && media.videoId) {
      iframe.style.display = 'block';
      // enablejsapi=1 allows YouTube IFrame API to send postMessage events (incl. errors)
      iframe.src = `https://www.youtube.com/embed/${media.videoId}?autoplay=1&rel=0&modestbranding=1&enablejsapi=1`;

      // Show YouTube external link
      if (ytLinkBtn && media.youtubeUrl) {
        ytLinkBtn.href = media.youtubeUrl;
        ytLinkBtn.style.display = 'inline-flex';
      }

      // Listen for YouTube player errors via postMessage (error 100/150 = video unavailable)
      const _ytErrHandler = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.event === 'onError' && (d.info === 100 || d.info === 150 || d.info === 101)) {
            console.warn('[comp] YouTube player error', d.info, '— skipping to questions');
            window.removeEventListener('message', _ytErrHandler);
            if (window.showToast) window.showToast('Video unavailable — skipping to questions', 'info');
            setTimeout(() => window.onCompMediaComplete(), 1500);
          }
        } catch { /* non-JSON postMessage, ignore */ }
      };
      window.addEventListener('message', _ytErrHandler);

    } else if (ytLinkBtn) {
      ytLinkBtn.style.display = 'none';
    }

  } else if (media.medium === 'image') {
    const container = _$('comp-image-container');
    const imgEl = _$('comp-image-el');
    const caption = _$('comp-image-caption');
    if (container) container.style.display = 'flex';
    if (caption) caption.textContent = media.caption || '';

    // Fetch image from Pixabay
    if (imgEl && media.imageKeyword) {
      fetch(`/api/pixabay-search?q=${encodeURIComponent(media.imageKeyword + ' educational')}&per_page=5`)
        .then(r => r.json())
        .then(d => {
          const hit = d.hits && d.hits[0];
          if (hit) imgEl.src = hit.webformatURL;
        }).catch(() => {});
    }

  } else if (media.medium === 'text') {
    const container = _$('comp-text-container');
    const passageEl = _$('comp-text-passage');
    if (container) container.style.display = 'block';
    if (passageEl) passageEl.innerHTML = (media.passage || '').replace(/\n/g, '<br>');

  } else if (media.medium === 'sounds') {
    const container = _$('comp-sounds-container');
    const label = _$('comp-sounds-label');
    const passageEl = _$('comp-sounds-passage');
    const bar = _$('comp-sounds-bar');
    if (container) container.style.display = 'flex';
    if (label) label.textContent = `🔊 Listening: ${media.title || 'Narration'}`;
    if (passageEl) passageEl.textContent = ''; // hidden text, just playing audio

    // TTS narration
    if ('speechSynthesis' in window && media.passage) {
      _compTtsUtterance = new SpeechSynthesisUtterance(media.passage);
      _compTtsUtterance.rate = 0.9;
      _compTtsUtterance.pitch = 1.0;
      _compTtsUtterance.onend = () => {
        if (bar) bar.style.width = '100%';
        if (continueBtn) continueBtn.style.display = '';
      };
      speechSynthesis.speak(_compTtsUtterance);
    }
  }
}

// ── ON MEDIA COMPLETE / SKIP ──────────────────────────────────────────────
window.onCompMediaComplete = function () {
  clearInterval(_compMediaProgressTimer);
  if (_compTtsUtterance) { try { speechSynthesis.cancel(); } catch(e) {} _compTtsUtterance = null; }

  // Clear video iframe to stop audio
  const iframe = _$('comp-video-iframe');
  if (iframe) { iframe.src = ''; iframe.style.display = 'none'; }

  // Transition to questions
  _showCompStage('questions');
  _renderCompQuestion();
};

// ── RENDER QUESTION ───────────────────────────────────────────────────────
function _renderCompQuestion() {
  const q = _compQuestions[_compQIdx];
  if (!q) { _showCompWin(); return; }

  // Update counter + score
  const counter = _$('comp-q-counter');
  const scoreBadge = _$('comp-score-badge');
  if (counter) counter.textContent = `Q ${_compQIdx + 1} / ${_compTotal}`;
  if (scoreBadge) scoreBadge.textContent = `⭐ ${_compScore}`;

  // Question text
  const qDisplay = _$('comp-display-question');
  if (qDisplay) qDisplay.textContent = q.question;

  // Answer grid — quiz-style cards
  const grid = _$('comp-answers-grid');
  if (!grid) return;
  grid.innerHTML = '';
  delete grid.dataset.answered;

  // Remove any lingering explanation panel from last question
  const oldEx = _$('comp-explanation-panel');
  if (oldEx) oldEx.remove();

  // 2×2 grid matching main quiz layout
  grid.style.cssText = `display:grid;grid-template-columns:1fr 1fr;gap:10px;
    padding:12px;box-sizing:border-box;flex:1;align-content:stretch;`;

  const answers = q.answers || [];
  answers.forEach(ans => {
    const isCorrect = String(ans.id) === String(q.correctId);
    const card = document.createElement('div');
    card.className = 'quiz-answer-card';
    Object.assign(card.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', minHeight: '0', width: '100%',
      padding: '1.5rem', boxSizing: 'border-box', textAlign: 'center',
      background: '#20293a', border: 'none', borderRadius: '20px',
      transition: 'transform 0.2s ease, background 0.2s ease',
      position: 'relative', overflow: 'hidden', cursor: 'pointer', userSelect: 'none',
    });

    const textSpan = document.createElement('span');
    Object.assign(textSpan.style, {
      color: '#f2f5f9', fontWeight: '700', textAlign: 'center', display: 'block',
      width: '100%', overflowWrap: 'break-word', pointerEvents: 'none',
      fontSize: 'clamp(0.8rem,2vh,1.1rem)', lineHeight: '1.35',
    });
    textSpan.textContent = ans.text;
    card.appendChild(textSpan);

    card.addEventListener('mouseenter', () => {
      if (!card.dataset.answered && card.dataset.state !== 'wrong')
        card.style.background = '#364154';
    });
    card.addEventListener('mouseleave', () => {
      if (card.dataset.state === 'wrong') card.style.background = '#7f1d1d';
      else if (!card.dataset.answered) card.style.background = '#20293a';
    });

    card.addEventListener('click', () => _compSelectAnswer(ans, q, answers, grid, isCorrect));
    grid.appendChild(card);
  });


  // qRead delay if enabled
  if (_compSettings.qReadEnabled && _compSettings.qReadTimeMs > 0) {
    grid.style.pointerEvents = 'none';
    grid.style.opacity = '0.3';
    setTimeout(() => {
      grid.style.pointerEvents = '';
      grid.style.opacity = '1';
    }, _compSettings.qReadTimeMs);
  }

  // Voice over
  if (_compSettings.voiceOver && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(q.question);
    utt.rate = 0.9;
    speechSynthesis.speak(utt);
  }
}

// ── SELECT ANSWER ──────────────────────────────────────────────────────────
function _compSelectAnswer(ans, q, allAnswers, grid, isCorrect) {
  if (grid.dataset.answered) return;

  if (isCorrect) {
    // ── CORRECT ────────────────────────────────────────────────────────────
    grid.dataset.answered = 'true';
    grid.style.pointerEvents = 'none';

    Array.from(grid.children).forEach((card, i) => {
      const cardAns = allAnswers[i];
      if (!cardAns) return;
      if (String(cardAns.id) === String(q.correctId)) {
        card.dataset.answered = 'true';
        card.style.background = '#10b981';
        card.style.animation = 'successBounce 0.75s ease';
        card.style.transform = 'scale(1.03)';
      } else {
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
      }
    });

    _compScore++;
    const scoreBadge = _$('comp-score-badge');
    if (scoreBadge) scoreBadge.textContent = `⭐ ${_compScore}`;

    // Sounds
    if (window.playQuizCorrectSound) window.playQuizCorrectSound();
    const greenCard = Array.from(grid.children).find(c => c.dataset.answered);
    if (window.burstConfetti) window.burstConfetti(greenCard || grid);
    try {
      const sounds = ['correct1.mp3','correct2.mp3','correct3.mp3'];
      const snd = new Audio('/assets/sounds/' + sounds[Math.floor(Math.random() * sounds.length)]);
      snd.volume = 0.6;
      snd.play().catch(() => {});
    } catch (_) {}

    // Theme character celebration
    const theme = (typeof currentQuizTheme !== 'undefined') ? currentQuizTheme : 'normal';
    if      (theme === 'ben-holly'     && window.triggerBenElfCelebration) window.triggerBenElfCelebration();
    else if (theme === 'kung-fu-panda' && window.triggerKfpCelebration)    window.triggerKfpCelebration();
    else if (theme === 'totoro'        && window.triggerTotoroCelebration) window.triggerTotoroCelebration();
    else if (theme === 'turning-red'   && window.triggerTRCelebration)     window.triggerTRCelebration();
    else if (theme === 'zootopia'      && window.triggerZooCelebration)    window.triggerZooCelebration();

    setTimeout(() => {
      _compQIdx++;
      if (_compQIdx >= _compTotal) _showCompWin();
      else _renderCompQuestion();
    }, 1600);

  } else {
    // ── WRONG — grid stays interactive so player can retry ────────────────
    Array.from(grid.children).forEach(c => {
      if (c.dataset.state === 'wrong') {
        c.dataset.state = '';
        c.style.background = '#20293a';
        const old = c.querySelector('.wrong-cross');
        if (old) old.remove();
      }
    });

    const wrongCard = Array.from(grid.children)[allAnswers.indexOf(ans)];
    if (wrongCard) {
      wrongCard.dataset.state = 'wrong';
      wrongCard.style.background = 'rgba(239,68,68,0.18)';
      const cross = document.createElement('div');
      cross.className = 'wrong-cross';
      cross.style.pointerEvents = 'none';
      wrongCard.appendChild(cross);
      wrongCard.style.transform = 'translateX(-10px)';
      setTimeout(() => wrongCard.style.transform = 'translateX(10px)', 50);
      setTimeout(() => wrongCard.style.transform = 'translateX(0)', 100);
    }

    if (window.playWrongSound) window.playWrongSound();

    // Explanation panel — slides up from the bottom of the question stage
    const oldPanel = _$('comp-explanation-panel');
    if (oldPanel) oldPanel.remove();

    const explanation = q.explanation || '';
    const correctAns  = allAnswers.find(a => String(a.id) === String(q.correctId));
    const correctText  = correctAns ? correctAns.text : '';

    if (explanation || correctText) {
      const panel = document.createElement('div');
      panel.id = 'comp-explanation-panel';
      panel.style.cssText = [
        'position:absolute','bottom:0','left:0','right:0','z-index:200',
        'background:linear-gradient(135deg,rgba(15,23,42,0.97),rgba(30,41,59,0.97))',
        'border-top:2px solid rgba(239,68,68,0.4)',
        'padding:14px 18px 16px',
        'display:flex','flex-direction:column','gap:6px',
        'transform:translateY(100%)',
        'transition:transform 0.35s cubic-bezier(0.34,1.56,0.64,1)',
        'box-shadow:0 -8px 32px rgba(0,0,0,0.5)',
      ].join(';');

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const icon = document.createElement('span');
      icon.textContent = '✗';
      icon.style.cssText = 'font-size:1.1rem;color:#f87171;font-weight:900;flex-shrink:0;';
      const htxt = document.createElement('span');
      htxt.style.cssText = 'font-size:0.78rem;font-weight:800;color:#f87171;text-transform:uppercase;letter-spacing:0.06em;';
      htxt.textContent = 'Not quite — try again!';
      header.appendChild(icon); header.appendChild(htxt);
      panel.appendChild(header);

      if (correctText) {
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:0.75rem;color:#34d399;font-weight:700;';
        hint.textContent = `✓ Correct answer: ${correctText}`;
        panel.appendChild(hint);
      }

      if (explanation) {
        const body = document.createElement('div');
        body.style.cssText = 'font-size:0.8rem;color:#cbd5e1;line-height:1.5;';
        body.textContent = explanation;
        panel.appendChild(body);
      }

      const qStage = _$('comp-question-stage');
      if (qStage) {
        qStage.appendChild(panel);
        requestAnimationFrame(() => { panel.style.transform = 'translateY(0)'; });
        setTimeout(() => {
          panel.style.transition = 'transform 0.3s ease';
          panel.style.transform = 'translateY(100%)';
          setTimeout(() => { if (panel.parentNode) panel.remove(); }, 320);
        }, 4000);
      }
    }
  }
}


// ── WIN ───────────────────────────────────────────────────────────────────
function _showCompWin() {
  const winOv = _$('comp-win-overlay');
  const winMsg = _$('comp-win-message');
  const winScore = _$('comp-win-score');
  if (winMsg) winMsg.textContent = '🎉 Adventure Complete!';
  if (winScore) winScore.textContent = `You answered ${_compScore} out of ${_compTotal} correctly!`;
  if (winOv) winOv.style.display = 'flex';
}

// ── NAV ARROWS (only shown for review of previous questions) ─────────────────────
window.compNavPrev = function () {
  if (_compQIdx > 0) { _compQIdx--; _renderCompQuestion(); }
};
window.compNavNext = function () {
  if (_compQIdx < _compTotal - 1) {
    _compQIdx++;
    _renderCompQuestion();
  } else if (_compQIdx >= _compTotal - 1) {
    // At or past last question — show win
    _showCompWin();
  }
};

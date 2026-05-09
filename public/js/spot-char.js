// ── Spot the Character — multi-target game ───────────────────────────────────
const STC_KEY_THEME     = 'stc_library_theme';
const STC_KEY_SCENE     = 'stc_library_scene';
const STC_KEY_DWELL     = 'stc_dwell_ms';
const STC_KEY_FIND      = 'stc_find_count';
const STC_KEY_COUNT     = 'stc_other_count';

const STC_KEY_BG_STYLE  = 'stc_bg_style';   // background art style
const STC_KEY_DESCRIBE  = 'stc_describe_visually'; // translate franchise to visual description
const STC_KEY_DESCRIBE_SCENE = 'stc_describe_scene_visually'; // translate scene to visual description
const STC_HINT_DELAY    = 30000;
const STC_MIN_TARGET    = 0.10;  // minimum hit zone (fraction of display size)
const BBOX_PAD          = 1.5;   // multiply bbox w/h — ensures full character is covered
const PROF_COLORS       = ['#06b6d4','#8b5cf6','#f59e0b','#10b981','#f87171'];

// ── Custom Cursors (SVG data URIs) ───────────────────────────────────────────
// Pin cursor for Mark mode — 32×32 with hot-spot at pin tip (16,30)
const CURSOR_PIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cdefs%3E%3Cfilter id='s'%3E%3CfeDropShadow dx='0' dy='1' stdDeviation='1' flood-opacity='0.4'/%3E%3C/filter%3E%3C/defs%3E%3Cg filter='url(%23s)'%3E%3Ccircle cx='16' cy='10' r='7' fill='%23fbbf24' stroke='%23b45309' stroke-width='1.5'/%3E%3Crect x='15' y='16' width='2' height='12' rx='1' fill='%23713f12'/%3E%3Ccircle cx='16' cy='10' r='3' fill='%23fef3c7' opacity='0.6'/%3E%3C/g%3E%3C/svg%3E") 16 30, crosshair`;
// Trash bin cursor for Remove mode — 32×32 with hot-spot at base centre (16,28)
const CURSOR_BIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cdefs%3E%3Cfilter id='s'%3E%3CfeDropShadow dx='0' dy='1' stdDeviation='1' flood-opacity='0.4'/%3E%3C/filter%3E%3C/defs%3E%3Cg filter='url(%23s)'%3E%3Crect x='8' y='8' width='16' height='2.5' rx='1' fill='%23ef4444'/%3E%3Crect x='13' y='5' width='6' height='4' rx='1' fill='none' stroke='%23ef4444' stroke-width='1.5'/%3E%3Crect x='9.5' y='11' width='13' height='16' rx='2' fill='%23ef4444'/%3E%3Cline x1='13' y1='14' x2='13' y2='24' stroke='%23fecaca' stroke-width='1.2' stroke-linecap='round'/%3E%3Cline x1='16' y1='14' x2='16' y2='24' stroke='%23fecaca' stroke-width='1.2' stroke-linecap='round'/%3E%3Cline x1='19' y1='14' x2='19' y2='24' stroke='%23fecaca' stroke-width='1.2' stroke-linecap='round'/%3E%3C/g%3E%3C/svg%3E") 16 28, not-allowed`;

// ── Sound Effects (Web Audio API — no external files) ────────────────────────
let _audioCtx = null;
function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

// Bright 'tag placed' chime — two quick ascending tones
function _playTagSound() {
  try {
    const ctx = _getAudioCtx();
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.08);
      gain.gain.setValueAtTime(0.25, now + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.15);
    });
  } catch (_) {}
}

// Satisfying 'recycle bin' sound — descending whoosh with crumple noise
function _playBinSound() {
  try {
    const ctx = _getAudioCtx();
    const now = ctx.currentTime;
    // Descending tone (whoosh)
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.25);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.3);
    // Short crumple noise burst
    const bufLen = ctx.sampleRate * 0.08;
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufLen);
    const noise = ctx.createBufferSource();
    const nGain = ctx.createGain();
    noise.buffer = buf;
    nGain.gain.setValueAtTime(0.12, now + 0.05);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    noise.connect(nGain).connect(ctx.destination);
    noise.start(now + 0.05);
  } catch (_) {}
}

// Harsh negative buzzer — dissonant low tone
function _playBuzzerSound() {
  try {
    const ctx = _getAudioCtx();
    const now = ctx.currentTime;
    [150, 185].forEach(freq => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.35);
    });
  } catch (_) {}
}
const STC_PRESETS = [
  'Noise Nora','Tiger Came to Tea','Encanto',"Kiki's Delivery Service",
  'Castle in the Sky','Up (Disney)','Dug Days','Bluey','Lilo and Stitch',
  'Moana (Disney)','Frozen','Brave (Disney)','Tangled (Disney)',
  'Beauty and the Beast','Inside Out','Coco (Disney)','Aladdin (Disney)',
  'Mulan (Disney)','Lion King','Princess and the Frog','The Cat Returns',
  'Peppa Pig',"Ben and Holly's Little Kingdom",'Kung Fu Panda','Turning Red (Disney)',
];

// ── State ─────────────────────────────────────────────────────────────────────
let _targets      = []; // [{bbox,found,inBbox,dwellTimer,dwellEl}]
let _theme        = '';
let _foundCount   = 0;
let _attempts     = 0;  // total click-based attempts
let _failedClicks = 0;  // clicks that missed all targets (drives auto-hints)
let _allFound     = false;
let _dwellMs      = 2000;
let _origImg      = null;
let _hintTimer    = null; // kept for cleanup, no longer auto-scheduled
let _lastReqBody  = null;
let _mimeType     = 'image/png';
let _gameStartMs  = 0;   // Date.now() when game canvas first shown
let _markMode     = false; // true when user is placing a manual target
let _removeMode   = false; // true when user is removing a target
let _requestedFindN = 0;  // original requested character count
let _targetImageUrl = null; // optional user-selected image for the target character

// ── Init ──────────────────────────────────────────────────────────────────────
window.initSpotChar = async function () {
  _dwellMs = parseInt(localStorage.getItem(STC_KEY_DWELL)) || 2000;
  _seedLibrary(STC_KEY_THEME);
  _seedLibrary(STC_KEY_SCENE);
  if (window.stcPersist) await window.stcPersist.load();
  if (!window._stcBound) { window._stcBound = true; _bindEvents(); }
  _showSettings();
};

// ── Settings UI ───────────────────────────────────────────────────────────────
function _showSettings() {
  const v = document.getElementById('view-spot-char');
  if (v) v.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px 0 40px;width:100%;';
  _sec('settings');
  _targets=[]; _theme=''; _foundCount=0; _attempts=0; _failedClicks=0; _allFound=false;
  if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer=null; }
  _clearErr();
  _syncSliders();
  const thumb = _el('stc-gallery-thumb');
  if (thumb && _targetImageUrl) {
    thumb.style.display = 'block';
    thumb.src = _targetImageUrl;
  } else if (thumb) {
    thumb.style.display = 'none';
  }
}

function _sec(s) {
  _el('stc-settings-view').style.display = s==='settings' ? 'flex' : 'none';
  _el('stc-loading-view').style.display  = s==='loading'  ? 'flex' : 'none';
  _el('stc-game-view').style.display     = s==='game'     ? 'flex' : 'none';
}

function _el(id) { return document.getElementById(id); }

function _bindEvents() {
  _bindSlider('stc-find-slider',  'stc-find-value',  v => v, '', v => { localStorage.setItem(STC_KEY_FIND, v); });
  _bindSlider('stc-count-slider', 'stc-count-value', v => v, '', v => { localStorage.setItem(STC_KEY_COUNT, v); });
  _bindSlider('stc-dwell-slider', 'stc-dwell-value', v => (v/1000).toFixed(1)+'s', '', v => {
    _dwellMs = parseInt(v);
    localStorage.setItem(STC_KEY_DWELL, _dwellMs);
  });

  // Describe visually checkboxes — persist on change
  const descChk = _el('stc-describe-chk');
  if (descChk) descChk.addEventListener('change', () => {
    localStorage.setItem(STC_KEY_DESCRIBE, descChk.checked ? '1' : '0');
  });
  const descSceneChk = _el('stc-describe-scene-chk');
  if (descSceneChk) descSceneChk.addEventListener('change', () => {
    localStorage.setItem(STC_KEY_DESCRIBE_SCENE, descSceneChk.checked ? '1' : '0');
  });
  // Background style pill buttons
  document.querySelectorAll('.stc-style-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const style = btn.dataset.style;
      _setStyleBtn(style);
      localStorage.setItem(STC_KEY_BG_STYLE, style);
    });
  });
  _hist('stc-char-input',  'stc-char-dropdown',  'stc-char-clear',  STC_KEY_THEME);
  _hist('stc-scene-input', 'stc-scene-dropdown', 'stc-scene-clear', STC_KEY_SCENE);
  const startBtn = _el('stc-start-btn');
  if (startBtn) startBtn.addEventListener('click', _start);

  const charClear = _el('stc-char-clear');
  if (charClear) charClear.addEventListener('click', () => {
    _targetImageUrl = null;
    const thumb = _el('stc-gallery-thumb');
    if (thumb) thumb.style.display = 'none';
  });
}

function _bindSlider(sliderId, valId, fmt, suffix, extra) {
  const s = _el(sliderId), v = _el(valId);
  if (!s) return;
  const upd = () => { v.textContent = fmt(s.value); _grad(s); extra && extra(s.value); };
  s.addEventListener('input', upd);
}

function _grad(s) {
  const pct = ((s.value - s.min) / (s.max - s.min)) * 100;
  s.style.setProperty('--pct', pct + '%');
}

function _syncSliders() {
  // Find slider
  const sf = _el('stc-find-slider'), vf = _el('stc-find-value');
  if (sf) {
    const saved = parseInt(localStorage.getItem(STC_KEY_FIND));
    if (saved && !isNaN(saved)) sf.value = saved;
    if (vf) vf.textContent = sf.value;
    _grad(sf);
  }
  // Count slider
  const sc = _el('stc-count-slider'), vc = _el('stc-count-value');
  if (sc) {
    const saved = parseInt(localStorage.getItem(STC_KEY_COUNT));
    if (saved && !isNaN(saved)) sc.value = saved;
    if (vc) vc.textContent = sc.value;
    _grad(sc);
  }
  // Dwell slider
  const sd = _el('stc-dwell-slider'), vd = _el('stc-dwell-value');
  if (sd) { sd.value = _dwellMs; _grad(sd); }
  if (vd) vd.textContent = (_dwellMs/1000).toFixed(1)+'s';

  // Describe visually checkboxes
  const descChk = _el('stc-describe-chk');
  if (descChk) descChk.checked = localStorage.getItem(STC_KEY_DESCRIBE) === '1';
  const descSceneChk = _el('stc-describe-scene-chk');
  if (descSceneChk) descSceneChk.checked = localStorage.getItem(STC_KEY_DESCRIBE_SCENE) === '1';
  // Background style
  const savedStyle = localStorage.getItem(STC_KEY_BG_STYLE) || 'kids';
  _setStyleBtn(savedStyle);
}

function _setStyleBtn(style) {
  document.querySelectorAll('.stc-style-btn').forEach(b => b.classList.remove('stc-style-btn--active'));
  const active = document.querySelector(`.stc-style-btn[data-style="${style}"]`);
  if (active) active.classList.add('stc-style-btn--active');
}

// Keep legacy alias for any callers
function _syncDwellUI() { _syncSliders(); }

// ── Library (preset-seeded, user-editable) ────────────────────────────────────
// Module-level declarations (used internally throughout the file)
function _getLib(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function _saveLib(k, arr) { localStorage.setItem(k, JSON.stringify(arr)); }
// Window aliases (used by spot-char-persist.js)
window._stcGetLib  = _getLib;
window._stcSaveLib = _saveLib;

function _seedLibrary(key) {
  if (_getLib(key) !== null) return; // already initialised
  _saveLib(key, [...STC_PRESETS]);
}

function _addToLib(key, value) {
  if (!value.trim()) return;
  const lib = _getLib(key) || [];
  if (lib.some(v => v.toLowerCase() === value.toLowerCase().trim())) return;
  lib.unshift(value.trim());
  _saveLib(key, lib);
}

function _removeFromLib(key, value) {
  _saveLib(key, (_getLib(key) || []).filter(v => v !== value));
}

// Keep _saveH for use in _start (saves to library on game start)
function _saveH(key, value) { _addToLib(key, value); }

function _hist(inId, ddId, clrId, key) {
  const inp = _el(inId), dd = _el(ddId), clr = _el(clrId);
  if (!inp || !dd) return;
  const open = () => { _renderLib(inp, dd, key, inp.value); dd.classList.add('open'); };
  inp.addEventListener('focus', open);
  inp.addEventListener('input', open);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && inp.value.trim()) {
      _addToLib(key, inp.value.trim());
      _renderLib(inp, dd, key, inp.value);
      dd.classList.add('open');
    }
  });
  document.addEventListener('click', e => {
    if (!inp.contains(e.target) && !dd.contains(e.target)) dd.classList.remove('open');
  }, { capture: true });
  if (clr) clr.addEventListener('click', () => { inp.value = ''; open(); inp.focus(); });
}

function _renderLib(inp, dd, key, f = '') {
  const lib = (_getLib(key) || []).filter(v => !f || v.toLowerCase().includes(f.toLowerCase()));
  const q = (inp.value || '').trim();
  const canAdd = q && !lib.some(v => v.toLowerCase() === q.toLowerCase());
  const addRow = canAdd
    ? `<div class="stc-lib-add-row"><button class="stc-lib-add-btn">\uff0b Add "${q}"</button></div>`
    : '';
  dd.innerHTML =
    `<div class="stc-dropdown-header"><span>\ud83d\udcda Library <em style="color:#475569;font-weight:400;font-size:0.7rem;">\u2014 Enter to add</em></span></div>`
    + addRow
    + (lib.length
      ? lib.map(v =>
          `<div class="stc-history-item" data-val="${v.replace(/"/g,'&quot;')}">`
          + `<span class="stc-hist-icon">\ud83c\udfac</span>`
          + `<span class="stc-lib-label">${v}</span>`
          + `<button class="stc-lib-remove" title="Remove">\u2715</button>`
          + `</div>`).join('')
      : '<div class="stc-dropdown-empty">No items — type and press Enter to add</div>');

  dd.querySelectorAll('.stc-history-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('stc-lib-remove')) return;
      inp.value = el.dataset.val; dd.classList.remove('open');
    });
    el.querySelector('.stc-lib-remove').addEventListener('click', e => {
      e.stopPropagation();
      _removeFromLib(key, el.dataset.val);
      _renderLib(inp, dd, key, inp.value);
    });
  });
  const addBtn = dd.querySelector('.stc-lib-add-btn');
  if (addBtn) addBtn.addEventListener('click', e => {
    e.stopPropagation(); _addToLib(key, q); inp.value = q; dd.classList.remove('open');
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function _start() {
  const theme      = _el('stc-char-input').value.trim();
  const scene      = _el('stc-scene-input').value.trim();
  const count      = parseInt(_el('stc-count-slider').value) || 10;
  const findN      = parseInt(_el('stc-find-slider').value)  || 1;

  const bgStyle    = localStorage.getItem(STC_KEY_BG_STYLE) || 'kids';
  const describeVisually = _el('stc-describe-chk')?.checked ?? false;
  const describeSceneVisually = _el('stc-describe-scene-chk')?.checked ?? false;
  
  let finalTheme = theme;
  if (!finalTheme && !_targetImageUrl) { _el('stc-char-input').focus(); _err('Please enter a theme to find, or select a character image!'); return; }
  if (!finalTheme && _targetImageUrl) { finalTheme = 'the reference character'; }
  
  if (!scene) { _el('stc-scene-input').focus(); _err('Please describe a background scene!'); return; }
  if (theme) { _saveH(STC_KEY_THEME, theme); }
  _saveH(STC_KEY_SCENE, scene);
  
  _theme = finalTheme; _targets=[]; _foundCount=0; _attempts=0; _failedClicks=0; _allFound=false;
  _lastReqBody = { theme: finalTheme, scene, otherCount: count, findCount: findN, bgStyle, describeVisually, describeSceneVisually, targetImageUrl: _targetImageUrl };
  // ── Initialize Spot-the-Character Report Tracking ─────────────────────
  window.stcReport = {
    sessionType: 'spot-char',
    startedAt: new Date().toISOString(),
    theme: finalTheme, scene,
    findCount: findN, otherCount: count,
    bgStyle,
    modelName: 'Gemini Flash Image',
    describeVisually, describeSceneVisually,
    dwellMs: _dwellMs,
    targets: [],
    totalAttempts: 0,
    totalFailedClicks: 0,
    allFound: false,
    thumbnailDataUrl: null,
    userId: window.user?.uid || null,
  };
  if (window.stcPersist) window.stcPersist.save();
  await _generate(_lastReqBody);
}

window.stcRetry = async () => { if (_lastReqBody) { _sec('loading'); await _generate(_lastReqBody); } };

async function _generate(body) {
  _sec('loading'); _clearErr();
  _tipCycle(body.theme, body.scene, body.findCount);

  // ── Seconds counter ───────────────────────────────────────────────────────
  const counterEl = _el('stc-loading-counter');
  let _genSecs = 0;
  if (counterEl) counterEl.textContent = '0s';
  if (window._stcCountInt) clearInterval(window._stcCountInt);
  window._stcCountInt = setInterval(() => {
    _genSecs++;
    if (counterEl) counterEl.textContent = _genSecs + 's';
  }, 1000);
  const _stopCounter = () => { clearInterval(window._stcCountInt); window._stcCountInt = null; };
  // ─────────────────────────────────────────────────────────────────────────

  try {
    const r = await fetch('/api/spot-char-generate', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    const ct = r.headers.get('content-type')||'';
    if (!ct.includes('application/json')) throw new Error('Server returned unexpected response.');
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || `Server error ${r.status}`);
    clearInterval(window._stcTipInt);
    _stopCounter();
    _mimeType = d.mimeType || 'image/png';
    _targets = (d.bboxes || []).map(b => ({ bbox:b, found:false, inBbox:false, dwellTimer:null, dwellEl:null }));
    _theme   = d.theme || body.theme;
    _requestedFindN = body.findCount || 3;
    _markMode = false;
    await _showGame(d.imageData, _mimeType);
    // Show Mark + Remove buttons — always available for manual target management
    const markBtn = _el('stc-mark-btn');
    if (markBtn) markBtn.style.display = '';
    const unmarkBtn = _el('stc-unmark-btn');
    if (unmarkBtn) unmarkBtn.style.display = '';
    // If AI couldn't find any/all characters, show a discreet message
    if (d.aiHard) {
      _toast('🤯 This is so hard that AI can\'t find them! Use 📌 Mark to add targets.');
    } else if (_targets.length < _requestedFindN) {
      _toast(`🔍 AI found ${_targets.length}/${_requestedFindN}. Use 📌 Mark to add more.`);
    }
  } catch(e) {
    clearInterval(window._stcTipInt);
    _stopCounter();
    _showSettings(); _err(e.message, true);
  }
}

function _tipCycle(theme, scene, n) {
  const tips = [`Creating "${scene}" with ${n} hidden ${theme} character(s)…`, `Painting every detail of the scene…`, `Hiding ${theme} characters — can you spot them? 👀`, `Almost ready!`];
  let i=0;
  const tip = _el('stc-loading-tip');
  clearInterval(window._stcTipInt);
  if(tip) tip.textContent = tips[0];
  window._stcTipInt = setInterval(()=>{ if(tip) tip.textContent = tips[++i % tips.length]; }, 2500);
}

// ── Game View ─────────────────────────────────────────────────────────────────
async function _showGame(imageData, mime) {
  const v = _el('view-spot-char');
  if (v) v.style.cssText = 'position:fixed;inset:0;z-index:500;background:#020617;display:flex;flex-direction:column;padding:0;gap:0;';
  _sec('game');
  _el('stc-attempts-display').textContent = 'Attempts: 0';
  _el('stc-game-char-label').textContent  = `Find: ${_theme}`;

  _origImg = new Image();
  await new Promise((res,rej) => { _origImg.onload=res; _origImg.onerror=rej; _origImg.src=`data:${mime};base64,${imageData}`; });

  const oldCanvas = _el('stc-game-canvas');
  const wrap      = oldCanvas.parentElement;
  wrap.querySelectorAll('.stc-result-overlay,.stc-hint-pulse,.stc-dwell-ring').forEach(e=>e.remove());

  const canvas = document.createElement('canvas');
  canvas.id = 'stc-game-canvas'; canvas.className = oldCanvas.className;
  // Use the image's natural dimensions — no forced aspect ratio.
  // CSS (max-width/max-height: 100%) scales the canvas to fit the container.
  canvas.width  = _origImg.naturalWidth  || 1024;
  canvas.height = _origImg.naturalHeight || 576;
  wrap.replaceChild(canvas, oldCanvas);

  // ── Generate downscaled thumbnail for report ───────────────────────────
  _gameStartMs = Date.now();
  try {
    const thumbCanvas = document.createElement('canvas');
    const THUMB_W = 400;
    const aspect = _origImg.naturalHeight / _origImg.naturalWidth;
    thumbCanvas.width = THUMB_W;
    thumbCanvas.height = Math.round(THUMB_W * aspect);
    const tCtx = thumbCanvas.getContext('2d');
    tCtx.drawImage(_origImg, 0, 0, thumbCanvas.width, thumbCanvas.height);
    if (window.stcReport) {
      window.stcReport.thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.65);
    }
  } catch (e) { console.warn('[STC Report] Thumbnail generation failed:', e.message); }

  _redraw(canvas);
  _bindCanvas(canvas);
  if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = null; }
}

// ── Canvas Drawing ────────────────────────────────────────────────────────────
function _redraw(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(_origImg, 0, 0);
  _drawProfiles(ctx, canvas.width, canvas.height);
  _targets.forEach((t, i) => {
    if (!t.bbox) return;
    if (t.found) {
      _drawFoundRing(ctx, canvas, t.bbox, i);
    } else {
      // Subtle crosshair at character center
      const {x, y, w, h} = t.bbox;
      const cx = (x + w/2) * canvas.width;
      const cy = (y + h/2) * canvas.height;
      const color = PROF_COLORS[i % PROF_COLORS.length];
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4,3]);
      const arm = 12;
      ctx.beginPath(); ctx.moveTo(cx-arm,cy); ctx.lineTo(cx+arm,cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx,cy-arm); ctx.lineTo(cx,cy+arm); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.fill();
      ctx.restore();
    }
  });
}

// Profile bubble constants — compact circles only, no text
const PROF_R    = 26;   // radius of each circle
const PROF_GAP  = 10;   // gap between circles
const PROF_X    = 12;   // left margin
const PROF_Y    = 12;   // top margin


function _drawProfiles(ctx, W, H) {
  _targets.forEach((t, i) => {
    const diameter = PROF_R * 2;
    const cx = PROF_X + PROF_R;
    const cy = PROF_Y + PROF_R + i * (diameter + PROF_GAP);
    const color = PROF_COLORS[i % PROF_COLORS.length];
    ctx.save();

    // Clip to circle for the character crop thumbnail
    ctx.beginPath(); ctx.arc(cx, cy, PROF_R, 0, Math.PI*2); ctx.clip();

    if (t.found) {
      // Dim the crop and draw a green overlay
      if (_origImg && t.bbox) {
        const {x,y,w,h} = t.bbox;
        const sw = w * _origImg.naturalWidth, sh = h * _origImg.naturalHeight;
        if (sw >= 1 && sh >= 1) {
          ctx.drawImage(_origImg, x*_origImg.naturalWidth, y*_origImg.naturalHeight,
            sw, sh, cx-PROF_R, cy-PROF_R, diameter, diameter);
        }
        // Semi-transparent green wash
        ctx.fillStyle = 'rgba(16,185,129,0.55)';
        ctx.fillRect(cx-PROF_R, cy-PROF_R, diameter, diameter);
      } else {
        ctx.fillStyle = 'rgba(6,20,40,0.92)';
        ctx.fillRect(cx-PROF_R, cy-PROF_R, diameter, diameter);
      }
    } else {
      // Draw the character crop from the scene image
      if (_origImg && t.bbox) {
        const {x,y,w,h} = t.bbox;
        const sw = w * _origImg.naturalWidth, sh = h * _origImg.naturalHeight;
        if (sw >= 1 && sh >= 1) {
          ctx.drawImage(_origImg, x*_origImg.naturalWidth, y*_origImg.naturalHeight,
            sw, sh, cx-PROF_R, cy-PROF_R, diameter, diameter);
          // Slight dark vignette so ring borders pop
          ctx.fillStyle = 'rgba(0,0,0,0.10)';
          ctx.fillRect(cx-PROF_R, cy-PROF_R, diameter, diameter);
        } else {
          // Degenerate bbox — dark fill
          ctx.fillStyle = 'rgba(6,14,30,0.88)';
          ctx.fillRect(cx-PROF_R, cy-PROF_R, diameter, diameter);
        }
      } else {
        // No bbox — dark fill
        ctx.fillStyle = 'rgba(6,14,30,0.88)';
        ctx.fillRect(cx-PROF_R, cy-PROF_R, diameter, diameter);
      }
    }
    ctx.restore();

    // Outer ring — drawn AFTER clip restored so it's a proper stroke
    ctx.save();
    // Glow halo
    ctx.beginPath(); ctx.arc(cx, cy, PROF_R + 4, 0, Math.PI*2);
    ctx.fillStyle = t.found ? 'rgba(16,185,129,0.22)' : color + '33';
    ctx.fill();
    // Border ring
    ctx.beginPath(); ctx.arc(cx, cy, PROF_R, 0, Math.PI*2);
    ctx.strokeStyle = t.found ? '#10b981' : color;
    ctx.lineWidth = t.found ? 3.5 : 2.5;
    ctx.stroke();

    // Green checkmark badge when found
    if (t.found) {
      const badgeR = 10, badgeX = cx + PROF_R - 5, badgeY = cy + PROF_R - 5;
      ctx.beginPath(); ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI*2);
      ctx.fillStyle = '#10b981'; ctx.fill();
      ctx.font = `bold ${Math.round(badgeR*1.3)}px sans-serif`;
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('✓', badgeX, badgeY + 1);
    } else {
      // Question-mark badge
      const badgeR = 8, badgeX = cx + PROF_R - 4, badgeY = cy + PROF_R - 4;
      ctx.beginPath(); ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.fill();
      ctx.font = `bold 9px sans-serif`;
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', badgeX, badgeY + 0.5);
    }
    ctx.restore();
  });
}

function _drawFoundRing(ctx, canvas, bbox, idx) {
  const {x, y, w, h} = bbox;
  const px = x * canvas.width,  py = y * canvas.height;
  const pw = w * canvas.width,  ph = h * canvas.height;
  const color = PROF_COLORS[idx % PROF_COLORS.length];
  ctx.save();
  ctx.strokeStyle=color; ctx.lineWidth=5;
  ctx.shadowColor=color; ctx.shadowBlur=12;
  ctx.strokeRect(px, py, pw, ph);
  ctx.fillStyle=color+'22'; ctx.fillRect(px,py,pw,ph);
  ctx.restore();
}

function _pill(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

// ── Dwell Detection + Click to Select ────────────────────────────────────────
function _bindCanvas(canvas) {
  // mousemove: drives the dwell ring only
  canvas.addEventListener('mousemove', e => {
    if (_allFound) return;
    const rect = canvas.getBoundingClientRect();
    const rx = e.clientX-rect.left, ry = e.clientY-rect.top;
    _targets.forEach((t,i) => {
      if (t.found) return;
      const inside = _inBbox(canvas, rx, ry, t.bbox, i);
      if (inside && !t.inBbox) {
        t.inBbox=true;
        _startDwell(canvas, t, i);
      } else if (!inside && t.inBbox) {
        t.inBbox=false; _cancelDwell(t);
      }
    });
  });

  // click: mark mode (manual target placement) OR normal selection
  canvas.addEventListener('click', e => {
    // ── Mark mode: place a manual observation area ──
    if (_markMode) {
      const rect = canvas.getBoundingClientRect();
      const rx = (e.clientX - rect.left) / rect.width;  // 0.0–1.0
      const ry = (e.clientY - rect.top) / rect.height;
      const DEFAULT_W = 0.12, DEFAULT_H = 0.20;
      const bbox = {
        x: Math.max(0.01, Math.min(0.87, rx - DEFAULT_W / 2)),
        y: Math.max(0.01, Math.min(0.79, ry - DEFAULT_H / 2)),
        w: DEFAULT_W, h: DEFAULT_H,
      };
      const idx = _targets.length;
      _targets.push({ bbox, found: false, inBbox: false, dwellTimer: null, dwellEl: null });
      _markMode = false;
      const markBtn = _el('stc-mark-btn');
      if (markBtn) { markBtn.style.borderColor = 'rgba(251,191,36,0.3)'; markBtn.style.background = ''; }
      canvas.style.cursor = '';
      _redraw(canvas);
      _playTagSound();
      _toast(`📌 Target #${idx + 1} placed! Click or hover to find it.`);
      return;
    }
    // ── Remove mode: remove the closest target under the click ──
    if (_removeMode) {
      const rect = canvas.getBoundingClientRect();
      const rx = e.clientX - rect.left, ry = e.clientY - rect.top;
      let closestIdx = -1;
      let closestDist = Infinity;
      _targets.forEach((t, i) => {
        if (!t.bbox) return;
        // Check if click is inside or near the bbox
        const b = _dispBbox(canvas, t, i);
        if (!b) return;
        const dx = Math.abs(rx - b.cx), dy = Math.abs(ry - b.cy);
        // Accept clicks inside the padded bbox
        if (dx <= b.hw && dy <= b.hh) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < closestDist) { closestDist = dist; closestIdx = i; }
        }
      });
      if (closestIdx >= 0) {
        const removed = _targets[closestIdx];
        _cancelDwell(removed);
        if (removed.found) _foundCount = Math.max(0, _foundCount - 1);
        _targets.splice(closestIdx, 1);
        // Remove any hint pulses for this or higher indices
        const wrap = canvas.parentElement;
        if (wrap) wrap.querySelectorAll('.stc-hint-pulse').forEach(el => {
          const idx = parseInt(el.dataset.targetIdx, 10);
          if (idx >= closestIdx) el.remove();
        });
        _redraw(canvas);
        _playBinSound();
        _toast(`🗑 Target #${closestIdx + 1} removed! (${_targets.length} remaining)`);
      } else {
        _playBuzzerSound();
        _toast('❌ No target under click — try clicking closer to a marked area.');
      }
      return;
    }
    if (_allFound) return;
    const rect = canvas.getBoundingClientRect();
    const rx = e.clientX-rect.left, ry = e.clientY-rect.top;
    let hitTarget = false;
    _targets.forEach((t,i) => {
      if (t.found) return;
      if (_inBbox(canvas, rx, ry, t.bbox, i)) {
        hitTarget = true;
        _attempts++;
        _el('stc-attempts-display').textContent=`Attempts: ${_attempts}`;
        _onFound(canvas, t, i);
      }
    });
    if (!hitTarget) {
      _attempts++;
      _failedClicks++;
      _el('stc-attempts-display').textContent=`Attempts: ${_attempts}`;
      // Every 10 failed clicks → reveal 1 unfound target hint
      if (_failedClicks % 10 === 0) {
        _showOneHint(canvas);
        _toast(`💡 Hint unlocked after ${_failedClicks} misses!`);
      }
    }
  });

  canvas.addEventListener('mouseleave', () => _targets.forEach(t=>{ t.inBbox=false; _cancelDwell(t); }));

  // Reposition hints and redraw canvas overlays when the container resizes
  const wrap = canvas.parentElement;
  if (wrap && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      _redraw(canvas);
      _repositionHints(canvas);
    });
    ro.observe(wrap);
    // Also listen for window resize (covers edge cases like zoom changes)
    window.addEventListener('resize', () => {
      _redraw(canvas);
      _repositionHints(canvas);
    });
  }
}

// _dispBbox — converts normalised image-space bbox to display-pixel hit zone.
// The center is always the true character center (x+w/2, y+h/2).
// The hit zone is padded by BBOX_PAD so the full character body is covered.
// canvas.width/height == naturalWidth/Height, so fractions map directly.
function _dispBbox(canvas, t, idx) {
  if (!t || !t.bbox) return null;
  const rect = canvas.getBoundingClientRect();
  const {x, y, w, h} = t.bbox;

  // True character center in display pixels
  const cx = (x + w/2) * rect.width;
  const cy = (y + h/2) * rect.height;

  // Padded half-extents
  const minHW = rect.width  * STC_MIN_TARGET / 2;
  const minHH = rect.height * STC_MIN_TARGET / 2;
  const hw = Math.max((w * rect.width  * BBOX_PAD) / 2, minHW);
  const hh = Math.max((h * rect.height * BBOX_PAD) / 2, minHH);

  return { cx, cy, hw, hh };
}

function _inBbox(canvas, rx, ry, bbox, idx) {
  if (!bbox) return false;
  const b = _dispBbox(canvas, {bbox}, idx);
  return b && Math.abs(rx-b.cx)<=b.hw && Math.abs(ry-b.cy)<=b.hh;
}

function _startDwell(canvas, t, idx) {
  _cancelDwell(t);
  const wrap=canvas.parentElement, b=_dispBbox(canvas,t,idx);
  if (!b) return;
  const canvasRect = canvas.getBoundingClientRect();
  const wrapRect   = wrap.getBoundingClientRect();
  const offX = canvasRect.left - wrapRect.left;
  const offY = canvasRect.top  - wrapRect.top;
  const {cx,cy,hw,hh} = b;
  const color = PROF_COLORS[idx%PROF_COLORS.length];

  // Pad around the hit zone so the ring outline sits just outside it.
  const pad  = 10;
  const strokePad = 6; // extra padding so the 6px stroke isn't clipped by the SVG edge
  const W    = hw*2 + pad*2 + strokePad*2;
  const H    = hh*2 + pad*2 + strokePad*2;
  // Ellipse radii match the padded hit zone exactly
  const rx   = hw + pad;
  const ry   = hh + pad;
  // Approximate ellipse perimeter (Ramanujan)
  const perim = Math.PI * (3*(rx+ry) - Math.sqrt((3*rx+ry)*(rx+3*ry)));
  // NOTE: No rotation applied — both the background ellipse and animated arc
  // share the same axis-aligned orientation as the CSS hint pulse ellipse.
  // The dash animation starts at 3 o'clock, which is standard and consistent.

  const el=document.createElement('div');
  el.className='stc-dwell-ring';
  el.style.cssText=`position:absolute;left:${offX+cx}px;top:${offY+cy}px;width:${W}px;height:${H}px;transform:translate(-50%,-50%);pointer-events:none;z-index:50;`;
  el.innerHTML=`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <ellipse cx="${W/2}" cy="${H/2}" rx="${rx}" ry="${ry}" fill="${color}11" stroke="${color}44" stroke-width="3"/>
    <ellipse id="stc-arc-${idx}" cx="${W/2}" cy="${H/2}" rx="${rx}" ry="${ry}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${perim}" stroke-dashoffset="${perim}"
      style="transition:stroke-dashoffset ${_dwellMs}ms linear"/>
  </svg>`;
  wrap.appendChild(el); t.dwellEl=el;
  // Double rAF ensures the initial dashoffset is painted before the transition starts
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const arc=el.querySelector(`#stc-arc-${idx}`);
    if(arc) arc.style.strokeDashoffset='0'; // animate: empty → full
  }));
  t.dwellTimer=setTimeout(()=>{ if(t.inBbox&&!t.found) _onFound(canvas,t,idx); }, _dwellMs);
}

function _cancelDwell(t) {
  if (t.dwellTimer) { clearTimeout(t.dwellTimer); t.dwellTimer=null; }
  if (t.dwellEl)    { t.dwellEl.remove(); t.dwellEl=null; }
}

// ── Win Logic ─────────────────────────────────────────────────────────────────
function _onFound(canvas, t, idx) {
  t.found=true; t.inBbox=false; _cancelDwell(t);
  _foundCount++;
  _redraw(canvas);

  // ── Record per-target timing in report ──────────────────────────────────
  if (window.stcReport && window.stcReport.targets) {
    const foundAtMs = _gameStartMs > 0 ? Date.now() - _gameStartMs : 0;
    // Ensure targets array is large enough
    while (window.stcReport.targets.length <= idx) window.stcReport.targets.push(null);
    window.stcReport.targets[idx] = {
      bbox: t.bbox ? { x: t.bbox.x, y: t.bbox.y, w: t.bbox.w, h: t.bbox.h } : null,
      found: true,
      foundAtMs,
    };
  }

  // Partial win: mini confetti + sound
  _miniConfetti(PROF_COLORS[idx%PROF_COLORS.length]);
  if (window.playJoySound) window.playJoySound();

  // Toast message
  _toast(`🎉 Found one! ${_foundCount} of ${_targets.length} found!`);

  if (_foundCount >= _targets.length) _onAllFound(canvas);
}

function _onAllFound(canvas) {
  _allFound = true;
  if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer=null; }
  _targets.forEach(t => _cancelDwell(t));
  _launchConfetti();
  if (window.playSuccessSound) window.playSuccessSound();

  // ── Finalize and save Spot-the-Character report ────────────────────────
  _finalizeStcReport(true);

  // Show celebration banner (not fullscreen — user can still observe)
  const wrap = canvas.parentElement;
  const banner = document.createElement('div');
  banner.id='stc-all-found-banner';
  banner.style.cssText='position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(2,6,23,0.95);border:2px solid #10b981;border-radius:20px;padding:32px 48px;text-align:center;z-index:100;box-shadow:0 0 60px rgba(16,185,129,0.3);backdrop-filter:blur(8px);';
  banner.innerHTML=`<div style="font-size:3.5rem;margin-bottom:8px">🎉</div>
    <div style="font-size:1.8rem;font-weight:900;color:#34d399;margin-bottom:8px">All Found!</div>
    <div style="color:#94a3b8;font-size:0.9rem;margin-bottom:20px">Amazing work! ${_attempts} attempt${_attempts!==1?'s':''} total.</div>
    <button onclick="window.stcPlayAgain()" style="padding:12px 28px;background:linear-gradient(135deg,#06b6d4,#6366f1);border:none;border-radius:12px;color:#fff;font-weight:900;font-size:1rem;cursor:pointer;margin-right:8px;">🔄 Play Again</button>
    <button onclick="document.getElementById('stc-all-found-banner').remove()" style="padding:12px 24px;background:transparent;border:1px solid rgba(255,255,255,0.15);border-radius:12px;color:#64748b;font-weight:700;font-size:1rem;cursor:pointer;">👁 Keep Looking</button>`;
  wrap.appendChild(banner);
}

// ── Hint ──────────────────────────────────────────────────────────────────────

// Reposition ALL visible hint pulses from their stored fractional data.
// Called on initial placement and on every resize.
function _repositionHints(canvas) {
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const canvasRect = canvas.getBoundingClientRect();
  const wrapRect   = wrap.getBoundingClientRect();
  const offX = canvasRect.left - wrapRect.left;
  const offY = canvasRect.top  - wrapRect.top;
  const cw = canvasRect.width, ch = canvasRect.height;

  wrap.querySelectorAll('.stc-hint-pulse').forEach(hint => {
    const bx = parseFloat(hint.dataset.bboxX);
    const by = parseFloat(hint.dataset.bboxY);
    const bw = parseFloat(hint.dataset.bboxW);
    const bh = parseFloat(hint.dataset.bboxH);
    if (isNaN(bx)) return;
    const idx = parseInt(hint.dataset.targetIdx, 10);

    const cx = (bx + bw / 2) * cw;
    const cy = (by + bh / 2) * ch;
    const minHW = cw * STC_MIN_TARGET / 2;
    const minHH = ch * STC_MIN_TARGET / 2;
    const hw = Math.max((bw * cw * BBOX_PAD) / 2, minHW);
    const hh = Math.max((bh * ch * BBOX_PAD) / 2, minHH);

    hint.style.left   = `${offX + cx}px`;
    hint.style.top    = `${offY + cy}px`;
    hint.style.width  = `${hw * 2 + 20}px`;
    hint.style.height = `${hh * 2 + 20}px`;
  });
}

// Helper: place a pulsing hint overlay on a target
function _placeHintEl(canvas, t, i) {
  const wrap=canvas.parentElement;
  // Don't add a second hint on the same target if one already exists
  if (wrap.querySelector(`.stc-hint-pulse[data-target-idx="${i}"]`)) return;
  const b = _dispBbox(canvas, t, i);
  if (!b) return;

  const canvasRect = canvas.getBoundingClientRect();
  const wrapRect   = wrap.getBoundingClientRect();
  const offX = canvasRect.left - wrapRect.left;
  const offY = canvasRect.top  - wrapRect.top;

  const hint=document.createElement('div');
  hint.className='stc-hint-pulse';
  hint.dataset.targetIdx = i;
  // Store fractional bbox data for resize recalculation
  hint.dataset.bboxX = t.bbox.x;
  hint.dataset.bboxY = t.bbox.y;
  hint.dataset.bboxW = t.bbox.w;
  hint.dataset.bboxH = t.bbox.h;
  hint.style.cssText=`left:${offX+b.cx}px;top:${offY+b.cy}px;width:${b.hw*2+20}px;height:${b.hh*2+20}px;transform:translate(-50%,-50%);border-color:${PROF_COLORS[i%PROF_COLORS.length]};`;
  wrap.appendChild(hint);
}

// Show hints for ALL remaining unfound targets (Hint button).
// Clears any existing hints, recalculates positions from current canvas size,
// then auto-removes them after 3 seconds with a fade-out.
let _hintRemoveTimer = null;
function _showHints(canvas) {
  const wrap = canvas.parentElement;
  // Clear existing hints and any pending removal timer
  if (_hintRemoveTimer) { clearTimeout(_hintRemoveTimer); _hintRemoveTimer = null; }
  wrap.querySelectorAll('.stc-hint-pulse').forEach(e => e.remove());
  // Place fresh hints for each unfound target
  _targets.forEach((t, i) => { if (!t.found && t.bbox) _placeHintEl(canvas, t, i); });
  // Auto-remove after 3 seconds
  _hintRemoveTimer = setTimeout(() => {
    wrap.querySelectorAll('.stc-hint-pulse').forEach(el => {
      el.style.animation = 'none';
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.4s ease-out';
      setTimeout(() => el.remove(), 400);
    });
    _hintRemoveTimer = null;
  }, 3000);
}

// Show a hint on ONE unfound target (auto-hint from 10 failed clicks).
// Also auto-removes after 3 seconds.
function _showOneHint(canvas) {
  const unfound = _targets
    .map((t,i) => ({t,i}))
    .filter(({t,i}) => !t.found && t.bbox);
  if (!unfound.length) return;
  const {t,i} = unfound[Math.floor(Math.random() * unfound.length)];
  const wrap = canvas.parentElement;
  wrap.querySelectorAll(`.stc-hint-pulse[data-target-idx="${i}"]`).forEach(e => e.remove());
  _placeHintEl(canvas, t, i);
  setTimeout(() => {
    wrap.querySelectorAll(`.stc-hint-pulse[data-target-idx="${i}"]`).forEach(el => {
      el.style.animation = 'none';
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.4s ease-out';
      setTimeout(() => el.remove(), 400);
    });
  }, 3000);
}

// Hint button: show ALL remaining hints
window.stcShowHint=()=>{ const c=_el('stc-game-canvas'); if(c) _showHints(c); };

// ── Confetti ──────────────────────────────────────────────────────────────────
function _miniConfetti(color) {
  for(let i=0;i<15;i++) {
    const el=document.createElement('div');
    el.className='stc-confetti';
    const s=6+Math.random()*6, d=1.2+Math.random()*1;
    el.style.cssText=`left:${20+Math.random()*60}vw;width:${s}px;height:${s}px;background:${color};animation-duration:${d}s;animation-delay:${Math.random()*0.3}s;border-radius:50%;`;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),(d+1)*1000);
  }
}

function _launchConfetti() {
  const cols=['#06b6d4','#8b5cf6','#34d399','#fbbf24','#f87171'];
  for(let i=0;i<70;i++) {
    const el=document.createElement('div'); el.className='stc-confetti';
    const s=7+Math.random()*8, d=2.5+Math.random()*2;
    el.style.cssText=`left:${Math.random()*100}vw;width:${s}px;height:${s*(0.4+Math.random()*0.8)}px;background:${cols[i%cols.length]};animation-duration:${d}s;animation-delay:${Math.random()*0.8}s;border-radius:${Math.random()>.5?'50%':'2px'};`;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),(d+1)*1000);
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function _toast(msg) {
  const old=document.getElementById('stc-toast'); if(old) old.remove();
  const el=document.createElement('div'); el.id='stc-toast';
  el.style.cssText='position:fixed;top:72px;left:50%;transform:translateX(-50%);background:rgba(2,6,23,0.95);border:1px solid rgba(16,185,129,0.4);border-radius:12px;padding:12px 24px;color:#34d399;font-weight:700;font-size:0.9rem;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.4);transition:opacity 0.3s;';
  el.textContent=msg; document.body.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; setTimeout(()=>el.remove(),300); },2500);
}

// ── Report Finalization & Saving ──────────────────────────────────────────────
function _finalizeStcReport(allFoundFlag) {
  if (!window.stcReport || window.stcReport._saved) return;
  window.stcReport.allFound = allFoundFlag;
  window.stcReport.totalAttempts = _attempts;
  window.stcReport.totalFailedClicks = _failedClicks;
  window.stcReport.endedAt = new Date().toISOString();
  window.stcReport.durationMs = _gameStartMs > 0 ? Date.now() - _gameStartMs : 0;
  // Fill in any unfound targets
  _targets.forEach((t, i) => {
    if (!window.stcReport.targets[i]) {
      window.stcReport.targets[i] = {
        bbox: t.bbox ? { x: t.bbox.x, y: t.bbox.y, w: t.bbox.w, h: t.bbox.h } : null,
        found: !!t.found,
        foundAtMs: null,
      };
    }
  });
  window.saveStcReportNow();
}

window.saveStcReportNow = async function () {
  if (!window.stcReport) return;
  if (window.stcReport._saved) return;
  window.stcReport._saved = true;
  try {
    const { addDoc: _addDoc, collection: _col } = await import('https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js');
    const docRef = await _addDoc(_col(window.db, 'quiz_reports'), window.stcReport);
    console.log('[StcReport] Saved! Doc ID:', docRef.id);
    window.stcReport = null;
  } catch (err) {
    console.error('[StcReport] Failed to save:', err.code, err.message);
    window.stcReport._saved = false; // allow retry
  }
};

// ── Navigation ────────────────────────────────────────────────────────────────
window.stcOpenSettings = () => { _finalizeStcReport(false); _targets.forEach(t=>_cancelDwell(t)); const w=_el('stc-canvas-wrap'); if(w) w.querySelectorAll('.stc-result-overlay,.stc-hint-pulse,.stc-dwell-ring,#stc-all-found-banner').forEach(e=>e.remove()); _showSettings(); };
window.stcPlayAgain    = () => { _targets.forEach(t=>_cancelDwell(t)); const w=_el('stc-canvas-wrap'); if(w) w.querySelectorAll('.stc-result-overlay,.stc-hint-pulse,.stc-dwell-ring,#stc-all-found-banner').forEach(e=>e.remove()); _showSettings(); };
window.stcGoHome       = () => { _finalizeStcReport(false); _markMode=false; _removeMode=false; _targets.forEach(t=>_cancelDwell(t)); if(window.setMode) window.setMode('landing'); };

// ── Mark Target Toggle ───────────────────────────────────────────────────────
window.stcToggleMark = () => {
  const canvas = _el('stc-game-canvas');
  const btn = _el('stc-mark-btn');
  if (!canvas) return;
  // Deactivate remove mode if active
  if (_removeMode) {
    _removeMode = false;
    const ubtn = _el('stc-unmark-btn');
    if (ubtn) { ubtn.style.borderColor = 'rgba(248,113,113,0.3)'; ubtn.style.background = ''; }
  }
  _markMode = !_markMode;
  if (_markMode) {
    canvas.style.cursor = CURSOR_PIN;
    if (btn) { btn.style.borderColor = '#fbbf24'; btn.style.background = 'rgba(251,191,36,0.15)'; }
    _toast('📌 Click on the image to place a target area');
  } else {
    canvas.style.cursor = '';
    if (btn) { btn.style.borderColor = 'rgba(251,191,36,0.3)'; btn.style.background = ''; }
  }
};
window.stcToggleUnmark = () => {
  const canvas = _el('stc-game-canvas');
  const btn = _el('stc-unmark-btn');
  if (!canvas) return;
  // Deactivate mark mode if active
  if (_markMode) {
    _markMode = false;
    const mbtn = _el('stc-mark-btn');
    if (mbtn) { mbtn.style.borderColor = 'rgba(251,191,36,0.3)'; mbtn.style.background = ''; }
  }
  _removeMode = !_removeMode;
  if (_removeMode) {
    canvas.style.cursor = CURSOR_BIN;
    if (btn) { btn.style.borderColor = '#f87171'; btn.style.background = 'rgba(248,113,113,0.15)'; }
    _toast('🗑 Click on a target to remove it');
  } else {
    canvas.style.cursor = '';
    if (btn) { btn.style.borderColor = 'rgba(248,113,113,0.3)'; btn.style.background = ''; }
  }
};
window.stcRetry        = async () => { if(_lastReqBody) { _sec('loading'); _tipCycle(_lastReqBody.theme,_lastReqBody.scene,_lastReqBody.findCount); await _generate(_lastReqBody); } };

// ── Error ─────────────────────────────────────────────────────────────────────
function _err(msg, retry=false) {
  const b=_el('stc-error-box'); if(!b) return;
  b.innerHTML=`❌ ${msg}`+(retry?` <button onclick="window.stcRetry()" style="margin-left:10px;padding:4px 12px;background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.4);border-radius:8px;color:#a5b4fc;font-size:0.78rem;font-weight:700;cursor:pointer;">🔄 Retry</button>`:'');
  b.style.display='block';
}
function _clearErr() { const b=_el('stc-error-box'); if(b){b.style.display='none';b.innerHTML='';} }

// ── Gallery Data & Logic ───────────────────────────────────────────────────────
let STC_GALLERY_IMAGES = [];

window.stcOpenGallery = async function() {
  const modal = document.getElementById('stc-gallery-modal');
  const grid = document.getElementById('stc-gallery-grid');
  if (!modal || !grid) return;
  
  modal.style.display = 'flex';
  
  if (STC_GALLERY_IMAGES.length === 0) {
    grid.innerHTML = '<div style="color:#94a3b8;grid-column:1/-1;text-align:center;padding:40px;">Loading characters...</div>';
    try {
      const res = await fetch('/api/spot-char-gallery');
      const data = await res.json();
      if (data.images) STC_GALLERY_IMAGES = data.images;
    } catch(e) {
      grid.innerHTML = '<div style="color:#ef4444;grid-column:1/-1;text-align:center;padding:40px;">Failed to load characters</div>';
      return;
    }
  }
  
  grid.innerHTML = STC_GALLERY_IMAGES.map((img, i) => `
    <div onclick="window.stcSelectGalleryItem(${i})" style="position:relative;cursor:pointer;background:rgba(255,255,255,0.05);border-radius:12px;padding:12px;display:flex;flex-direction:column;align-items:center;transition:all 0.2s;border:2px solid transparent;" onmouseover="this.style.background='rgba(255,255,255,0.1)';this.querySelector('.stc-del-btn').style.opacity='1'" onmouseout="this.style.background='rgba(255,255,255,0.05)';this.querySelector('.stc-del-btn').style.opacity='0'">
      <button class="stc-del-btn" onclick="window.stcDeleteGalleryItem(${i}, event)" style="position:absolute;top:4px;right:4px;background:rgba(239,68,68,0.8);color:white;border:none;border-radius:50%;width:24px;height:24px;font-size:0.8rem;cursor:pointer;opacity:0;transition:opacity 0.2s;display:flex;align-items:center;justify-content:center;" title="Remove from Gallery">✕</button>
      <img src="${img.url}" style="width:100%;height:100px;object-fit:contain;margin-bottom:8px;" />
      <span style="font-size:0.8rem;color:#cbd5e1;text-align:center;font-weight:600;">${img.name}</span>
    </div>
  `).join('');
};

window.stcCloseGallery = function() {
  const modal = document.getElementById('stc-gallery-modal');
  if (modal) modal.style.display = 'none';
};

window.stcSelectGalleryItem = function(idx) {
  const img = STC_GALLERY_IMAGES[idx];
  _targetImageUrl = img.url;
  
  const inp = document.getElementById('stc-char-input');
  if (inp) inp.value = img.name;
  
  const thumb = document.getElementById('stc-gallery-thumb');
  if (thumb) {
    thumb.src = img.url;
    thumb.style.display = 'block';
  }
  
  window.stcCloseGallery();
};

window.stcUploadImage = async function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const btn = e.target.previousElementSibling;
  const originalText = btn.innerHTML;
  btn.innerHTML = `<span style="font-size:1.1rem;">⌛</span> Uploading...`;
  btn.disabled = true;

  try {
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const base64 = evt.target.result;
      const res = await fetch('/api/spot-char-gallery/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, imageBase64: base64 })
      });
      if (res.ok) {
        STC_GALLERY_IMAGES = []; // Invalidate
        window.stcOpenGallery(); // Refresh
      } else {
        alert('Failed to upload image');
      }
    };
    reader.readAsDataURL(file);
  } catch (err) {
    alert('Failed to upload image');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
    e.target.value = ''; // Reset input
  }
};

window.stcDeleteGalleryItem = async function(idx, event) {
  event.stopPropagation();
  if (!confirm('Are you sure you want to remove this character from the gallery?')) return;
  const img = STC_GALLERY_IMAGES[idx];
  
  try {
    const res = await fetch('/api/spot-char-gallery/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: img.url })
    });
    if (res.ok) {
      STC_GALLERY_IMAGES.splice(idx, 1);
      window.stcOpenGallery(); // Re-render grid
    } else {
      alert('Failed to delete image');
    }
  } catch (err) {
    alert('Failed to delete image');
  }
};

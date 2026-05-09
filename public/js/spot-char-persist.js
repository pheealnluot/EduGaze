// spot-char-persist.js — Firestore + localStorage persistence for Spot the Character settings
// Loaded after spot-char.js

(function () {
  // ── Helpers ────────────────────────────────────────────────────────────────
  function _el(id) { return document.getElementById(id); }
  function _grad(s) {
    const pct = ((s.value - s.min) / (s.max - s.min)) * 100;
    s.style.setProperty('--pct', pct + '%');
  }

  function _getUid() {
    const u = window.currentUser;
    if (!u || u.isGuest || u.isAnonymous || u.uid === 'guest-local') return null;
    return u.uid;
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function saveSettings() {
    const libT = window._stcGetLib ? window._stcGetLib('stc_library_theme') : null;
    const libS = window._stcGetLib ? window._stcGetLib('stc_library_scene') : null;
    const s = {
      theme:        (_el('stc-char-input')?.value  || '').trim(),
      scene:        (_el('stc-scene-input')?.value || '').trim(),
      findCount:    parseInt(_el('stc-find-slider')?.value)  || 1,
      otherCount:   parseInt(_el('stc-count-slider')?.value) || 10,
      dwellMs:      parseInt(localStorage.getItem('stc_dwell_ms')) || 2000,
      bgStyle:      localStorage.getItem('stc_bg_style') || 'kids',
      describeVisually: localStorage.getItem('stc_describe_visually') === '1',
      libraryTheme: libT || [],
      libraryScene: libS || [],
    };
    localStorage.setItem('stc_settings_v1', JSON.stringify(s));

    const uid = _getUid();
    if (!uid) return;
    try {
      const { getFirestore, doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js');
      const { getApp } = await import('https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js');
      await setDoc(doc(getFirestore(getApp()), 'configs', uid), { spotChar: s }, { merge: true });
      console.log('[SpotChar] Settings saved to Firestore');
    } catch (e) {
      console.warn('[SpotChar] Firestore save skipped:', e.message);
    }
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  async function loadSettings() {
    let s = null;
    const uid = _getUid();
    if (uid) {
      try {
        const { getFirestore, doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js');
        const { getApp } = await import('https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js');
        const snap = await getDoc(doc(getFirestore(getApp()), 'configs', uid));
        if (snap.exists() && snap.data().spotChar) {
          s = snap.data().spotChar;
          console.log('[SpotChar] Settings loaded from Firestore');
        }
      } catch (e) {
        console.warn('[SpotChar] Firestore load skipped:', e.message);
      }
    }
    if (!s) {
      try { s = JSON.parse(localStorage.getItem('stc_settings_v1')); } catch { s = null; }
    }
    if (!s) return;

    // Apply to UI
    if (s.theme  && _el('stc-char-input'))   _el('stc-char-input').value  = s.theme;
    if (s.scene  && _el('stc-scene-input'))  _el('stc-scene-input').value = s.scene;

    const applySlider = (sid, vid, val, fmt) => {
      const sl = _el(sid); if (!sl) return;
      sl.value = val; _grad(sl);
      const vl = _el(vid); if (vl) vl.textContent = fmt(val);
    };
    if (s.findCount)  applySlider('stc-find-slider',  'stc-find-value',  s.findCount,  v => v);
    if (s.otherCount) applySlider('stc-count-slider', 'stc-count-value', s.otherCount, v => v);
    if (s.dwellMs) {
      localStorage.setItem('stc_dwell_ms', s.dwellMs);
      applySlider('stc-dwell-slider', 'stc-dwell-value', s.dwellMs, v => (v/1000).toFixed(1)+'s');
    }
    if (s.bgStyle) {
      localStorage.setItem('stc_bg_style', s.bgStyle);
      // Update pill UI if _setStyleBtn is available (spot-char.js loaded)
      if (typeof _setStyleBtn === 'function') _setStyleBtn(s.bgStyle);
    }
    if (typeof s.describeVisually === 'boolean') {
      localStorage.setItem('stc_describe_visually', s.describeVisually ? '1' : '0');
      const chk = _el('stc-describe-chk');
      if (chk) chk.checked = s.describeVisually;
    }

    // Restore library lists
    if (window._stcSaveLib) {
      if (Array.isArray(s.libraryTheme) && s.libraryTheme.length) window._stcSaveLib('stc_library_theme', s.libraryTheme);
      if (Array.isArray(s.libraryScene) && s.libraryScene.length) window._stcSaveLib('stc_library_scene', s.libraryScene);
    }
  }

  // ── Expose hooks ──────────────────────────────────────────────────────────
  window.stcPersist = { save: saveSettings, load: loadSettings };
})();

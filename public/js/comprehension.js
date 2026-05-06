// ═══════════════════════════════════════════════════════════════════════════
// COMPREHENSION ADVENTURE — stub
//
// All logic has been consolidated into app.js.
// Entry point: Knowledge Explorer → Quiz Settings → 🎬 Comprehension tab.
//
// Key functions now in app.js:
//   window.startComprehensionFromQuizSettings()
//   window._compRunTransitionSlide(callback)
//   window.compPlayAgain()
//   window.compExitAdventure()
//   window._qsModeSwitch('comp')
// ═══════════════════════════════════════════════════════════════════════════

// These are referenced by onclick attributes in index.html win overlay —
// defined here as safety stubs in case app.js hasn't set them yet.
if (!window.compExitAdventure) {
  window.compExitAdventure = () => { if (window.setMode) window.setMode('landing'); };
}
if (!window.compPlayAgain) {
  window.compPlayAgain = () => {
    if (window.setMode) window.setMode('quiz');
    setTimeout(() => { if (window._qsModeSwitch) window._qsModeSwitch('comp'); }, 100);
  };
}

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword, linkWithCredential, EmailAuthProvider, updatePassword, reauthenticateWithCredential, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js';

// Firebase configuration
const firebaseConfig = {
  projectId: "edugaze-50cdb",
  appId: "1:775011941712:web:eb8d401324ee83ba4b8055",
  storageBucket: "edugaze-50cdb.firebasestorage.app",
  apiKey: "AIzaSyACPuElfTu3s76-usOgs9j6dmPma2H9tfc",
  authDomain: "edugaze-50cdb.firebaseapp.com",
  messagingSenderId: "775011941712",
  measurementId: "G-3P6WCE7QPP"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Gemini API helper (direct REST, no extra SDK needed)
const GEMINI_API_KEY = firebaseConfig.apiKey;
async function callGeminiJSON(prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 1024,
    }
  };
  // Proxy call — key is kept secure in Firebase Secret Manager (server-side only)
  const resp = await fetch('/api/quiz-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Gemini API error ${resp.status}`);
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error('Response was not JSON');
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}
const googleProvider = new GoogleAuthProvider();

const STORAGE_KEY = 'eduApp_data_v2';
const initData = () => ({
  id: Date.now().toString(),
  question: 'What is the capital of France?',
  rows: 2, cols: 2,
  selectionType: 'single',
  dwellTimeMs: 2000,
  maximizeSpacing: false,
  qReadEnabled: false,
  qReadTimeMs: 1000,
  answers: [
    { id: '1', text: 'London' }, { id: '2', text: 'Berlin' },
    { id: '3', text: 'Paris' }, { id: '4', text: 'Madrid' }
  ],
  correctAnswerIds: ['3']
});

const CATEGORIES = ['Activity', 'Feelings', 'Things', 'English', 'Chinese', 'Math', 'Science', 'TBC'];
let appData = {
  dwellTimeMs: 2000,
  peppaSpeed: 0.4,
  peppaHazardsFreq: 'medium',
  peppaBusMoveSpeed: 'fast',
  selectedCategory: 'Activity',
  categories: { 'Activity': [initData()] }
};
// Initialize other categories
CATEGORIES.forEach(cat => {
  if (!appData.categories[cat]) appData.categories[cat] = [];
});
let user = null;
let pendingPassword = null;
let isInitialLoadComplete = false;
let isEditMode = false;

async function loadDataFromFirestore() {
  if (!user) return;
  // Proper guest check: handle both manual guest object and Firebase anonymous auth
  const isGuestAccount = user.isGuest || user.isAnonymous || user.email === 'guest@edugaze.com';

  if (isGuestAccount) {
    console.log("Loading guest data from LocalStorage...");
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      appData = JSON.parse(stored);
    }
    isInitialLoadComplete = true;
    return;
  }
  try {
    console.log("Attempting to load data from Firestore for user:", user.uid);
    const docRef = doc(db, "configs", user.uid);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      console.log("Data loaded from Firestore successfully.");
      const cloudData = docSnap.data();
      if (!cloudData.categories) cloudData.categories = {};

      // Migration from legacy single list
      if (cloudData.questions && Object.keys(cloudData.categories).length === 0) {
        const oldQuestions = cloudData.questions;
        cloudData.categories = { 'Activity': oldQuestions };
        CATEGORIES.forEach(cat => {
          if (!cloudData.categories[cat]) cloudData.categories[cat] = [];
        });
        cloudData.selectedCategory = 'Activity';
        delete cloudData.questions;
      }

      // Ensure all categories exist and questions are valid
      CATEGORIES.forEach(cat => {
        if (!cloudData.categories[cat]) cloudData.categories[cat] = [];

        // Ensure all questions have dwellTimeMs
        const globalDwell = cloudData.dwellTimeMs || 2000;
        if (Array.isArray(cloudData.categories[cat])) {
          cloudData.categories[cat].forEach(q => {
            if (q.dwellTimeMs === undefined) q.dwellTimeMs = globalDwell;
          });
        }
      });

      appData = cloudData;
      isInitialLoadComplete = true;
    } else {
      console.log("No data found in Firestore. Migrating from local storage or using defaults.");
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const localData = JSON.parse(stored);
        // Migration if needed
        if (localData.questions && !localData.categories) {
          localData.categories = { 'Activity': localData.questions };
          CATEGORIES.forEach(cat => { if (!localData.categories[cat]) localData.categories[cat] = []; });
          localData.selectedCategory = 'Activity';
          delete localData.questions;
        }
        appData = localData;
      } else {
        appData = {
          dwellTimeMs: 2000,
          selectedCategory: 'Activity',
          categories: { 'Activity': [initData()] }
        };
        CATEGORIES.forEach(cat => { if (!appData.categories[cat]) appData.categories[cat] = []; });
      }
      isInitialLoadComplete = true; // Set flag BEFORE saving defaults
      await saveDataToFirestore();
    }
  } catch (error) {
    console.error("Error loading data from Firestore:", error);
    // Even if error, allow editing with what we have
    isInitialLoadComplete = true;
  }
}

let saveTimer = null;
async function saveDataToFirestore() {
  if (!user || !isInitialLoadComplete) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
  if (user.uid === 'guest-local') return; // Don't try to save to Firestore with dummy UID

  try {
    console.log("Saving data to Firestore for user:", user.uid);
    const docRef = doc(db, "configs", user.uid);
    await setDoc(docRef, appData);
    console.log("Data saved successfully.");
  } catch (error) {
    console.error("Error saving data to Firestore:", error);
  }
}

// Proxy with debounce for original saveData
function saveData() {
  if (!isInitialLoadComplete) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveDataToFirestore();
  }, 500);
}

let currentQuestionIndex = 0;
const getActiveQ = () => {
  const list = appData.categories[appData.selectedCategory || 'Activity'];
  if (currentQuestionIndex >= list.length) currentQuestionIndex = Math.max(0, list.length - 1);
  if (list.length === 0) return null;

  const q = list[currentQuestionIndex];
  if (!q.selectionType) q.selectionType = 'single';
  if (!q.correctAnswerIds) {
    q.correctAnswerIds = q.correctAnswerId ? [q.correctAnswerId] : [];
  }
  if (q.qReadEnabled === undefined) q.qReadEnabled = false;
  if (q.qReadTimeMs === undefined) q.qReadTimeMs = 1000;
  return q;
};

const toastContainer = document.getElementById('toast-container');
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = type === 'success'
    ? '<svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>'
    : '<svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>';

  toast.innerHTML = `${icon} <span class="text-sm font-medium">${message}</span>`;
  toastContainer.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('show'));

  // Remove after duration
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

let mode = 'landing'; // 'landing', 'education', 'edit', 'math-game', 'peppa-game'
let selectedId = null;
let wrongSelectionsCount = {};
let renderGen = 0;

const btnEducation = document.getElementById('btn-education');
const btnEdit = document.getElementById('btn-edit');
const viewLanding = document.getElementById('view-landing');
const viewEducation = document.getElementById('view-education');
const viewEdit = document.getElementById('view-edit');
const viewMathGame = document.getElementById('view-math-game');
const viewPeppaGame = document.getElementById('view-peppa-game');
const viewQuiz = document.getElementById('view-quiz');
const displayQuestion = document.getElementById('display-question');
const answersGrid = document.getElementById('answers-grid');
const categoryTabs = document.getElementById('category-tabs');

const inputQuestion = document.getElementById('input-question');
const inputDwell = document.getElementById('input-dwell');
const inputLayout = document.getElementById('input-layout');
const inputSelectionType = document.getElementById('input-selection-type');
const editAnswersContainer = document.getElementById('edit-answers-container');
const inputDwellSlider = document.getElementById('input-dwell-slider');
const btnApplyAllDwell = document.getElementById('btn-apply-all-dwell');
const inputMaxSpacing = document.getElementById('input-max-spacing');
const inputQReadEnabled = document.getElementById('input-qread-enabled');
const inputQRead = document.getElementById('input-qread');
const inputQReadSlider = document.getElementById('input-qread-slider');
const btnApplyAllQRead = document.getElementById('btn-apply-all-qread');
const qreadControls = document.getElementById('qread-controls');

const btnPrevEdu = document.getElementById('btn-prev-edu');
const btnNextEdu = document.getElementById('btn-next-edu');
const btnPrevEdit = document.getElementById('btn-prev-edit');
const btnNextEdit = document.getElementById('btn-next-edit');
const displayQCount = document.getElementById('display-q-count');
const btnAddQ = document.getElementById('btn-add-q');
const btnDeleteQ = document.getElementById('btn-delete-q');
const loginOverlay = document.getElementById('login-overlay');
const btnLogin = document.getElementById('btn-login');
const btnGuest = document.getElementById('btn-guest');
const emailField = document.getElementById('email-field');
const passwordField = document.getElementById('password-field');
const btnEmailSignin = document.getElementById('btn-email-signin');
const btnEmailRegister = document.getElementById('btn-email-register');

const btnLogout = document.getElementById('btn-logout');
btnLogout.onclick = async () => {
  if (user && !user.isGuest) {
    await signOut(auth);
  }
  // Reset local state regardless of Guest or Google
  user = null;
  appData = { dwellTimeMs: 2000, selectedCategory: 'Activity', categories: { 'Activity': [initData()] } };
  CATEGORIES.forEach(cat => { if (!appData.categories[cat]) appData.categories[cat] = []; });
  currentQuestionIndex = 0;
  isInitialLoadComplete = false;
  setMode('education');
  displayUser.textContent = "Guest";
  loginOverlay.classList.remove('hidden');
  setTimeout(() => loginOverlay.classList.remove('opacity-0'), 10);
  showToast("Logged out successfully.");
};

btnGuest.onclick = async () => {
  try {
    btnGuest.disabled = true;
    btnGuest.textContent = "Connecting...";
    await signInAnonymously(auth);
    // onAuthStateChanged handles UI but we'll force defensive state check
    setTimeout(() => {
      if (loginOverlay && !loginOverlay.classList.contains('hidden')) {
        handleAuthStateChanged({ isAnonymous: true, isGuest: true, uid: 'guest-local', displayName: 'Guest' });
      }
    }, 3000);
  } catch (err) {
    console.warn("Guest login failed (Anonymous Auth likely disabled in Console):", err);
    showToast("Cloud sync disabled for guest. Using local storage.", "info");
    handleAuthStateChanged({ isAnonymous: true, isGuest: true, uid: 'guest-local', displayName: 'Guest' });
  } finally {
    btnGuest.disabled = false;
    btnGuest.textContent = "Continue as Guest";
  }
};

// Auth events
btnLogin.onclick = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const currentUser = result.user;

    if (pendingPassword && currentUser) {
      try {
        const credential = EmailAuthProvider.credential(currentUser.email, pendingPassword);
        await linkWithCredential(currentUser, credential);
        showToast("Alternate login successfully linked!", "success");
        pendingPassword = null;
      } catch (linkErr) {
        console.error("Linking failed", linkErr);
        if (linkErr.code === 'auth/credential-already-in-use') {
          // This means the password was already set up correctly, proceed.
          pendingPassword = null;
        } else {
          showToast("Failed to link password: " + linkErr.message, "error");
        }
      }
    }
  } catch (err) {
    console.error("Login failed", err);
    showToast("Login failed: " + err.message, "error");
  }
};

btnEmailSignin.onclick = async () => {
  const email = emailField.value;
  const password = passwordField.value;
  if (!email || !password) {
    showToast("Please enter email and password.", "error");
    return;
  }
  try {
    btnEmailSignin.disabled = true;
    btnEmailSignin.textContent = "Signing in...";
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error("Login failed", err);
    if (err.code === 'auth/account-exists-with-different-credential') {
      pendingPassword = password;
      showToast("This email is linked to Google. Please sign in with Google now to set a password for this account.", "info");
      btnLogin.classList.add('animate-pulse', 'ring-4', 'ring-blue-500/50');
      setTimeout(() => btnLogin.classList.remove('animate-pulse', 'ring-4', 'ring-blue-500/50'), 6000);
    } else {
      showToast("Login failed: " + err.message, "error");
    }
  } finally {
    btnEmailSignin.disabled = false;
    btnEmailSignin.textContent = "Sign In";
  }
};

btnEmailRegister.onclick = async () => {
  const email = emailField.value;
  const password = passwordField.value;
  if (!email || !password) {
    showToast("Please enter email and password.", "error");
    return;
  }
  try {
    btnEmailRegister.disabled = true;
    btnEmailRegister.textContent = "Registering...";
    await createUserWithEmailAndPassword(auth, email, password);
    showToast("Account created successfully!");
  } catch (err) {
    console.error("Registration failed", err);
    if (err.code === 'auth/email-already-in-use') {
      // In some Firebase configs, account-exists-with-different-credential is thrown as email-already-in-use
      pendingPassword = password;
      showToast("This email is already in use. If it's your Google account, sign in with Google to link your password.", "info");
      btnLogin.classList.add('animate-pulse', 'ring-4', 'ring-blue-500/50');
      setTimeout(() => btnLogin.classList.remove('animate-pulse', 'ring-4', 'ring-blue-500/50'), 6000);
    } else {
      showToast("Registration failed: " + err.message, "error");
    }
  } finally {
    btnEmailRegister.disabled = false;
    btnEmailRegister.textContent = "Register";
  }
};

const displayUser = document.getElementById('display-user');
onAuthStateChanged(auth, handleAuthStateChanged);

// Profile Management Logic
const profileOverlay = document.getElementById('profile-overlay');
const profileEmailDisplay = document.getElementById('profile-email-display');
const profilePasswordForm = document.getElementById('profile-password-form');
const profileGoogleMsg = document.getElementById('profile-google-msg');
const btnCloseProfile = document.getElementById('btn-close-profile');
const btnSavePassword = document.getElementById('btn-save-password');

function showProfile() {
  if (!user || user.isAnonymous) return;
  profileEmailDisplay.textContent = user.email;

  // Check if user has password provider
  const hasPassword = user.providerData.some(p => p.providerId === 'password');
  if (hasPassword) {
    profilePasswordForm.classList.remove('hidden');
    profileGoogleMsg.classList.add('hidden');
  } else {
    profilePasswordForm.classList.add('hidden');
    profileGoogleMsg.classList.remove('hidden');
  }

  profileOverlay.classList.remove('hidden');
  setTimeout(() => {
    profileOverlay.classList.remove('opacity-0');
    profileOverlay.firstElementChild.classList.remove('scale-95');
  }, 10);
}

function hideProfile() {
  profileOverlay.classList.add('opacity-0');
  profileOverlay.firstElementChild.classList.add('scale-95');
  setTimeout(() => profileOverlay.classList.add('hidden'), 300);
  // Clear fields
  document.getElementById('input-profile-old-pass').value = '';
  document.getElementById('input-profile-new-pass').value = '';
  document.getElementById('input-profile-confirm-pass').value = '';
}

displayUser.onclick = () => {
  if (isEditMode) showProfile();
};
btnCloseProfile.onclick = hideProfile;

btnSavePassword.onclick = async () => {
  const oldPass = document.getElementById('input-profile-old-pass').value;
  const newPass = document.getElementById('input-profile-new-pass').value;
  const confirmPass = document.getElementById('input-profile-confirm-pass').value;

  if (!oldPass || !newPass || !confirmPass) {
    showToast("All fields are required.", "error");
    return;
  }
  if (newPass !== confirmPass) {
    showToast("Passwords do not match.", "error");
    return;
  }
  if (newPass.length < 6) {
    showToast("New password must be at least 6 characters.", "error");
    return;
  }

  try {
    btnSavePassword.disabled = true;
    btnSavePassword.textContent = "Updating...";

    // Re-authenticate
    const credential = EmailAuthProvider.credential(user.email, oldPass);
    await reauthenticateWithCredential(user, credential);

    // Update password
    await updatePassword(user, newPass);

    showToast("Password updated successfully!", "success");
    hideProfile();
  } catch (err) {
    console.error("Password update failed", err);
    showToast("Update failed: " + err.message, "error");
  } finally {
    btnSavePassword.disabled = false;
    btnSavePassword.textContent = "Update Password";
  }
};

async function handleAuthStateChanged(u) {
  user = u;
  if (user) {
    // Hide overlay INSTANTLY and DEFINITIVELY
    loginOverlay.classList.add('hidden', 'opacity-0', 'pointer-events-none');
    console.log("Auth state change: User detected.", user.isAnonymous ? "Anonymous" : (user.email || "User"));

    const isGuest = user.isAnonymous || user.isGuest;
    displayUser.textContent = isGuest ? 'Guest' : (user.email || 'User');
    btnLogout.classList.remove('hidden');

    if (!isGuest) {
      displayUser.classList.add('hover:text-blue-400', 'cursor-pointer', 'transition-colors');
      if (isEditMode) {
        displayUser.classList.add('underline', 'decoration-blue-500/30', 'underline-offset-4');
      }
    } else {
      displayUser.classList.remove('hover:text-blue-400', 'cursor-pointer', 'underline', 'decoration-blue-500/30', 'underline-offset-4');
    }

    // Trigger initial load and render if not already complete
    if (!isInitialLoadComplete) {
      // Let the background UI render defaults first so it doesn't look like it's "hanging"
      if (mode === 'education') renderEducationBoard();
      else if (mode === 'edit') renderEditBoard();
      else setMode('landing'); // Default to landing hub

      // Now load cloud data in the background (if not local-only guest)
      if (user.uid !== 'guest-local') {
        await loadDataFromFirestore();
      } else {
        // For local guest, just load from localStorage
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) appData = JSON.parse(stored);
        isInitialLoadComplete = true;
      }

      // Refresh UI with loaded data
      if (mode === 'education') renderEducationBoard();
      else if (mode === 'edit') renderEditBoard();
      else setMode('landing');
    } else {
      // Already initialized, but auth changed (e.g. login/out)
      if (user.uid !== 'guest-local') {
        await loadDataFromFirestore();
      }
      if (mode === 'education') renderEducationBoard();
      else renderEditBoard();
    }
  } else {
    // User is null - clear app state and show login
    user = null;
    displayUser.textContent = "Guest";
    btnLogout.classList.add('hidden');
    loginOverlay.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
    setTimeout(() => loginOverlay.classList.remove('opacity-0'), 10);

    // Clear education board
    if (isInitialLoadComplete) {
      appData = { dwellTimeMs: 2000, selectedCategory: 'Activity', categories: { 'Activity': [initData()] } };
      CATEGORIES.forEach(cat => { if (!appData.categories[cat]) appData.categories[cat] = []; });
      currentQuestionIndex = 0;
      isInitialLoadComplete = false;
      renderEducationBoard();
    }
  }
}

function playSuccessSound() {
  if (peppaMuted) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
    osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
    osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2); // G5
    osc.frequency.setValueAtTime(1046.50, ctx.currentTime + 0.3); // C6

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.05);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (err) { }
}
window.playSuccessSound = playSuccessSound;

function playJoySound() {
  if (peppaMuted) return;
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    // High-pitched "bouncy" joy sound (ascending slides)
    const playSlide = (startTime, startFreq, endFreq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(startFreq, startTime);
      osc.frequency.exponentialRampToValueAtTime(endFreq, startTime + 0.1);

      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.2, startTime + 0.02);
      gain.gain.linearRampToValueAtTime(0, startTime + 0.1);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.1);
    };

    playSlide(ctx.currentTime, 440, 880); // A4 to A5
    playSlide(ctx.currentTime + 0.1, 660, 1320); // E5 to E6
  } catch (err) { }
}
window.playJoySound = playJoySound;

let _sharedAudioCtx = null;
function _getAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!_sharedAudioCtx || _sharedAudioCtx.state === 'closed') {
    _sharedAudioCtx = new AC();
  }
  return _sharedAudioCtx;
}
// Warm up AudioContext on first user gesture so hover-triggered sounds work on macOS
const _warmUpAudio = () => {
  const ctx = _getAudioCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume();
  document.removeEventListener('click', _warmUpAudio);
  document.removeEventListener('touchstart', _warmUpAudio);
};
document.addEventListener('click', _warmUpAudio);
document.addEventListener('touchstart', _warmUpAudio);

function playWrongSound() {
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    // macOS Safari/Chrome: AudioContext starts suspended, must resume on user gesture
    if (ctx.state === 'suspended') ctx.resume();

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(120, ctx.currentTime);

    osc2.type = 'square';
    osc2.frequency.setValueAtTime(126, ctx.currentTime);

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(ctx.currentTime);
    osc2.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.3);
    osc2.stop(ctx.currentTime + 0.3);
  } catch (e) {
    console.error("Audio playback error", e);
  }
}

function playHintSound() {
  try {
    const audio = new Audio('assets/bh/fairy_wow.mp3');
    audio.volume = 0.4;
    audio.play().catch(() => { });
  } catch (e) { }
}

function triggerQuizHint() {
  const card = window._currentCorrectCard;
  if (!card || card.querySelector('.quiz-hint-character')) return;

  const char = document.createElement('img');
  const idx = Math.floor(Math.random() * 10) + 1;
  char.src = `assets/peppa/friend${idx}.png`;
  // Updated: w-28 h-28 and bottom-4 right-[12%] to be larger and closer to middle
  char.className = 'quiz-hint-character absolute bottom-4 right-[12%] w-28 h-28 z-20 object-contain pointer-events-none transform scale-0 transition-all duration-500';
  char.style.maxWidth = '35%';
  char.style.maxHeight = '50%';

  card.appendChild(char);
  // Trigger pop-in animation
  setTimeout(() => {
    char.style.transform = 'scale(1) rotate(-5deg)';
  }, 50);

  playHintSound();
}

// showQuizHint: public entry point called when wrong-attempt threshold is reached.
// Works for both text-only and image answer cards.
function showQuizHint(q) {
  // Threshold 11 means 'Never' in settings
  if (!quizSettings.hintThreshold || quizSettings.hintThreshold >= 11) return;
  triggerQuizHint();
}

function resizeImageFileToDataURL(file, maxSize = 400) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = (h / w) * maxSize; w = maxSize; }
          else { w = (w / h) * maxSize; h = maxSize; }
        }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.setMode = (newMode) => {
  if (typeof window.mode === 'undefined') window.mode = newMode;
  window.mode = newMode;

  if (newMode !== 'peppa-game') stopPeppaGame();

  if (newMode === 'landing') setLandingMode();
  else if (newMode === 'education') setEducationMode();
  else if (newMode === 'edit') setEditMode();
  else if (newMode === 'math-game') setMathGameMode();
  else if (newMode === 'peppa-game') setPeppaGameMode();
  else if (newMode === 'quiz') setQuizMode();
};

function setLandingMode() {
  mode = 'landing';
  isEditMode = false;
  document.body.classList.remove('quiz-active', 'education-active');
  viewLanding.classList.remove('hidden');
  viewEducation.classList.add('hidden');
  viewEdit.classList.add('hidden');
  viewMathGame.classList.add('hidden');
  viewPeppaGame.classList.add('hidden');
  if (viewQuiz) viewQuiz.classList.add('hidden');
  restoreHeaderFromQuizMode();
  btnEducation.classList.replace('bg-blue-600', 'bg-slate-800');
  btnEdit.classList.replace('bg-blue-600', 'bg-slate-800');
  categoryTabs.classList.add('hidden');
  btnLogout.classList.remove('hidden');
  stopQuizMusic();
}

function setEducationMode() {
  mode = 'education';
  isEditMode = false;
  document.body.classList.add('education-active');
  document.body.classList.remove('quiz-active');
  viewLanding.classList.add('hidden');
  viewEducation.classList.remove('hidden');
  viewEdit.classList.add('hidden');
  viewMathGame.classList.add('hidden');
  viewPeppaGame.classList.add('hidden');
  if (viewQuiz) viewQuiz.classList.add('hidden');
  restoreHeaderFromQuizMode();
  btnEdit.classList.replace('bg-blue-600', 'bg-slate-800');
  btnEdit.classList.replace('text-white', 'text-slate-400');
  btnEducation.classList.replace('bg-slate-800', 'bg-blue-600');
  btnEducation.classList.add('text-white');
  categoryTabs.classList.remove('hidden');
  displayUser.classList.remove('underline', 'decoration-blue-500/30', 'underline-offset-4');
  btnLogout.classList.add('hidden');
  stopQuizMusic();
  renderEducationBoard();
}

function setEditMode() {
  mode = 'edit';
  isEditMode = true;
  document.body.classList.remove('quiz-active', 'education-active');
  viewLanding.classList.add('hidden');
  viewEducation.classList.add('hidden');
  viewEdit.classList.remove('hidden');
  viewMathGame.classList.add('hidden');
  viewPeppaGame.classList.add('hidden');
  if (viewQuiz) viewQuiz.classList.add('hidden');
  restoreHeaderFromQuizMode();
  btnEducation.classList.replace('bg-blue-600', 'bg-slate-800');
  btnEducation.classList.replace('text-white', 'text-slate-400');
  btnEdit.classList.replace('bg-slate-800', 'bg-blue-600');
  btnEdit.classList.add('text-white');
  categoryTabs.classList.remove('hidden');
  btnLogout.classList.remove('hidden');
  stopQuizMusic();
  if (user) {
    displayUser.classList.add('underline', 'decoration-blue-500/30', 'underline-offset-4');
  }
  renderEditBoard();
}

function setMathGameMode() {
  mode = 'math-game';
  isEditMode = false;
  viewLanding.classList.add('hidden');
  viewEducation.classList.add('hidden');
  viewEdit.classList.add('hidden');
  viewMathGame.classList.remove('hidden');
  viewPeppaGame.classList.add('hidden');
  if (viewQuiz) viewQuiz.classList.add('hidden');
  restoreHeaderFromQuizMode();
  categoryTabs.classList.add('hidden');
  stopQuizMusic();
  initMathGame();
}

let mathScore = 0;
let mathProblem = null;
let mathIntervals = [];

function generateMathProblem() {
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const op = Math.random() > 0.5 ? '+' : '-';
  let result = op === '+' ? a + b : a - b;
  // Avoid negative for now
  if (result < 0) result = a + b;

  mathProblem = { a, b, op, result };
  document.getElementById('math-problem-display').textContent = `${a} ${op === '+' ? '+' : '-'} ${b} = ?`;
}

function spawnMathBubble() {
  const layer = document.getElementById('math-bubbles-layer');
  if (!layer) return;

  const bubble = document.createElement('div');
  bubble.className = 'math-bubble';

  const isCorrect = Math.random() > 0.6;
  const val = isCorrect ? mathProblem.result : (mathProblem.result + Math.floor(Math.random() * 5) + 1 - 2);

  bubble.textContent = val;
  bubble.style.left = (Math.random() * 80 + 10) + '%';
  bubble.style.top = '-150px';

  layer.appendChild(bubble);

  let top = -150;
  const speed = 2 + Math.random() * 2;
  const moveInt = setInterval(() => {
    if (mode !== 'math-game') {
      clearInterval(moveInt);
      return;
    }
    top += speed;
    bubble.style.top = top + 'px';

    if (top > 700) {
      clearInterval(moveInt);
      bubble.remove();
    }
  }, 30);

  bubble.onclick = () => {
    if (val === mathProblem.result) {
      mathScore += 10;
      document.getElementById('math-score').textContent = mathScore;
      playSuccessSound();
      bubble.style.background = '#10b981'; // emerald
      bubble.style.borderColor = '#059669';
      generateMathProblem();
    } else {
      mathScore = Math.max(0, mathScore - 5);
      document.getElementById('math-score').textContent = mathScore;
      playWrongSound();
      bubble.style.background = '#ef4444'; // red
    }
    setTimeout(() => bubble.remove(), 200);
  };
  mathIntervals.push(moveInt);
}

function initMathGame() {
  mathScore = 0;
  document.getElementById('math-score').textContent = '0';
  mathIntervals.forEach(clearInterval);
  mathIntervals = [];
  document.getElementById('math-bubbles-layer').innerHTML = '';
  generateMathProblem();

  const spawnInt = setInterval(() => {
    if (mode === 'math-game') spawnMathBubble();
  }, 2000);
  mathIntervals.push(spawnInt);
}

let peppaScore = 0;
let peppaIntervals = [];
let busLane = 1;
let peppaMuted = false;
let peppaPaused = false;
let peppaAudio = null;
let peppaCollectedFriends = []; // Indices of friends collected in current trip
let peppaAnimationFrame = null; // Handle for requestAnimationFrame loop
let peppaLoopGen = 0;           // Incremented on each game start; stale RAF loops self-terminate
// Module-level RAF state (promoted from setPeppaGameMode to avoid stale closures)
let peppaRoadX = 0;
let peppaSkylineX = 0;
let peppaLastTime = 0;
// Merge peppa defaults into existing appData (declared earlier)
if (!appData.peppaSpeed) appData.peppaSpeed = 0.8;
if (!appData.peppaMusicStyle) appData.peppaMusicStyle = 'instrumental';
if (!appData.peppaBusMoveSpeed) appData.peppaBusMoveSpeed = 'normal';
if (!appData.peppaCharFreq) appData.peppaCharFreq = 'medium';
if (!appData.peppaTargetCount) appData.peppaTargetCount = 12;
let peppaBusX = window.innerWidth * 0.45; // Starting position: midpoint of 25%-60%
let targetMouseX = window.innerWidth * 0.45;

function startPeppaTheme() {
  if (peppaAudio) {
    peppaAudio.pause();
    peppaAudio = null;
  }
  const style = appData.peppaMusicStyle || 'vocal';
  const src = style === 'instrumental' ? 'assets/peppa/theme_nolyrics.mp3' : 'assets/peppa/thememusic.mp3';
  peppaAudio = new Audio(src);
  peppaAudio.loop = true;
  peppaAudio.muted = peppaMuted;
  peppaAudio.play().catch(e => console.log("Audio play deferred", e));
}

function stopPeppaTheme() {
  if (peppaAudio) {
    peppaAudio.pause();
    peppaAudio.currentTime = 0;
  }
}

window.updatePeppaScoreUI = () => {
  const scoreEl = document.getElementById('peppa-score');
  const targetEl = document.getElementById('peppa-target-display');
  if (scoreEl) scoreEl.textContent = peppaScore;
  if (targetEl) targetEl.textContent = `/ ${appData.peppaTargetCount || 12}`;
};
window.togglePeppaMute = () => {
  peppaMuted = !peppaMuted;
  if (peppaAudio) peppaAudio.muted = peppaMuted;
  document.getElementById('icon-mute-on').classList.toggle('hidden', !peppaMuted);
  document.getElementById('icon-mute-off').classList.toggle('hidden', peppaMuted);
};

window.togglePeppaPause = () => {
  peppaPaused = !peppaPaused;
  const viewport = document.getElementById('peppa-game-viewport');
  if (viewport) {
    viewport.classList.toggle('peppa-game-paused', peppaPaused);
  }
  document.getElementById('icon-pause').classList.toggle('hidden', peppaPaused);
  document.getElementById('icon-play').classList.toggle('hidden', !peppaPaused);

  if (peppaAudio) {
    if (peppaPaused) peppaAudio.pause();
    else peppaAudio.play().catch(e => console.log("Audio resume deferred", e));
  }
};

window.triggerBusAnimation = (className, duration) => {
  const bus = document.getElementById('peppa-bus');
  if (!bus) return;
  // Clear any existing animation classes
  bus.classList.remove('animate-bus-jump', 'animate-bus-shake', 'animate-bus-slide');
  void bus.offsetWidth; // Force reflow
  bus.classList.add(className);
  setTimeout(() => {
    bus.classList.remove(className);
  }, duration);
};

window.setBusLane = (lane) => {
  if (busLane === lane) return;
  busLane = lane;
  const bus = document.getElementById('peppa-bus');
  if (bus) {
    // Wheels sit just above the bottom edge of each lane
    const laneTops = ['24.6%', '55.7%', '95.9%'];
    bus.style.top = laneTops[lane];
    bus.style.zIndex = 50 + lane;
  }
};

window.setPeppaMusicStyle = (style) => {
  appData.peppaMusicStyle = style;
  document.querySelectorAll('.music-style-btn').forEach(btn => {
    btn.classList.remove('border-orange-500', 'text-orange-500');
    btn.classList.add('border-slate-700', 'text-slate-400');
  });
  const activeBtn = document.getElementById(`btn-music-${style}`);
  if (activeBtn) {
    activeBtn.classList.add('border-orange-500', 'text-orange-500');
    activeBtn.classList.remove('border-slate-700', 'text-slate-400');
  }
  if (mode === 'peppa-game') startPeppaTheme();
};

function getBusMoveSpeedMultiplier() {
  const speeds = { 'very-slow': 1, 'slow': 2, 'normal': 4, 'fast': 8, 'very-fast': 14 };
  return speeds[appData.peppaBusMoveSpeed] || 4;
}

function getCharSpawnInterval() {
  const intervals = { 'low': 4000, 'medium': 2000, 'high': 1000 };
  return intervals[appData.peppaCharFreq] || 2000;
}

function highlightSettingBtn(groupClass, activeId) {
  document.querySelectorAll('.' + groupClass).forEach(btn => {
    btn.classList.remove('border-orange-500', 'text-orange-500');
    btn.classList.add('border-slate-700', 'text-slate-400');
  });
  const active = document.getElementById(activeId);
  if (active) {
    active.classList.add('border-orange-500', 'text-orange-500');
    active.classList.remove('border-slate-700', 'text-slate-400');
  }
}

window.setPeppaBusMoveSpeed = (speed) => {
  appData.peppaBusMoveSpeed = speed;
  highlightSettingBtn('bus-speed-btn', 'btn-bus-speed-' + speed);
};

window.setPeppaCharFreq = (freq) => {
  appData.peppaCharFreq = freq;
  highlightSettingBtn('char-freq-btn', 'btn-char-freq-' + freq);
};

window.setPeppaHazards = (freq) => {
  appData.peppaHazardsFreq = freq;
  highlightSettingBtn('hazard-btn', 'btn-hazard-' + freq);
};

function getHazardSpawnInterval() {
  const intervals = { 'low': 6000, 'medium': 4000, 'high': 2000 };
  return intervals[appData.peppaHazardsFreq] || 4000;
}

function spawnPeppaHazard() {
  if (appData.peppaHazardsFreq === 'none') return;
  const layer = document.getElementById('peppa-friends-layer'); // Repurpose this layer for road-aligned items
  if (!layer) return;

  const hazard = document.createElement('div');
  const lane = Math.floor(Math.random() * 3);
  const types = ['banana', 'mud', 'water'];
  const type = types[Math.floor(Math.random() * types.length)];
  hazard.className = `peppa-hazard ${type}`;

  const laneTops = ['17.9%', '49.0%', '89.2%'];
  hazard.style.right = '-200px';
  hazard.style.top = laneTops[lane];

  layer.appendChild(hazard);

  let pos = -200;
  let triggered = false;
  let lastTime = performance.now();

  function move(time) {
    if (mode !== 'peppa-game' || triggered || peppaPaused) {
      if (peppaPaused) {
        lastTime = time; // Reset timer so no jump on resume
        requestAnimationFrame(move);
      }
      return;
    }
    const dt = (time - lastTime) / 1000;
    lastTime = time;
    pos += 750 * appData.peppaSpeed * dt;
    hazard.style.right = pos + 'px';

    // Collision Check
    if (lane === busLane) {
      const bus = document.getElementById('peppa-bus');
      if (bus) {
        const bRect = bus.getBoundingClientRect();
        const hRect = hazard.getBoundingClientRect();
        if (hRect.left < bRect.right - 100 && hRect.right > bRect.left + 60) {
          triggered = true;
          peppaScore = Math.max(0, peppaScore - 1);
          window.updatePeppaScoreUI();
          handleHazardCollision(type);

          hazard.style.opacity = '0';
          setTimeout(() => hazard.remove(), 500);
          return;
        }
      }
    }

    if (pos < 4000) requestAnimationFrame(move);
    else hazard.remove();
  }
  requestAnimationFrame(move);
}

function handleHazardCollision(type) {
  const bus = document.getElementById('peppa-bus');
  const mudContainer = document.getElementById('peppa-mud-splash-container');
  if (!bus) return;

  // --- 1. Audio Setup ---
  let soundFile = 'assets/peppa/splash.mp3';
  if (type === 'banana') soundFile = 'assets/peppa/bananapeel.mp3';

  const audio = new Audio(soundFile);
  if (!peppaMuted) {
    audio.currentTime = 0;
    audio.play().catch(e => console.log("Audio play failed:", e));
  }

  // --- 2. Shared Physical Feedback (Shake & Slowdown) ---
  const originalSpeed = appData.peppaSpeed;
  appData.peppaSpeed = originalSpeed * 0.35; // Significant slow down
  updatePeppaSpeedFactor();

  window.triggerBusAnimation('animate-bus-shake', 1200);

  // Restore speed after brief period
  setTimeout(() => {
    appData.peppaSpeed = originalSpeed;
    updatePeppaSpeedFactor();
  }, 2000);

  // --- 3. Specific Visual Feedback ---
  if (type === 'banana') {
    // Slide animation (Extra feedback for banana)
    window.triggerBusAnimation('animate-bus-slide', 600);
  } else {
    // Splash Visuals (Mud or Water)
    const isWater = (type === 'water');
    const particleClass = isWater ? 'water-particle' : 'mud-particle';
    const splatClass = isWater ? 'water-edge-splat' : 'mud-edge-splat';

    // A. Particles at Bus
    const busRect = bus.getBoundingClientRect();
    for (let i = 0; i < 10; i++) {
      const p = document.createElement('div');
      p.className = particleClass;
      p.style.left = (busRect.left + busRect.width / 2) + 'px';
      p.style.top = (busRect.top + busRect.height / 2) + 'px';
      p.style.setProperty('--tx', `${(Math.random() - 0.5) * 400}px`);
      p.style.setProperty('--ty', `${-Math.random() * 250}px`);
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 600);
    }

    // B. Screen Edge Splash
    if (mudContainer) {
      const locations = [
        { top: '5%', left: '5%' }, { top: '5%', right: '5%' },
        { bottom: '15%', left: '2%' }, { bottom: '10%', right: '8%' },
        { top: '40%', left: '-5%' }, { top: '35%', right: '-8%' }
      ];
      locations.forEach(loc => {
        const splat = document.createElement('div');
        splat.className = splatClass;
        Object.assign(splat.style, loc);
        splat.style.transform = `scale(${0.6 + Math.random()}) rotate(${Math.random() * 360}deg)`;
        mudContainer.appendChild(splat);
        setTimeout(() => splat.classList.add('show'), 10);
        setTimeout(() => {
          splat.classList.remove('show');
          setTimeout(() => splat.remove(), 1000);
        }, 2000);
      });
    }
  }
}

function updatePeppaSpeedFactor() {
  const speed = appData.peppaSpeed || 0.8;
  document.documentElement.style.setProperty('--peppa-speed-factor', speed);
  const display = document.getElementById('speed-value-display');
  if (display) display.textContent = speed.toFixed(1) + 'x';
  const input = document.getElementById('input-peppa-speed');
  if (input) {
    input.value = speed;
    input.oninput = (e) => {
      appData.peppaSpeed = parseFloat(e.target.value);
      updatePeppaSpeedFactor();
    };
  }
}

function updatePeppaSettingsUIv2() {
  updatePeppaSpeedFactor();
  const goalVal = document.getElementById('goal-value-display');
  const goalInput = document.getElementById('input-peppa-goal');
  if (goalVal) goalVal.textContent = appData.peppaTargetCount || 12;
  if (goalInput) {
    goalInput.value = appData.peppaTargetCount || 12;
    goalInput.oninput = (e) => {
      appData.peppaTargetCount = parseInt(e.target.value);
      if (goalVal) goalVal.textContent = appData.peppaTargetCount;
      window.updatePeppaScoreUI();
    };
  }
}

window.togglePeppaSettings = () => {
  const overlay = document.getElementById('peppa-settings-overlay');
  if (!overlay) return;
  const isShowing = overlay.classList.contains('show');
  if (!isShowing) {
    overlay.classList.add('show');
    updatePeppaSpeedFactor();
    updatePeppaSettingsUIv2();
    window.setPeppaMusicStyle(appData.peppaMusicStyle || 'instrumental');
    window.setPeppaBusMoveSpeed(appData.peppaBusMoveSpeed || 'fast');
    window.setPeppaCharFreq(appData.peppaCharFreq || 'medium');
    window.setPeppaHazards(appData.peppaHazardsFreq || 'medium');
  } else {
    overlay.classList.remove('show');
    saveData();
  }
};

// Module-level reference so stopPeppaGame can always clean up the win listener
let _peppaWinOverlayHandler = null;

function stopPeppaGame() {
  peppaIntervals.forEach(val => {
    if (typeof val === 'number') {
      clearInterval(val);
      clearTimeout(val);
    }
  });
  peppaIntervals = [];
  if (peppaAnimationFrame) {
    cancelAnimationFrame(peppaAnimationFrame);
    peppaAnimationFrame = null;
  }
  peppaPaused = false;
  const viewport = document.getElementById('peppa-game-viewport');
  if (viewport) viewport.classList.remove('peppa-game-paused');
  const btnPause = document.getElementById('btn-peppa-pause');
  if (btnPause) btnPause.classList.add('hidden');
  stopPeppaTheme();
  const layer = document.getElementById('peppa-friends-layer');
  if (layer) layer.innerHTML = '';
  const victoryLayer = document.getElementById('peppa-victory-layer');
  if (victoryLayer) victoryLayer.innerHTML = '';
  document.removeEventListener('mousemove', peppaMouseMove);
  // Always remove the win-overlay key/click listener to prevent ghost keystrokes
  if (_peppaWinOverlayHandler) {
    document.removeEventListener('keydown', _peppaWinOverlayHandler);
    document.removeEventListener('click', _peppaWinOverlayHandler);
    _peppaWinOverlayHandler = null;
  }
}

function initPeppaGame() {
  // Production Ready: Standard Asset Paths
}

// Cache lane screen positions (recomputed on resize and game start)
let laneScreenBounds = []; // [{top, bottom}, ...]
function computeLaneScreenBounds() {
  const lanes = document.querySelectorAll('.peppa-lane');
  const viewport = document.getElementById('peppa-game-viewport');
  if (!viewport || lanes.length === 0) return;
  const vpRect = viewport.getBoundingClientRect();
  laneScreenBounds = [];
  lanes.forEach(lane => {
    const r = lane.getBoundingClientRect();
    laneScreenBounds.push({
      top: r.top - vpRect.top,
      bottom: r.bottom - vpRect.top
    });
  });
  // Update hover zone heights to match
  const hz0 = document.getElementById('hover-zone-0');
  const hz1 = document.getElementById('hover-zone-1');
  const hz2 = document.getElementById('hover-zone-2');
  const hz3 = document.getElementById('hover-zone-3');
  if (hz0 && laneScreenBounds.length >= 1) hz0.style.height = laneScreenBounds[0].top + 'px';
  if (hz1 && laneScreenBounds.length >= 1) hz1.style.height = (laneScreenBounds[0].bottom - laneScreenBounds[0].top) + 'px';
  if (hz2 && laneScreenBounds.length >= 2) hz2.style.height = (laneScreenBounds[1].bottom - laneScreenBounds[1].top) + 'px';
  if (hz3 && laneScreenBounds.length >= 3) hz3.style.height = (laneScreenBounds[2].bottom - laneScreenBounds[2].top) + 'px';
}
// Guard: only attach resize listener once to avoid accumulation across restarts
if (!window._peppaResizeListenerAdded) {
  window._peppaResizeListenerAdded = true;
  window.addEventListener('resize', () => { if (mode === 'peppa-game') computeLaneScreenBounds(); });
}

function peppaMouseMove(e) {
  if (mode !== 'peppa-game') return;
  // NOTE: do NOT call requestAnimationFrame(move) here — the module-level RAF loop
  // already runs continuously while the game is active. Doing so would spawn
  // a second (stale-closure) loop that outlives stopPeppaGame and causes ghost keypresses.
  if (peppaPaused) return;
  const viewport = document.getElementById('peppa-game-viewport');
  if (!viewport) return;

  const rect = viewport.getBoundingClientRect();
  const mouseY = e.clientY - rect.top;
  const mouseX = e.clientX;
  targetMouseX = mouseX;

  // Use actual rendered lane positions for detection
  let lane = -1;
  for (let i = 0; i < laneScreenBounds.length; i++) {
    if (mouseY >= laneScreenBounds[i].top && mouseY < laneScreenBounds[i].bottom) {
      lane = i;
      break;
    }
  }

  if (lane >= 0) {
    window.setBusLane(lane);
    document.querySelectorAll('.hover-zone').forEach((zone, idx) => {
      zone.classList.toggle('active', idx === lane);
    });
  } else {
    document.querySelectorAll('.hover-zone').forEach(zone => zone.classList.remove('active'));
  }
}

function spawnPeppaFriend() {
  const friendsLayer = document.getElementById('peppa-friends-layer');
  if (!friendsLayer) return;
  const friend = document.createElement('div');
  const lane = Math.floor(Math.random() * 3);
  // Align base of characters with base of bus (bus laneTops: 24.6%, 55.7%, 95.9%)
  const laneTops = ['5.0%', '36.0%', '74.0%'];

  friend.className = 'peppa-friend';
  const friendIdx = Math.floor(Math.random() * 10) + 1;
  friend.style.backgroundImage = `url('assets/peppa/friend${friendIdx}.png')`;


  friend.style.right = '-300px';
  friend.style.top = laneTops[lane];
  friend.style.zIndex = 40 + lane;

  friendsLayer.appendChild(friend);

  let pos = -300;
  let collected = false;
  let lastTime = performance.now();

  function move(time) {
    if (mode !== 'peppa-game' || collected || peppaPaused) { if (peppaPaused) { lastTime = performance.now(); requestAnimationFrame(move); } return; }

    const dt = (time - lastTime) / 1000;
    lastTime = time;

    // Speed: 750px/s * peppaSpeed
    pos += 750 * appData.peppaSpeed * dt;
    friend.style.right = pos + 'px';

    // Collision Detection
    if (lane === busLane) {
      const bus = document.getElementById('peppa-bus');
      if (bus) {
        const bRect = bus.getBoundingClientRect();
        const fRect = friend.getBoundingClientRect();
        if (fRect.left < bRect.right - 20 && fRect.right > bRect.left + 40) {
          collected = true;
          friend.style.transition = 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
          friend.style.transform = 'rotateX(-45deg) scale(0.1) translate(300px, -600px)';
          friend.style.opacity = '0';
          peppaScore++;
          peppaCollectedFriends.push(friendIdx);
          window.updatePeppaScoreUI();
          if (peppaScore >= (appData.peppaTargetCount || 12)) { setTimeout(() => winPeppaGame(), 500); }
          document.getElementById('peppa-score').textContent = peppaScore;
          window.triggerBusAnimation('animate-bus-jump', 500);
          if (window.playJoySound) window.playJoySound();
          setTimeout(() => friend.remove(), 500);
          return;
        }
      }
    }

    if (pos < 4000) {
      requestAnimationFrame(move);
    } else {
      friend.remove();
    }
  }
  requestAnimationFrame(move);
}

function spawnPeppaDecoration() {
  const layer = document.getElementById('peppa-decorations-layer');
  if (!layer) return;
  const decoration = document.createElement('div');
  const isTree = Math.random() > 0.5;
  decoration.className = `peppa-decoration ${isTree ? 'peppa-tree' : 'peppa-lamp'}`;

  layer.appendChild(decoration);

  let pos = -300;
  decoration.style.right = pos + 'px';
  let lastTime = performance.now();

  function move(time) {
    if (mode !== 'peppa-game' || peppaPaused) { if (peppaPaused) { lastTime = performance.now(); requestAnimationFrame(move); } return; }
    const dt = (time - lastTime) / 1000;
    lastTime = time;

    pos += 750 * appData.peppaSpeed * dt;
    decoration.style.right = pos + 'px';

    if (pos < 3500) {
      requestAnimationFrame(move);
    } else {
      decoration.remove();
    }
  }
  requestAnimationFrame(move);
}

function winPeppaGame() {
  peppaPaused = true;
  if (peppaAudio) peppaAudio.pause();

  // Winning Sound
  const winSound = new Audio('assets/peppa/win.mp3');
  if (!peppaMuted) winSound.play().catch(e => console.log("Win audio play failed", e));

  const bus = document.getElementById('peppa-bus');
  const viewport = document.getElementById('peppa-game-viewport');
  const winOverlay = document.getElementById('peppa-win-overlay');
  const friendsLayer = document.getElementById('peppa-friends-layer');

  if (viewport) viewport.classList.add('peppa-game-paused');
  if (bus) bus.classList.add('victory-hero');

  // Show collected characters in a horizontal line above top lane
  setTimeout(() => {
    const victoryLayer = document.getElementById('peppa-victory-layer');
    if (!victoryLayer) return;
    const friendCount = peppaCollectedFriends.length;
    if (friendCount === 0) return;

    // Evenly space across the screen width with padding
    const padding = 5; // % from each edge
    const totalWidth = 100 - padding * 2;
    const step = friendCount > 1 ? totalWidth / (friendCount - 1) : 0;

    for (let i = 0; i < friendCount; i++) {
      const f = document.createElement('div');
      f.className = 'peppa-celebration-friend';
      const friendIdx = peppaCollectedFriends[i];
      f.style.backgroundImage = `url('assets/peppa/friend${friendIdx}.png')`;

      // Position: above top lane (top ~8%), horizontally spread
      const xPercent = friendCount > 1 ? padding + i * step : 50;
      f.style.left = `${xPercent}%`;
      f.style.top = '8%';
      f.style.transform = 'translateX(-50%) translateY(40px) scale(0)';
      f.style.opacity = '0';
      f.style.transition = `transform 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${i * 100}ms, opacity 0.4s ease ${i * 100}ms`;

      victoryLayer.appendChild(f);

      // Trigger entrance animation
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          f.style.transform = 'translateX(-50%) translateY(0) scale(1)';
          f.style.opacity = '1';
        });
      });
    }
  }, 800);

  // Wait for user interaction (key or click) before showing win overlay
  const showWinOverlay = () => {
    if (winOverlay && !winOverlay.classList.contains('show')) {
      winOverlay.classList.add('show');
    }
    // Always clean up after first trigger
    document.removeEventListener('keydown', showWinOverlay);
    document.removeEventListener('click', showWinOverlay);
    _peppaWinOverlayHandler = null;
  };

  // Delay enabling interaction slightly to allow celebration animations to start
  setTimeout(() => {
    _peppaWinOverlayHandler = showWinOverlay; // store so stopPeppaGame can clean up
    document.addEventListener('keydown', showWinOverlay);
    document.addEventListener('click', showWinOverlay);
  }, 1200);
}

window.restartPeppaGame = () => {
  const winOverlay = document.getElementById('peppa-win-overlay');
  const bus = document.getElementById('peppa-bus');
  const friendsLayer = document.getElementById('peppa-friends-layer');

  if (winOverlay) winOverlay.classList.remove('show');
  if (bus) bus.classList.remove('victory-hero');
  if (friendsLayer) friendsLayer.innerHTML = '';

  peppaScore = 0;
  peppaCollectedFriends = [];
  window.updatePeppaScoreUI();
  stopPeppaGame();
  setPeppaGameMode();
};

function setPeppaGameMode() {
  isEditMode = false;
  viewLanding.classList.add('hidden');
  viewEducation.classList.add('hidden');
  viewEdit.classList.add('hidden');
  viewMathGame.classList.add('hidden');
  viewPeppaGame.classList.remove('hidden');
  categoryTabs.classList.add('hidden');

  // Ensure speed factor is applied
  updatePeppaSpeedFactor();

  saveQuizSettings();

  // Start flow:
  stopPeppaGame();

  // Fullscreen Preparation (Add listener AFTER stopPeppaGame)
  document.addEventListener('mousemove', peppaMouseMove);

  // Compute lane screen positions after a frame so 3D transforms are rendered
  requestAnimationFrame(() => computeLaneScreenBounds());

  peppaScore = 0;
  peppaCollectedFriends = [];
  window.updatePeppaScoreUI();
  window.setBusLane(1); document.getElementById('btn-peppa-pause').classList.remove('hidden');
  startPeppaTheme();

  // Reset positions
  const viewWidth = window.innerWidth;
  peppaBusX = viewWidth * 0.45; // Starting position: midpoint of 25%-60%
  targetMouseX = viewWidth * 0.45;

  // Reset module-level RAF state and bump generation so any stale loop self-terminates
  peppaRoadX = 0;
  peppaSkylineX = 0;
  peppaLastTime = 0;
  const myGen = ++peppaLoopGen;

  // Cache DOM elements for performance
  const lanes = document.querySelectorAll('.peppa-lane');
  const sidewalks = document.querySelectorAll('.peppa-sidewalk');
  const skylines = document.querySelectorAll('.peppa-skyline');
  const bus = document.getElementById('peppa-bus');

  // Module-level RAF loop — uses peppaLoopGen to self-terminate if stale
  function peppaMove(timestamp) {
    // Self-terminate if this is not the current game generation
    if (myGen !== peppaLoopGen) return;
    if (mode !== 'peppa-game') return;

    if (peppaPaused) {
      peppaLastTime = 0; // Reset so next frame has valid dt after resume
      peppaAnimationFrame = requestAnimationFrame(peppaMove);
      return;
    }

    if (!peppaLastTime) peppaLastTime = timestamp;
    const dt = Math.min(0.1, (timestamp - peppaLastTime) / 1000); // Cap DT to prevent huge jumps
    peppaLastTime = timestamp;

    if (!bus) return;

    // 1. World Movement (Road & Skyline)
    const baseSpeed = 750; // px/s
    peppaRoadX += baseSpeed * appData.peppaSpeed * dt;
    peppaSkylineX += (baseSpeed / 10) * appData.peppaSpeed * dt;

    peppaRoadX %= 600;

    lanes.forEach(m => {
      m.style.setProperty('--road-x', `-${peppaRoadX}px`);
    });
    sidewalks.forEach(s => {
      s.style.backgroundPosition = `-${peppaRoadX}px 0`;
    });
    skylines.forEach(s => {
      s.style.backgroundPosition = `-${peppaSkylineX}px 0`;
    });

    // 2. Bus Horizontal Movement
    const vw = window.innerWidth;
    const roadOffset = vw * 0.25;
    const minX = vw * 0.25;
    const maxX = vw * 0.60;

    const clampedTargetX = Math.max(minX, Math.min(maxX, targetMouseX));
    const dist = clampedTargetX - peppaBusX;
    const speed = getBusMoveSpeedMultiplier() * appData.peppaSpeed;

    if (Math.abs(dist) > speed) {
      peppaBusX += Math.sign(dist) * speed;
    } else {
      peppaBusX = clampedTargetX;
    }

    bus.style.left = (peppaBusX + roadOffset) + "px";

    peppaAnimationFrame = requestAnimationFrame(peppaMove);
  }
  peppaAnimationFrame = requestAnimationFrame(peppaMove);

  const spawnInt = setInterval(() => {
    if (mode === 'peppa-game' && Math.random() > 0.4) spawnPeppaFriend();
  }, getCharSpawnInterval());
  peppaIntervals.push(spawnInt);

  const decoInt = setInterval(() => {
    if (mode === 'peppa-game' && Math.random() > 0.3) spawnPeppaDecoration();
  }, 1500);
  peppaIntervals.push(decoInt);

  const hazardInt = setInterval(() => {
    if (mode === 'peppa-game' && Math.random() > 0.4) spawnPeppaHazard();
  }, getHazardSpawnInterval());
  peppaIntervals.push(hazardInt);
}

function setMode(newMode) {
  // Stop game if leaving peppa game
  if (mode === 'peppa-game' && newMode !== 'peppa-game') {
    stopPeppaGame();
  }
  if (newMode !== 'quiz') stopQuizMusic();

  // Clear active classes
  document.body.classList.remove('quiz-active', 'education-active');

  // Allow any authenticated user (including anonymous quests) to edit
  if (newMode === 'edit' && !user) {
    showToast("You must be signed in to edit.", "error");
    return;
  }
  mode = newMode;
  if (mode === 'landing') setLandingMode();
  else if (mode === 'education') setEducationMode();
  else if (mode === 'edit') setEditMode();
  else if (mode === 'math-game') setMathGameMode();
  else if (mode === 'peppa-game') setPeppaGameMode();
  else if (mode === 'quiz') setQuizMode();
}
window.setMode = setMode;

// ============================================================
// QUIZ MODE
// ============================================================
function _quizAskedKey() {
  // Single global key — prevents repeats regardless of subject combo changes
  return 'quizAsked_v4_global';
}
function loadQuizAsked() {
  try {
    const raw = localStorage.getItem(_quizAskedKey());
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveQuizAsked() {
  try { localStorage.setItem(_quizAskedKey(), JSON.stringify(quizAskedQuestions)); } catch { }
}

// Persist quiz settings (subjects, age, theme, etc.)
function saveQuizSettings() {
  try { localStorage.setItem('quizSettings_v2', JSON.stringify(quizSettings)); } catch { }
}
function loadQuizSettings() {
  try {
    const raw = localStorage.getItem('quizSettings_v2');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Basic validation: ensure subjects is an array
    if (!Array.isArray(parsed.subjects)) return null;
    return parsed;
  } catch { return null; }
}

// Force a fresh AI generation (clears queue and retries)
window.forceAIGeneration = () => {
  quizQuestionQueue = [];
  quizAskedQuestions = loadQuizAsked(); // refresh history to avoid repeats
  generateQuizQuestion();
};

const QUIZ_SUBJECTS = ['English', 'Chinese', 'Pure Chinese', 'Math', 'Science', 'General Knowledge'];

// Initialize defaults
let initialSettings = loadQuizSettings() || {
  subjects: [...QUIZ_SUBJECTS],
  age: 6,
  eduLevel: 'P2',
  contentTypes: ['text'],
  customSubject: '',
  correctTarget: 5,
  musicVolume: 0.2,
  musicOn: false,
  dwellTimeMs: 2000,
  qReadEnabled: true,
  qReadTimeMs: 1000,
  theme: 'ben-holly',
  questionSource: 'ai',
  fontSize: 'medium',
  hintThreshold: 4,
  voiceOver: false,
  voiceOverHoverRepeat: false,
};
// Migrate saved settings that are missing new fields
if (!initialSettings.questionSource) initialSettings.questionSource = 'ai';
if (!initialSettings.fontSize) initialSettings.fontSize = 'medium';
if (initialSettings.hintThreshold === undefined) initialSettings.hintThreshold = 4;
if (initialSettings.voiceOver === undefined) initialSettings.voiceOver = false;
if (initialSettings.voiceOverHoverRepeat === undefined) initialSettings.voiceOverHoverRepeat = false;
if (!initialSettings.eduLevel) initialSettings.eduLevel = 'P2';
if (!initialSettings.contentTypes) initialSettings.contentTypes = ['text'];
if (initialSettings.customSubject === undefined) initialSettings.customSubject = '';
if (initialSettings.qReadEnabled === undefined) initialSettings.qReadEnabled = true;
if (!initialSettings.qReadTimeMs) initialSettings.qReadTimeMs = 3000;
if (!initialSettings.dwellTimeMs && initialSettings.dwellTimeMs !== 0) initialSettings.dwellTimeMs = 2000;

let quizSettings = initialSettings;

let currentQuizTheme = 'normal';
let quizScore = 0;
let quizWrongAttempts = 0;
let quizCurrentQ = null;
let quizRenderGen = 0;
let quizAudio = null;
let quizQReadTimerId = null;
let quizQReadOnEnter = null;
let quizQReadOnLeave = null;
let quizQReadOnClick = null;
let quizAskedQuestions = [];
let quizQuestionQueue = [];
let quizHistory = [];
let quizHistoryIdx = -1;


// --- Header button quiz-mode swap helpers ---
function enterQuizHeaderMode() {
  const hasImage = (quizSettings.contentTypes || []).includes('image');

  if (hasImage) {
    // Image mode: collapse header into a vertical left sidebar
    document.body.classList.add('quiz-img-sidebar');

    // Build sidebar if not already present
    let sidebar = document.getElementById('quiz-sidebar-controls');
    if (!sidebar) {
      sidebar = document.createElement('div');
      sidebar.id = 'quiz-sidebar-controls';
      document.querySelector('header').appendChild(sidebar);
    }

    // Get user initial for avatar
    const userEl = document.getElementById('display-user');
    const userInitial = (userEl?.textContent?.trim() || 'G')[0].toUpperCase();

    sidebar.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
            <span class="quiz-sidebar-logo" ondblclick="setMode('landing')" title="Double-click: back to home">EduGaze</span>
            <div class="quiz-sidebar-user" title="${userEl?.textContent?.trim() || 'Guest'}">${userInitial}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
            <button class="quiz-sidebar-btn" ondblclick="window.forceReloadQuizImages()" title="Double-click: Reload Images" style="color:#60a5fa;">
              <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            </button>
            <button class="quiz-sidebar-btn" ondblclick="window.openQuizSettings()" title="Double-click: Settings">
              <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </button>
            <button class="quiz-sidebar-btn" ondblclick="setMode('landing')" title="Double-click: Exit Quiz" style="color:#f87171;">
              <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>`;
  } else {
    // Normal mode: standard header buttons
    document.body.classList.remove('quiz-img-sidebar');
    // Replace btn-education with "Settings" (double-click)
    btnEducation.textContent = '';
    btnEducation.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg> Settings`;
    btnEducation.className = 'flex items-center gap-2 px-4 py-2 rounded-lg transition-all bg-violet-900/60 text-violet-300 hover:bg-violet-800/80 border border-violet-700/40';
    btnEducation.onclick = null;
    btnEducation.ondblclick = () => window.openQuizSettings();
    btnEducation.title = 'Double-click to open settings';

    // Replace btn-edit with "Exit" (double-click)
    btnEdit.textContent = 'Exit';
    btnEdit.className = 'flex items-center gap-2 px-4 py-2 rounded-lg transition-all bg-slate-800 text-slate-400 hover:bg-slate-700 border border-slate-700';
    btnEdit.onclick = null;
    btnEdit.ondblclick = () => setMode('landing');
    btnEdit.title = 'Double-click to exit Quiz';

    // Update hint text
    const hint = document.getElementById('header-mode-hint');
    if (hint) hint.textContent = 'Double-click buttons to use them';
  }
}

function restoreHeaderFromQuizMode() {
  document.body.classList.remove('quiz-active', 'quiz-img-sidebar');
  // Restore btn-education
  btnEducation.innerHTML = 'Education Mode';
  btnEducation.className = 'flex items-center gap-2 px-4 py-2 rounded-lg transition-all bg-slate-800 text-slate-400 hover:bg-slate-700';
  btnEducation.ondblclick = null;
  btnEducation.title = '';
  btnEducation.onclick = () => setMode('education');

  // Restore btn-edit
  btnEdit.textContent = 'Edit Mode';
  btnEdit.className = 'flex items-center gap-2 px-4 py-2 rounded-lg transition-all bg-slate-800 text-slate-400 hover:bg-slate-700';
  btnEdit.ondblclick = null;
  btnEdit.title = '';
  btnEdit.onclick = null;

  const hint = document.getElementById('header-mode-hint');
  if (hint) hint.textContent = 'Double-click or Ctrl-e to enter Edit Mode';

  // Remove sidebar if present
  const sidebar = document.getElementById('quiz-sidebar-controls');
  if (sidebar) sidebar.remove();
}

// Global function to force reload images for the current quiz question
window.forceReloadQuizImages = () => {
  if (!quizCurrentQ) return;
  // Remove from cache
  if (quizCurrentQ.questionImageKeyword) {
    quizResolvedVisuals.delete(quizCurrentQ.questionImageKeyword);
  }
  if (quizCurrentQ.answers) {
    quizCurrentQ.answers.forEach(a => {
      if (a.imageKeyword) quizResolvedVisuals.delete(a.imageKeyword);
    });
  }
  console.log('[Quiz] Force reloading images for current question');
  // Re-render the board to trigger a fresh resolveVisual fetch
  renderQuizBoard();
};

function initQuizSettingsUI() {
  // Subjects chips
  document.querySelectorAll('.quiz-subject-chip').forEach(chip => {
    const subj = chip.dataset.subject;
    chip.classList.toggle('active', quizSettings.subjects.includes(subj));
    chip.onclick = () => {
      if (quizSettings.subjects.includes(subj)) {
        if (quizSettings.subjects.length === 1 && !quizSettings.customSubject) {
          showToast('Select at least one subject.', 'info');
          return;
        }
        quizSettings.subjects = quizSettings.subjects.filter(s => s !== subj);
      } else {
        quizSettings.subjects.push(subj);
      }
      chip.classList.toggle('active', quizSettings.subjects.includes(subj));
      saveQuizSettings();
    };
  });

  // Custom subject input
  const customSubjInput = document.getElementById('quiz-custom-subject');
  if (customSubjInput) {
    customSubjInput.value = quizSettings.customSubject || '';
    customSubjInput.oninput = e => {
      quizSettings.customSubject = e.target.value.trim();
      saveQuizSettings();
    };
  }

  // Content type checkboxes
  ['text', 'image'].forEach(type => {
    const chk = document.getElementById(`quiz-content-${type}`);
    if (chk) {
      chk.checked = quizSettings.contentTypes.includes(type);
      chk.onchange = () => {
        const types = ['text', 'image'].filter(t => document.getElementById(`quiz-content-${t}`)?.checked);
        if (types.length === 0) { chk.checked = true; return; } // must keep at least one
        quizSettings.contentTypes = types;
        saveQuizSettings();
      };
    }
  });


  // Theme chips
  document.querySelectorAll('.quiz-theme-chip').forEach(chip => {
    chip.classList.toggle('active', quizSettings.theme === chip.dataset.theme);
    chip.onclick = () => {
      quizSettings.theme = chip.dataset.theme;
      document.querySelectorAll('.quiz-theme-chip').forEach(c =>
        c.classList.toggle('active', c.dataset.theme === quizSettings.theme)
      );
      saveQuizSettings();
    };
  });

  // Education level selector
  const EDU_LEVELS = [
    { id: 'N1', label: 'N1', age: 3, diff: 'Very simple nursery-level — colours, shapes, animals, basic counting to 5' },
    { id: 'N2', label: 'N2', age: 4, diff: 'Nursery 2 — simple words, numbers 1-10, basic body parts, common objects' },
    { id: 'K1', label: 'K1', age: 5, diff: 'Kindergarten 1 — basic phonics, numbers to 20, simple sentences, Singapore context' },
    { id: 'K2', label: 'K2', age: 6, diff: 'Kindergarten 2 — sight words, addition/subtraction to 10, simple stories, days/months' },
    { id: 'P1', label: 'P1', age: 7, diff: 'Primary 1 Singapore syllabus — simple grammar, numbers to 100, basic science concepts' },
    { id: 'P2', label: 'P2', age: 8, diff: 'Primary 2 Singapore syllabus — word families, multiplication intro, plants and animals' },
    { id: 'P3', label: 'P3', age: 9, diff: 'Primary 3 Singapore syllabus — grammar, fractions, matter and energy' },
    { id: 'P4', label: 'P4', age: 10, diff: 'Primary 4 Singapore syllabus — complex grammar, decimals, ecosystems' },
    { id: 'P5', label: 'P5', age: 11, diff: 'Primary 5 Singapore syllabus — essays, percentages/ratio, electricity/magnets' },
    { id: 'P6', label: 'P6', age: 12, diff: 'PSLE level — comprehension, algebra intro, full Singapore primary science' },
    { id: 'S1', label: 'S1', age: 13, diff: 'Secondary 1 Singapore — O-level foundation, algebra, biology/chemistry/physics intro' },
    { id: 'S2', label: 'S2', age: 14, diff: 'Secondary 2 Singapore — O-level intermediate, geometry, human biology' },
    { id: 'S3', label: 'S3', age: 15, diff: 'Secondary 3 Singapore — O-level core, trigonometry, pure sciences' },
    { id: 'S4', label: 'S4', age: 16, diff: 'O-level year — exam-level difficulty, full secondary Singapore curriculum' },
    { id: 'J1', label: 'J1', age: 17, diff: 'Junior College 1 Singapore — A-level foundation, calculus, advanced sciences/humanities' },
    { id: 'J2', label: 'J2', age: 18, diff: 'A-level year — exam-level difficulty, full JC Singapore curriculum' },
    { id: 'U', label: 'U', age: 20, diff: 'University level — undergraduate academic difficulty, critical thinking, research-based' },
  ];
  window._EDU_LEVELS = EDU_LEVELS;
  const levelGrid = document.getElementById('quiz-edu-level-grid');
  if (levelGrid) {
    levelGrid.innerHTML = '';
    EDU_LEVELS.forEach(lvl => {
      const btn = document.createElement('button');
      btn.className = 'edu-level-btn' + (quizSettings.eduLevel === lvl.id ? ' active' : '');
      btn.textContent = lvl.label;
      btn.title = lvl.diff;
      btn.onclick = () => {
        quizSettings.eduLevel = lvl.id;
        quizSettings.age = lvl.age; // keep age in sync for fallback bank
        levelGrid.querySelectorAll('.edu-level-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const display = document.getElementById('quiz-edu-level-display');
        if (display) display.textContent = lvl.label;
        saveQuizSettings();
      };
      levelGrid.appendChild(btn);
    });
  }
  const lvlDisplay = document.getElementById('quiz-edu-level-display');
  if (lvlDisplay) lvlDisplay.textContent = quizSettings.eduLevel;

  // Count slider
  const countSlider = document.getElementById('quiz-count-slider');
  const countDisplay = document.getElementById('quiz-count-display');
  countSlider.value = quizSettings.correctTarget;
  countDisplay.textContent = quizSettings.correctTarget;
  countSlider.oninput = e => {
    quizSettings.correctTarget = parseInt(e.target.value);
    countDisplay.textContent = quizSettings.correctTarget;
    updateQuizScoreBar();
    saveQuizSettings();
  };

  // Music toggle
  updateQuizMusicToggleUI();

  // Volume slider
  const volSlider = document.getElementById('quiz-volume-slider');
  const volDisplay = document.getElementById('quiz-volume-display');
  if (volSlider) {
    volSlider.value = Math.round(quizSettings.musicVolume * 100);
    volDisplay.textContent = `${Math.round(quizSettings.musicVolume * 100)}%`;
    volSlider.oninput = e => {
      const v = parseInt(e.target.value) / 100;
      quizSettings.musicVolume = v;
      volDisplay.textContent = `${e.target.value}%`;
      if (quizAudio) quizAudio.volume = v;
      saveQuizSettings();
    };
  }

  // Dwell time
  const dwellInput = document.getElementById('quiz-dwell-input');
  const dwellSlider = document.getElementById('quiz-dwell-slider');
  dwellInput.value = quizSettings.dwellTimeMs;
  dwellSlider.value = quizSettings.dwellTimeMs;
  const syncDwell = val => {
    quizSettings.dwellTimeMs = Number(val);
    dwellInput.value = val;
    dwellSlider.value = val;
    saveQuizSettings();
  };
  dwellInput.oninput = e => syncDwell(e.target.value);
  dwellSlider.oninput = e => syncDwell(e.target.value);

  // QRead
  const qReadChk = document.getElementById('quiz-qread-enabled');
  const qReadInput = document.getElementById('quiz-qread-input');
  const qReadSlider = document.getElementById('quiz-qread-slider');
  const qReadControls = document.getElementById('quiz-qread-controls');
  qReadChk.checked = quizSettings.qReadEnabled;
  qReadInput.value = quizSettings.qReadTimeMs;
  qReadSlider.value = quizSettings.qReadTimeMs;
  const updateQReadState = () => {
    qReadControls.classList.toggle('opacity-40', !qReadChk.checked);
    qReadControls.classList.toggle('pointer-events-none', !qReadChk.checked);
  };
  updateQReadState();
  qReadChk.onchange = e => {
    quizSettings.qReadEnabled = e.target.checked;
    updateQReadState();
    saveQuizSettings();
  };
  const syncQRead = val => {
    quizSettings.qReadTimeMs = Number(val);
    qReadInput.value = val;
    qReadSlider.value = val;
    saveQuizSettings();
  };
  qReadInput.oninput = e => syncQRead(e.target.value);
  qReadSlider.oninput = e => syncQRead(e.target.value);

  // Font Size chips
  const applyQuizFontSize = () => {
    const grid = document.getElementById('quiz-answers-grid');
    if (!grid) return;
    const spans = grid.querySelectorAll('span');
    const sizes = ['small', 'medium', 'large', 'extra-large'];
    spans.forEach(span => {
      sizes.forEach(s => span.classList.remove(`quiz-font-${s}`));
      span.classList.add(`quiz-font-${quizSettings.fontSize}`);
    });
  };

  document.querySelectorAll('#quiz-font-size-chips .qsrc-pill').forEach(chip => {
    chip.classList.toggle('active-source', quizSettings.fontSize === chip.dataset.size);
    chip.onclick = () => {
      quizSettings.fontSize = chip.dataset.size;
      document.querySelectorAll('#quiz-font-size-chips .qsrc-pill').forEach(c =>
        c.classList.toggle('active-source', c.dataset.size === quizSettings.fontSize)
      );
      applyQuizFontSize();
      saveQuizSettings();
    };
  });

  // Hint slider
  const hintSlider = document.getElementById('quiz-hint-slider');
  const hintDisplay = document.getElementById('quiz-hint-display');
  if (hintSlider && hintDisplay) {
    hintSlider.value = quizSettings.hintThreshold;
    hintDisplay.textContent = quizSettings.hintThreshold === 11 ? 'Never' : quizSettings.hintThreshold;
    hintSlider.oninput = e => {
      const val = parseInt(e.target.value);
      quizSettings.hintThreshold = val;
      hintDisplay.textContent = val === 11 ? 'Never' : val;
      saveQuizSettings();
    };
  }

  // Question Source toggle
  const updateQSourceUI = () => {
    document.getElementById('qsrc-btn-ai').classList.toggle('active-source', quizSettings.questionSource === 'ai');
    document.getElementById('qsrc-btn-bank').classList.toggle('active-source', quizSettings.questionSource === 'bank');
    const ageSection = document.getElementById('quiz-age-section');
    if (ageSection) ageSection.style.opacity = quizSettings.questionSource === 'bank' ? '0.4' : '1';
  };
  document.getElementById('qsrc-btn-ai').onclick = () => {
    quizSettings.questionSource = 'ai'; updateQSourceUI(); saveQuizSettings();
  };
  document.getElementById('qsrc-btn-bank').onclick = () => {
    quizSettings.questionSource = 'bank'; updateQSourceUI(); saveQuizSettings();
  };
  updateQSourceUI();

  // Voice Over toggle + Repeat when hover sub-setting
  const voChk = document.getElementById('quiz-voiceover-enabled');
  const voHoverRow = document.getElementById('quiz-vo-hover-row');
  const voHoverChk = document.getElementById('quiz-vo-hover-repeat');
  const _syncVoHoverRow = () => {
    if (voHoverRow) voHoverRow.style.display = quizSettings.voiceOver ? 'flex' : 'none';
  };
  if (voChk) {
    voChk.checked = quizSettings.voiceOver;
    voChk.onchange = e => {
      quizSettings.voiceOver = e.target.checked;
      saveQuizSettings();
      _syncVoHoverRow();
    };
  }
  if (voHoverChk) {
    voHoverChk.checked = !!quizSettings.voiceOverHoverRepeat;
    voHoverChk.onchange = e => {
      quizSettings.voiceOverHoverRepeat = e.target.checked;
      saveQuizSettings();
    };
  }
  _syncVoHoverRow(); // set initial visibility
}

function updateQuizMusicToggleUI() {
  const toggle = document.getElementById('quiz-music-toggle');
  const thumb = document.getElementById('quiz-music-thumb');
  if (!toggle || !thumb) return;
  if (quizSettings.musicOn) {
    toggle.style.background = 'rgba(139, 92, 246, 0.6)';
    thumb.style.transform = 'translateX(28px)';
    thumb.style.background = '#c4b5fd';
  } else {
    toggle.style.background = '';
    thumb.style.transform = '';
    thumb.style.background = '';
  }
}

window.toggleQuizMusic = () => {
  quizSettings.musicOn = !quizSettings.musicOn;
  updateQuizMusicToggleUI();
  if (mode === 'quiz') {
    if (quizSettings.musicOn) startQuizMusic();
    else stopQuizMusic();
  }
  saveQuizSettings();
};

function startQuizMusic() {
  if (!quizSettings.musicOn) return;
  if (quizAudio) { quizAudio.play().catch(() => { }); return; }
  // Reuse peppa instrumental theme as background music
  quizAudio = new Audio('assets/peppa/quiz_music.webm');
  quizAudio.loop = true;
  quizAudio.volume = quizSettings.musicVolume;
  quizAudio.play().catch(e => console.log('Quiz audio deferred', e));
}

function stopQuizMusic() {
  if (quizAudio) {
    quizAudio.pause();
    quizAudio.currentTime = 0;
    quizAudio = null;
  }
}

// ── Voice Over (TTS) helper ─────────────────────────────────────────────
const _VO_CONGRATS = [
  'Amazing!', 'Fantastic!', 'You got it!', 'Brilliant!',
  'Super!', 'Excellent!', 'Wonderful!', 'Outstanding!', 'Great job!', 'Correct!',
  'Incredible!', 'You are a star!', 'Way to go!', 'Way to go!', 'You are a genius!',
  'Magnificent!', 'Marvelous!', 'Spectacular!'
];
let _voiceEnglish = null;  // cached English female voice (Gemini-like)
let _voiceChinese = null;  // cached Mandarin female voice
let _quizVoiceDelay = 0;   // timestamp: don't speak question before this time
let _voAbortGen = 0;       // incremented to cancel stale answer-reading timers
let _activeFallbackTimers = []; // highlight timers for voices that don't fire onboundary

// Detect Chinese characters in the text
function _isChineseText(text) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

// Wraps text into inline <span> children for word-level highlighting.
// Each child span gets data-start/end so the onboundary event can find it.
// LAYOUT CONTRACT:
//   - The container element must be block/inline-block with a defined width.
//   - Word spans are plain inline — the browser wraps naturally between them.
//   - We do NOT set white-space:nowrap on child spans; single-token spans
//     (e.g. "don't") already can't break mid-token in normal flow.
function prepareHighlightableText(element, text) {
  if (!element) return [];
  element.innerHTML = '';
  // Let the container wrap normally; do NOT constrain it to nowrap.
  element.style.whiteSpace = 'normal';
  element.style.wordBreak = 'normal'; // break only at normal word boundaries
  const tokens = [];

  // Segment: Chinese runs vs. non-Chinese runs
  const segmentRe = /([\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]+)|([^\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]+)/g;
  let match;
  let globalIdx = 0;

  while ((match = segmentRe.exec(text)) !== null) {
    const chunk = match[0];
    const isZh = !!match[1];

    if (isZh) {
      // Chinese: one span per character (TTS fires per-char boundary)
      for (const char of chunk) {
        const span = document.createElement('span');
        span.textContent = char;
        span.dataset.start = globalIdx;
        span.dataset.end = globalIdx + char.length;
        element.appendChild(span);
        tokens.push(span);
        globalIdx += char.length;
      }
    } else {
      // English / mixed: tokenise into (spaces | words-with-apostrophes | punctuation)
      // Regex group 1 = whitespace (not a token), 2 = word, 3 = punctuation
      const tokenRe = /([ \t\r\n]+)|([\w][\w'\u2019\-]*)|([^\w\s]+)/g;
      let tMatch;
      while ((tMatch = tokenRe.exec(chunk)) !== null) {
        const token = tMatch[0];
        const isWord = !!tMatch[2];
        const isPunct = !!tMatch[3];
        const span = document.createElement('span');
        span.textContent = token;
        span.dataset.start = globalIdx;
        span.dataset.end = globalIdx + token.length;
        element.appendChild(span);
        // Only words and punctuation are highlight targets; spaces are silent
        if (isWord || isPunct) tokens.push(span);
        globalIdx += token.length;
      }
    }
  }
  return tokens;
}

// Pick the best English female voice, closest to Gemini's default
function _pickEnglishVoice() {
  if (_voiceEnglish) return _voiceEnglish;
  const voices = window.speechSynthesis?.getVoices() || [];
  if (!voices.length) return null;
  // Gemini uses Google's US English neural voice — match closest available
  const preferred = [
    'Google US English',           // Closest to Gemini default
    'Google UK English Female',    // Google neural, UK female
    'Microsoft Aria Online (Natural) - English (United States)', // MS neural
    'Microsoft Jenny Online (Natural) - English (United States)',
    'Microsoft Aria - English (United States)',
    'Microsoft Zira Desktop - English (United States)',
    'Microsoft Hazel Desktop - English (Great Britain)',
    'Samantha', 'Karen', 'Victoria', 'Moira', // macOS
  ];
  for (const name of preferred) {
    const v = voices.find(v => v.name === name);
    if (v) { _voiceEnglish = v; return v; }
  }
  const byKeyword = voices.find(v => v.name.toLowerCase().includes('female') && v.lang?.startsWith('en'));
  if (byKeyword) { _voiceEnglish = byKeyword; return byKeyword; }
  const enUS = voices.find(v => v.lang === 'en-US');
  const enAny = voices.find(v => v.lang?.startsWith('en'));
  _voiceEnglish = enUS || enAny || null;
  return _voiceEnglish;
}

// Pick a native Mandarin female voice
function _pickChineseVoice() {
  if (_voiceChinese) return _voiceChinese;
  const voices = window.speechSynthesis?.getVoices() || [];
  if (!voices.length) return null;
  const preferred = [
    'Google \u666e\u901a\u8bdd\uff08\u4e2d\u56fd\u5927\u9646\uff09', // Google 普通话（中国大陆）
    'Microsoft Yaoyao Desktop - Chinese (Simplified, PRC)',
    'Microsoft Huihui Desktop - Chinese (Simplified, PRC)',
    'Ting-Ting',  // macOS
    'Sin-Ji',     // macOS Cantonese fallback
  ];
  for (const name of preferred) {
    const v = voices.find(v => v.name === name);
    if (v) { _voiceChinese = v; return v; }
  }
  // Any zh-CN voice (prefer female-sounding ones)
  const zhCN = voices.find(v => v.lang === 'zh-CN');
  const zhAny = voices.find(v => v.lang?.startsWith('zh'));
  _voiceChinese = zhCN || zhAny || null;
  return _voiceChinese;
}

// Re-pick after voices list loads (Chrome loads voices asynchronously)
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    _voiceEnglish = null;
    _voiceChinese = null;
    _pickEnglishVoice();
    _pickChineseVoice();
  };
}

// Segment text into language-specific chunks for TTS
function _segmentText(text) {
  const parts = [];
  const segmentRe = /([\u4e00-\u9fff\u3400-\u4dbf]+)|([^\u4e00-\u9fff\u3400-\u4dbf]+)/g;
  let match;
  while ((match = segmentRe.exec(text)) !== null) {
    if (match[1]) parts.push({ text: match[1], lang: 'zh' });
    else if (match[2]) parts.push({ text: match[2], lang: 'en' });
  }
  return parts;
}

// Core speak function — auto-detects language segments and picks the right voices.
// Supports word-level highlighting if targetElement is provided.
function quizSpeak(text, { rate = 0.95, pitch = 1.0, delay = 0, onEnd = null, targetElement = null } = {}) {
  if (!quizSettings.voiceOver) { if (onEnd) onEnd(); return; }
  if (!window.speechSynthesis) { if (onEnd) onEnd(); return; }

  const segments = _segmentText(text);
  if (!segments.length) { if (onEnd) onEnd(); return; }

  // If targetElement already has highlight spans, use them. Otherwise, create them.
  // We check for a special data attribute to avoid "judder" from re-creating spans during speech.
  let tokenSpans = [];
  if (targetElement) {
    if (targetElement.dataset.prepared === 'true') {
      // Query existing spans created during render
      tokenSpans = Array.from(targetElement.querySelectorAll('span')).filter(s => s.dataset.start !== undefined);
    } else {
      tokenSpans = prepareHighlightableText(targetElement, text);
      targetElement.dataset.prepared = 'true';
    }
  }

  const abortGen = _voAbortGen;
  const speakSegments = () => {
    if (abortGen !== _voAbortGen) return;
    window.speechSynthesis.cancel();

    let globalCharOffset = 0;
    let currentIdx = 0;

    const speakNext = () => {
      if (currentIdx >= segments.length || abortGen !== _voAbortGen) {
        // All segments finished or aborted
        if (onEnd && abortGen === _voAbortGen) onEnd();
        return;
      }

      const seg = segments[currentIdx];
      // Silence brackets and punctuation by replacing with a space (preserves 1:1 character count
      // so that event.charIndex still lines up with our span dataset.start/end values).
      const spokenText = seg.text.replace(/[\(\)\[\]\{\}？！，。：；、\?\!\.\,]/g, ' ');
      const utt = new SpeechSynthesisUtterance(spokenText);

      if (seg.lang === 'zh') {
        const v = _pickChineseVoice();
        if (v) utt.voice = v; else utt.lang = 'zh-CN';
        utt.rate = rate * 0.95;
        utt.pitch = 1.15;
      } else {
        const v = _pickEnglishVoice();
        if (v) utt.voice = v; else utt.lang = 'en-US';
        utt.rate = rate;
        utt.pitch = pitch || 1.0;
      }

      // ── Highlighting ─────────────────────────────────────────────────────
      // Dual-mode: use onboundary when available (offline/MS voices),
      // fall back to a per-word timer for Google neural voices that don't
      // fire onboundary (a known Chrome limitation).
      //
      // event.charIndex is an offset within the *current* spokenText utterance.
      // globalCharOffset maps it back to the full-text indices stored in
      // span.dataset.start / .end.
      let boundaryFired = false;
      let fallbackTimers = [];

      const clearFallback = () => {
        fallbackTimers.forEach(t => {
          clearTimeout(t);
          const gi = _activeFallbackTimers.indexOf(t);
          if (gi !== -1) _activeFallbackTimers.splice(gi, 1);
        });
        fallbackTimers = [];
      };

      // Schedule timer-based highlights for spans that belong to THIS segment.
      // Average natural speech = ~150 words/min at rate=1.0 → ~400ms/word.
      // We use a slightly faster estimate so the highlight leads the audio.
      if (tokenSpans.length) {
        const segStart = globalCharOffset;
        const segEnd = globalCharOffset + seg.text.length;
        const segSpans = tokenSpans.filter(s => {
          const st = parseInt(s.dataset.start);
          return st >= segStart && st < segEnd;
        });

        if (segSpans.length) {
          // Per-word timing based on character count so longer words stay highlighted
          // longer before the next word fires — tracks actual voice tempo better.
          // Base formula: (chars * 55ms + 80ms) / effective_rate, minimum 120ms.
          const effectiveRate = seg.lang === 'zh' ? (rate * 0.95) : rate;

          // Build cumulative start-time offsets for each span
          const delays = [];
          let cumMs = 0;
          segSpans.forEach(span => {
            delays.push(cumMs);
            const wordLen = (span.textContent || '').trim().length || 1;
            cumMs += Math.max(120, Math.round((wordLen * 55 + 80) / effectiveRate));
          });

          segSpans.forEach((span, i) => {
            const t = setTimeout(() => {
              if (!boundaryFired) {
                // Fallback is active — apply highlight
                tokenSpans.forEach(s => s.classList.remove('quiz-word-highlight'));
                span.classList.add('quiz-word-highlight');
              }
            }, delays[i]);
            fallbackTimers.push(t);
            _activeFallbackTimers.push(t);
          });
        }
      }

      utt.onboundary = (event) => {
        if (!tokenSpans.length) return;
        // First real boundary event — cancel timer fallback
        if (!boundaryFired) {
          boundaryFired = true;
          clearFallback();
        }

        const charIdx = globalCharOffset + event.charIndex;

        // Primary: exact range match
        let target = tokenSpans.find(s => {
          const sStart = parseInt(s.dataset.start);
          const sEnd = parseInt(s.dataset.end);
          return charIdx >= sStart && charIdx < sEnd;
        });

        // Fallback: nearest token whose start is just ahead of charIdx
        // (handles browsers that fire boundary at the space before a word)
        if (!target) {
          target = tokenSpans.find(s => parseInt(s.dataset.start) === charIdx + 1) ||
            tokenSpans.find(s => parseInt(s.dataset.start) === charIdx + 2);
        }

        if (target) {
          tokenSpans.forEach(s => s.classList.remove('quiz-word-highlight'));
          target.classList.add('quiz-word-highlight');
        }
      };

      utt.onend = () => {
        clearFallback();
        tokenSpans.forEach(s => s.classList.remove('quiz-word-highlight'));
        globalCharOffset += seg.text.length; // advance by ORIGINAL length (same as spoken length)
        currentIdx++;
        speakNext();
      };

      window.speechSynthesis.speak(utt);
    };

    speakNext();
  };

  if (delay > 0) setTimeout(speakSegments, delay); else speakSegments();
}

// Read answers once the grid is visible — each answer spoken separately with a pause.
function _speakAnswers(q, gen) {
  if (!quizSettings.voiceOver) return;
  if (gen !== quizRenderGen) return;
  const grid = document.getElementById('quiz-answers-grid');
  if (!grid) return;
  // Chain each answer as a separate utterance with a 600ms pause between.
  const answers = q.answers.map(a => a.text);
  const abortGen = _voAbortGen;
  let idx = 0;
  const speakNext = () => {
    if (idx >= answers.length || gen !== quizRenderGen || abortGen !== _voAbortGen) return;
    const isLast = idx === answers.length - 1;
    const answerText = answers[idx];
    const card = grid.children[idx];
    // Use .quiz-answer-text span specifically — avoids targeting img-src-badge or other spans
    const targetEl = card ? card.querySelector('.quiz-answer-text') : null;
    idx++;
    quizSpeak(answerText, {
      rate: 0.88,
      targetElement: targetEl,
      onEnd: () => {
        if (isLast || abortGen !== _voAbortGen || gen !== quizRenderGen) return;
        setTimeout(speakNext, 600);
      }
    });
  };
  setTimeout(speakNext, 300);
}

// Speak a congratulatory phrase; celebration logic fires in onEnd.
// We split into TWO separate utterances with a real pause so the TTS engine
// uses rising inflection on the praise and then a measured announcement.
function quizSpeakCongrats(correctAnswer, { onEnd = null } = {}) {
  if (!quizSettings.voiceOver) { if (onEnd) onEnd(); return; }
  const praise = _VO_CONGRATS[Math.floor(Math.random() * _VO_CONGRATS.length)];
  // Step 1: speak the praise with high energy
  quizSpeak(praise, {
    rate: 1.05, pitch: 1.1,
    onEnd: () => {
      // Step 2: pause 600 ms then announce the answer at a calmer pace
      setTimeout(() => {
        quizSpeak(`The correct answer is: ${correctAnswer}.`, {
          rate: 0.9, pitch: 1.0, onEnd
        });
      }, 600);
    }
  });
}
function quizSpeakCancel() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  // Clear any pending timer-based highlight fallback timers
  _activeFallbackTimers.forEach(t => clearTimeout(t));
  _activeFallbackTimers = [];
  // Remove any lingering highlights
  document.querySelectorAll('.quiz-word-highlight').forEach(el => el.classList.remove('quiz-word-highlight'));
}
// ─────────────────────────────────────────────────────────────────────────

window.openQuizSettings = () => {
  initQuizSettingsUI();
  document.getElementById('quiz-settings-overlay').classList.add('show');
};
window.closeQuizSettings = () => {
  document.getElementById('quiz-settings-overlay').classList.remove('show');
};

function updateQuizScoreBar() {
  const bar = document.getElementById('quiz-score-bar');
  if (!bar) return;
  bar.innerHTML = '';
  for (let i = 0; i < quizSettings.correctTarget; i++) {
    const dot = document.createElement('div');
    dot.className = `w-3 h-3 rounded-full transition-all duration-300 ${i < quizScore
      ? 'bg-violet-400 shadow-md shadow-violet-400/40'
      : 'bg-slate-700'
      }`;
    bar.appendChild(dot);
  }
}

// Robustly extract JSON from a potentially messy text response (handles MD blocks, leading text, garbage)
function extractJSON(text) {
  if (!text) return null;
  try {
    // Find things that look like a JSON object or array
    // Be greedy but cautious: find the FIRST { or [ and the LAST } or ]
    const startBracket = text.indexOf('{');
    const startArray = text.indexOf('[');
    const start = (startBracket !== -1 && (startArray === -1 || startBracket < startArray)) ? startBracket : startArray;

    if (start === -1) return null;

    const endBracket = text.lastIndexOf('}');
    const endArray = text.lastIndexOf(']');
    const end = Math.max(endBracket, endArray);

    if (end === -1 || end <= start) return null;

    const candidate = text.substring(start, end + 1);
    return JSON.parse(candidate);
  } catch (e) {
    console.warn('[Quiz] JSON extract failed — trying aggressive strip', e);
    try {
      const clean = text.replace(/```json\n?|```\n?/g, '').trim();
      return JSON.parse(clean);
    } catch (e2) {
      console.error('[Quiz] Aggressive extraction failed', e2);
      return null;
    }
  }
}

// ── AI Helper (Gemini Proxy) ──────────────────────────────────────────
window.callGemini = async (prompt, config = {}) => {
  try {
    const resp = await fetch('/api/quiz-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: config.temperature || 0.8,
          maxOutputTokens: config.maxOutputTokens || 8192,
        }
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    console.error('[Quiz] callGemini failed', e);
    return null;
  }
};

// ── Quiz Visual Pipeline (Pre-loading & Caching) ────────────────────────
// Stores resolved URLs or raw SVG code for questions/answers
const quizResolvedVisuals = new Map(); // key: keyword, value: { url, svg }

async function resolveVisual(keyword, context = [], questionText = '', opts = {}) {
  if (!keyword) return null;
  if (quizResolvedVisuals.has(keyword) && !opts.forceAI) return quizResolvedVisuals.get(keyword);
  // Store correct answer for SVG generation consistency
  const _correctAnswer = opts.correctAnswer || '';

  // ── Fast path: single Chinese character display ────────────────────────
  // If the keyword IS a Chinese character (1–4 chars, all CJK), render it
  // as a clean SVG — but ONLY when the question is specifically about
  // recognizing that character (e.g. "这个字是'手'吗？").
  // Guard: the character must appear in the question text to prove relevance.
  const _isCJKOnly = (str) => /^[\u4e00-\u9fff\u3400-\u4dbf]{1,4}$/.test(str.trim());
  if (_isCJKOnly(keyword)) {
    const char = keyword.trim();
    // Detect character recognition questions — these ask about identifying
    // Chinese characters, so ALL CJK answer keywords should render as SVG
    const isCharRecognitionQ = questionText && (
      questionText.includes('字') || questionText.includes('character') ||
      questionText.includes('哪个') || questionText.includes('哪一个') ||
      questionText.includes('认字') || questionText.includes('识字')
    );
    // Render as character SVG if: (a) question references this exact char,
    // OR (b) the question is a character recognition type
    const shouldRenderCJK = (questionText && questionText.includes(char)) || isCharRecognitionQ;
    if (shouldRenderCJK) {
      const svg = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" fill="#ffffff" rx="8"/>
  <text x="100" y="158" font-size="${char.length === 1 ? 140 : char.length === 2 ? 80 : 52}"
        text-anchor="middle" fill="#1a1a2e"
        font-family="'Noto Serif SC', 'STSong', 'SimSun', serif">${char}</text>
</svg>`;
      const res = { url: null, svg, source: 'ai' };
      quizResolvedVisuals.set(keyword, res);
      return res;
    }
    // Not a character question — skip CJK SVG rendering,
    // fall through to photo search (Pixabay/Wikimedia) below
    console.log('[Quiz] CJK keyword "' + char + '" — not a char question, trying photo search');
  }

  const qtxt = (questionText || '').toLowerCase();
  const kw = keyword.toLowerCase().trim();

  // Only use AI SVG when the question demands an exact diagram AND the
  // keyword is an abstract math/geometry/science concept. Real-world objects
  // (vehicles, animals, landmarks) must ALWAYS use Pixabay/Wikimedia.
  const isDiagramKeyword = /^(number line|bar graph|pie chart|fraction|decimal|ruler|protractor|analog clock|clock face|cylinder|sphere|pyramid|cone|cube|cuboid|prism|venn diagram|tally chart|pattern|sequence|shapes?|circles?|triangles?|squares?|rectangles?|arrows?|blocks?|cubes?|dots?|lines?|stars?|groups?|sets?|shaded.*(figure|shape|area|region)|grid|area|perimeter|angle|symmetry|reflection|rotation)s?$/i.test(kw) ||
    // Science diagram keywords (abstract processes and diagrams only, no simple physical objects)
    /\b(circuit|solar system|orbit|water cycle|evaporation|condensation|food chain|food web|magnetic field|simple machine|digestive system|skeleton|life cycle|photosynthesis|ecosystem|cell|atom|molecule|gravity|friction|volcano|rock cycle|states of matter)\b/i.test(kw);
  const isPrecisionQuestion =
    qtxt.includes('how many') || qtxt.includes('count') || qtxt.includes('measure') ||
    qtxt.includes('ruler') || qtxt.includes('protractor') || qtxt.includes('fraction') ||
    qtxt.includes('decimal') || qtxt.includes('graph') || qtxt.includes('chart') ||
    qtxt.includes('pattern') || qtxt.includes('sequence') || qtxt.includes('comes next') ||
    qtxt.includes('what comes') || qtxt.includes('which comes') || qtxt.includes('number line') ||
    qtxt.includes('area') || qtxt.includes('perimeter') || qtxt.includes('angle') ||
    qtxt.includes('shaded') || qtxt.includes('figure') || qtxt.includes('shape') ||
    qtxt.includes('symmetry') || qtxt.includes('reflect') || qtxt.includes('rotat') ||
    // Science diagram triggers
    qtxt.includes('circuit') || qtxt.includes('diagram') || qtxt.includes('cycle') ||
    qtxt.includes('system') || qtxt.includes('observe') || qtxt.includes('label');
  // Use AI SVG if the question is math/science precision AND keyword is a diagram concept,
  // OR if the keyword itself is clearly a diagram concept
  const isPreciseDiagram = (isPrecisionQuestion && isDiagramKeyword) || isDiagramKeyword;

  // ── Search keyword enrichment ───────────────────────────────────────────
  // Real-world keywords need a 'photo' bias so image APIs return photographs
  // not diagrams, maps, icons, or flags. We detect real-world subjects by
  // checking that the keyword is NOT a geometry/math term.
  const isAbstractShape = /^(triangle|circle|square|rectangle|hexagon|pentagon|octagon|rhombus|parallelogram|trapezoid|ellipse|oval|star|heart|diamond shape)$/.test(kw);
  const hasChinese = /[\u4e00-\u9fff]/.test(keyword);
  const isFlag = kw.includes('flag');

  // ── Dynamic context-aware Pixabay query builder ─────────────────────────
  // Instead of a static negative-tag list, we use the question text and subject
  // to infer the correct semantic domain and enrich the search query accordingly.
  const subject = (opts.subject || '').toLowerCase();
  const qtxtLower = (questionText || '').toLowerCase();

  // ── Step 1: Infer semantic domain from question + subject ─────────────────
  // This tells us what the image SHOULD depict, so we can both enrich the
  // query term AND reject Pixabay results that don't belong to that domain.
  const _inDomain = (terms) => terms.some(t => qtxtLower.includes(t) || subject.includes(t));

  const domainIsAnimal    = _inDomain(['animal', 'mammal', 'reptile', 'bird', 'fish', 'insect', 'amphibian', 'wildlife', 'creature', 'species', 'classify', 'habitat', 'predator', 'prey', 'science']);
  const domainIsFood      = _inDomain(['food', 'eat', 'fruit', 'vegetable', 'meal', 'diet', 'nutrition', 'cook', 'ingredient']);
  const domainIsTransport = _inDomain(['transport', 'vehicle', 'travel', 'road', 'drive', 'fly', 'sail']);
  const domainIsPlant     = _inDomain(['plant', 'flower', 'tree', 'leaf', 'garden', 'botany', 'photosynthesis']);
  const domainIsBody      = _inDomain(['body', 'organ', 'skeleton', 'muscle', 'sense', 'health', 'human']);
  const domainIsWeather   = _inDomain(['weather', 'climate', 'rain', 'cloud', 'storm', 'temperature']);
  const domainIsSpace     = _inDomain(['space', 'planet', 'solar', 'star', 'galaxy', 'moon', 'orbit']);
  const domainIsLandmark  = _inDomain(['landmark', 'monument', 'country', 'capital', 'geography', 'flag', 'world']);

  // ── Step 2: Build enriched Pixabay query ─────────────────────────────────
  // Append a domain-specific disambiguating qualifier to the keyword.
  // This directly steers Pixabay's semantic ranking.
  let enrichedQuery = keyword; // default: search as-is

  if (domainIsAnimal && !domainIsFood && !domainIsTransport) {
    enrichedQuery = `${keyword} animal wildlife`;
  } else if (domainIsFood && !domainIsAnimal) {
    enrichedQuery = `${keyword} food`;
  } else if (domainIsTransport) {
    enrichedQuery = `${keyword} vehicle`;
  } else if (domainIsPlant) {
    enrichedQuery = `${keyword} nature`;
  } else if (domainIsBody) {
    enrichedQuery = `${keyword} anatomy`;
  } else if (domainIsWeather) {
    enrichedQuery = `${keyword} weather`;
  } else if (domainIsSpace) {
    enrichedQuery = `${keyword} space astronomy`;
  }
  // Note: if domain is ambiguous or unknown, use keyword as-is (safe fallback)

  // ── Step 3: Pixabay category ─────────────────────────────────────────────
  let pixCategory = '';
  if (domainIsAnimal && !domainIsFood)      pixCategory = 'animals';
  else if (domainIsFood)                    pixCategory = 'food';
  else if (domainIsTransport)               pixCategory = 'transportation';
  else if (domainIsPlant || domainIsWeather) pixCategory = 'nature';
  else if (domainIsSpace)                   pixCategory = 'science';
  // Fallback: use a static map for common concrete keywords not inferrable from question
  else {
    const _staticCatMap = {
      cat: 'animals', dog: 'animals', horse: 'animals', elephant: 'animals',
      penguin: 'animals', whale: 'animals', dolphin: 'animals', owl: 'animals',
      apple: 'food', banana: 'food', cake: 'food', bread: 'food', rice: 'food',
      car: 'transportation', bus: 'transportation', train: 'transportation',
      airplane: 'transportation', bicycle: 'transportation',
    };
    pixCategory = _staticCatMap[kw] || '';
  }

  // ── Step 4: Contextual rejection filter ──────────────────────────────────
  // Reject Pixabay hits whose tags contradict the inferred domain.
  // This is dynamic: built from domain inference, not a static list per keyword.
  const dynamicNegTags = [];
  if (domainIsAnimal && !domainIsFood) {
    dynamicNegTags.push('food', 'meal', 'drink', 'beer', 'wine', 'restaurant',
      'brand', 'logo', 'cartoon', 'toy', 'plush', 'barbecue', 'grillplate',
      'football', 'soccer', 'sport', 'car', 'vehicle');
  }
  if (domainIsFood && !domainIsAnimal) {
    dynamicNegTags.push('animal', 'wildlife', 'logo', 'brand');
  }
  if (domainIsPlant) {
    dynamicNegTags.push('snake', 'reptile', 'python', 'lizard', 'frog');
  }
  // Always reject: keyword-specific known confusors (thin safety net)
  const _alwaysReject = {
    apple:  ['computer', 'laptop', 'iphone', 'mac'],
    mouse:  ['computer', 'peripheral', 'device'],
    bat:    ['baseball', 'cricket'],
    crane:  ['construction', 'machinery'],
    bark:   ['dog', 'puppy', 'canine'],
    bass:   ['guitar', 'music', 'instrument'],
    orange: ['sunset', 'sunrise'],
    bull:   ['stock', 'market', 'finance'],
  };
  const alwaysReject = _alwaysReject[kw] || [];
  const negTags = [...new Set([...dynamicNegTags, ...alwaysReject])];

  // ── Step 5: Build final Pixabay query ─────────────────────────────────────
  // For flags, use a specific refinement. Otherwise use the enriched query.
  const pixabayQuery = isFlag
    ? keyword.replace(/\s*flag\s*/i, ' country flag').trim()
    : enrichedQuery;

  // Wikimedia query: only append " photo" for short generic terms
  const isProperNoun = /^[A-Z]/.test(keyword) || hasChinese;
  const wikiQuery = isFlag
    ? keyword.replace(/\s*flag\s*/i, ' country flag').trim()
    : (!isProperNoun && !isAbstractShape)
      ? keyword + ' photo'
      : keyword;

  // ── Real photo sources (Pixabay → Wikimedia) ──────────────────────────
  // Skip photo sources if forceAI is set (Math questions always use AI SVG)
  if (!isPreciseDiagram && !opts.forceAI) {
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const _pixabaySearch = async (q) => {
      let pixProxyUrl = isLocalhost
        ? `https://us-central1-edugaze-50cdb.cloudfunctions.net/pixabaySearch?q=${encodeURIComponent(q)}&per_page=10&image_type=photo`
        : `/api/pixabay-search?q=${encodeURIComponent(q)}&per_page=10&image_type=photo`;
      // Append Pixabay category to narrow results (prevents cross-domain confusion)
      if (pixCategory) pixProxyUrl += `&category=${pixCategory}`;
      const pixResp = await fetch(pixProxyUrl);
      if (!pixResp.ok) return null;
      const pixData = await pixResp.json();
      const hits = pixData?.hits || [];
      if (!hits.length) return null;
      // Filter out hits whose tags match negative keywords
      const validHits = negTags.length > 0
        ? hits.filter(h => {
          const tags = (h.tags || '').toLowerCase();
          return !negTags.some(neg => tags.includes(neg));
        })
        : hits;
      // Pick a random valid hit for visual variety (avoids always showing the same image)
      const pool = validHits.length > 0 ? validHits : hits;
      const pick = pool[Math.floor(Math.random() * Math.min(pool.length, 5))];
      return pick?.webformatURL || null;
    };

    try {
      const photoUrl = await _pixabaySearch(pixabayQuery);
      if (photoUrl) {
        const res = { url: photoUrl, svg: null, source: 'pixabay' };
        quizResolvedVisuals.set(keyword, res);
        return res;
      }
    } catch (e) { /* Pixabay unavailable — fall through to Wikimedia */ }

    // Wikimedia Commons: try enriched query, then bare keyword as fallback
    let wikiUrl = await fetchWikiImage(wikiQuery);
    if (!wikiUrl && wikiQuery !== keyword) wikiUrl = await fetchWikiImage(keyword);
    if (wikiUrl) {
      const res = { url: wikiUrl, svg: null, source: 'wikimedia' };
      quizResolvedVisuals.set(keyword, res);
      return res;
    }
  }

  // ── Last resort: AI SVG ────────────────────────────────────────────────
  // Only reached for precise math diagrams OR if both photo sources failed.
  const aiSvg = await generateAISVG(keyword, null, context, questionText, _correctAnswer);
  if (aiSvg) {
    const res = { url: null, svg: aiSvg, source: 'ai' };
    quizResolvedVisuals.set(keyword, res);
    return res;
  }
  // Do NOT cache null — allow retry on next render
  return null;
}

async function preLoadBatchVisuals(batch) {
  if (!batch || !batch.length) return;
  console.log('[Quiz] Pre-loading visuals for batch...');
  for (const q of batch) {
    // Resolve question image
    if (q.questionImageKeyword) {
      const isMath = /^(math|mathematics)$/i.test(q._subject || q.subject || '');
      const correctAns = q.answers?.find(a => String(a.id) === String(q.correctId));
      resolveVisual(q.questionImageKeyword, q.answers.map(a => a.text), q.question, {
        forceAI: isMath,
        correctAnswer: correctAns?.text || '',
        subject: q._subject || q.subject || '',
        answerLabels: q.answers.map(a => a.text)
      });
    }
    // Resolve answer images
    if (q.answers) {
      for (const ans of q.answers) {
        if (ans.imageKeyword) resolveVisual(ans.imageKeyword, [], q.question, {
          subject: q._subject || q.subject || ''
        });
      }
    }
  }
}

// ── AI Graphic Generator (SVG) ───────────────────────────────────────────
async function generateAISVG(keyword, container, answerContext = [], questionText = '', correctAnswer = '', opts = {}) {
  if (!keyword) return null;

  // ── Labelled diagram detection ───────────────────────────────────────────
  // If all answer labels are single letters (A, B, C, D), the question is a
  // labelled-diagram type. The SVG MUST include those letter labels on the diagram.
  const answerLabels = opts.answerLabels || answerContext || [];
  const isLabelledDiagram = answerLabels.length > 0 &&
    answerLabels.every(l => /^[A-Da-d]$/.test((l || '').trim()));
  const labelledInstruction = isLabelledDiagram
    ? `LABELLED DIAGRAM REQUIREMENT: The answer options are the letters ${answerLabels.map(l => l.trim().toUpperCase()).join(', ')}. You MUST draw the diagram with these exact letters placed as labels (with arrows or lines) pointing to specific parts of the diagram. The student must be able to identify which label corresponds to which part. WITHOUT these labels, the question cannot be answered. Place each label clearly and legibly on the diagram.`
    : '';

  let loader = null;
  let timerInt = null;

  // Only show loader if we are in an active render (container provided)
  if (container) {
    loader = document.createElement('div');
    loader.className = 'quiz-ai-drawing-msg';
    loader.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(15,23,42,0.8);color:#a78bfa;font-family:inherit;z-index:10;gap:8px;pointer-events:none;';
    loader.innerHTML = `<div class="shimmer" style="width:40px;height:40px;border-radius:50%;border:3px solid #7c3aed;border-top-color:transparent;animation:spin 1s linear infinite;"></div>
                            <div style="font-weight:600;font-size:0.9rem;">AI is generating diagram...</div>
                            <div class="quiz-ai-timer" style="font-size:0.8rem;opacity:0.8;">0s</div>`;
    container.appendChild(loader);

    let seconds = 0;
    timerInt = setInterval(() => {
      seconds++;
      const tEl = loader.querySelector('.quiz-ai-timer');
      if (tEl) tEl.innerText = `${seconds}s`;
    }, 1000);
  }

  const cleanup = () => { if (timerInt) clearInterval(timerInt); if (loader) loader.remove(); };

  const prompt = `Generate a simple, clean, educational SVG diagram for a Primary 2 student for the keyword: "${keyword}".
${questionText ? `Question: "${questionText}"` : ''}
${correctAnswer ? `The correct answer is: "${correctAnswer}". The diagram MUST be mathematically consistent with this answer.` : ''}
${labelledInstruction}
Rules:
- Use clear lines and high contrast (use a dark theme: lines should be light colors like white, yellow, or cyan on dark/black background).
- Make it visually accurate for a math/science problem.
- CRITICAL: The diagram MUST include ALL measurements, dimensions, labels, and information that a student needs to solve the question. For example:
  * "What is the perimeter?" → label side lengths (e.g. "8 cm")
  * "What is the area?" → label width and height
  * "What angle?" → show angle measurement arc with degree marking
  * "How many?" → draw the exact correct count of objects
  * "What fraction is shaded?" → shade the correct portion and label the total parts
  * "Missing number in sequence?" → show the sequence with the correct surrounding values so the pattern leads to the correct answer
  * "Which labelled part...?" → draw the object with ALL answer letters (${answerLabels.join(', ')}) clearly placed as labels with pointer lines
- ABSOLUTELY NEVER write the correct answer "${correctAnswer || '[answer]'}" directly in the diagram. Only include the INPUT data (dimensions, surrounding values, labels) from which the answer can be calculated.
- ${answerContext.length > 0
      ? 'The answer choices are: ' + answerContext.join(', ') + '. Do NOT write any of these answer values in the SVG.'
      : ''}
- Viewbox should be 200x150 or similar.
- Return ONLY the raw <svg>...</svg> code. No markdown, no triple backticks.`;

  const response = await window.callGemini(prompt, { temperature: 0.2 });
  cleanup();

  if (!response) return null;
  const match = response.match(/<svg[\s\S]*?<\/svg>/i);
  return match ? match[0] : null;
}

// Fetch a batch of questions from Gemini — one per selected subject (round-robin)
async function fetchQuizBatch() {
  // Build subject list — include custom topic if provided
  const customTopic = (quizSettings.customSubject || '').trim();
  // Only default to General Knowledge if NEITHER predefined subjects NOR custom topic selected
  const baseSubjects = quizSettings.subjects.length > 0 ? quizSettings.subjects : (customTopic ? [] : ['General Knowledge']);
  const allSubjects = customTopic ? [...baseSubjects, customTopic] : baseSubjects;
  // Build 5 slots, cycling through all subjects so every one appears
  const slots = Array.from({ length: 5 }, (_, i) => allSubjects[i % allSubjects.length]);

  // Education level lookup
  const eduLevel = quizSettings.eduLevel || 'P2';
  const EDU_LEVELS = window._EDU_LEVELS || [];
  const lvlInfo = EDU_LEVELS.find(l => l.id === eduLevel) || { diff: 'Primary 2 Singapore syllabus', age: 8 };
  const levelDesc = `${eduLevel} — ${lvlInfo.diff}`;

  // ── Randomised topic banks ─────────────────────────────────────────────────
  // Each subject has a large pool of subtopics. Every quiz call shuffles the pool
  // and picks N randomly — so the AI anchors on a different cluster each time.
  const _shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
  const _pick = (arr, n) => _shuffle(arr).slice(0, n);

  const TOPIC_BANKS = {
    'English': [
      'nouns and pronouns', 'action verbs and tenses', 'adjectives and comparatives',
      'adverbs of manner', 'prepositions of place and time', 'conjunctions and connectives',
      'punctuation: commas, full stops, question marks', 'direct and indirect speech',
      'synonyms and antonyms', 'compound words', 'prefixes and suffixes',
      'homophones and homonyms', 'similes and metaphors', 'idioms and phrases',
      'reading comprehension: main idea', 'reading comprehension: inference',
      'sentence types: statements, questions, commands, exclamations',
      'subject-verb agreement', 'plurals: regular and irregular',
      'spelling patterns: silent letters, vowel digraphs', 'contractions and apostrophes',
      'paragraph structure and topic sentences', 'sequencing events in a story',
      'character and setting identification', 'word families and root words',
      'question words: who, what, when, where, why, how', 'articles: a, an, the',
      'dictionary skills and alphabetical order', 'abbreviations and acronyms',
      'letter writing: formal and informal', 'rhyming words and poetry',
    ],
    'Chinese': [
      '颜色词汇 (colours)', '数字 1–100 (numbers)', '动物名称 (animals)',
      '家庭成员 (family members)', '食物与饮料 (food and drinks)', '身体部位 (body parts)',
      '反义词 (antonyms/opposites)', '量词的使用 (measure words)',
      '拼音声调 (pinyin tones)', '笔画顺序 (stroke order)', '偏旁部首 (radicals)',
      '时间表达 (telling time)', '星期和月份 (days and months)', '天气词汇 (weather)',
      '动作动词 (action verbs)', '形容词 (adjectives)', '方位词 (direction words)',
      '交通工具 (transport)', '学校用品 (school items)', '节日 (festivals)',
      '句子结构：主谓宾 (sentence structure)', '疑问词：谁、什么、哪里 (question words)',
      '成语故事 (idioms)', '儿歌与诗词 (rhymes and poems)', '同音字 (homophones)',
      '近义词 (synonyms)', '职业名称 (occupations)', '植物与自然 (nature and plants)',
      '运动项目 (sports)', '形状 (shapes)',
    ],
    'Pure Chinese': [
      '颜色词汇', '数字与计数', '动物分类', '家庭关系与称谓', '食物与烹饪',
      '身体部位与健康', '反义词配对', '量词练习', '时间与日期', '天气与季节',
      '方位与地点', '交通工具', '学校生活与用品', '节日与传统', '动作动词',
      '形容词描述', '疑问句型', '简单成语', '儿歌与韵文', '同音异义字',
      '近义词辨析', '职业与工作', '植物与自然界', '运动与游戏', '基本句型造句',
      '汉字偏旁部首', '笔顺规则', '声调辨别', '数量表达', '颜色与形状',
    ],
    'Math': [
      'addition within 1000', 'subtraction with regrouping', 'multiplication tables 2–12',
      'division with remainders', 'fractions: halves, quarters, thirds',
      'comparing and ordering fractions', 'decimals to 2 places', 'rounding to nearest 10/100',
      'place value: hundreds, thousands, ten-thousands', 'number patterns and sequences',
      'odd and even numbers', 'factors and multiples', 'prime numbers',
      'area of rectangles and squares', 'perimeter of polygons',
      'volume of rectangular prisms', 'angles: acute, obtuse, right, reflex',
      'types of triangles: equilateral, isosceles, scalene', 'properties of 2D shapes',
      'properties of 3D shapes', 'symmetry and lines of symmetry', 'tessellation',
      'reading and drawing bar graphs', 'reading and drawing line graphs', 'pie charts',
      'pictographs and tally charts', 'average (mean)', 'ratio and proportion',
      'percentage: finding % of a quantity', 'money: adding and changing',
      'time: 12-hour and 24-hour clock', 'elapsed time and duration',
      'measuring length in cm and m', 'measuring mass in g and kg',
      'measuring volume in ml and L', 'word problems: multi-step',
      'algebra: simple equations and unknowns', 'speed, distance, time',
    ],
    'Science': [
      'parts of a flowering plant and their functions', 'photosynthesis process',
      'plant reproduction: seeds, pollination, dispersal', 'classifying animals: mammals, reptiles, birds, fish, amphibians, insects',
      'animal adaptations and habitats', 'food chains and food webs',
      'life cycles: frog, butterfly, mosquito, plant', 'human digestive system',
      'human respiratory system', 'human skeletal and muscular system',
      'human reproductive system (age appropriate)', 'healthy diet and nutrition',
      'the five senses and sense organs', 'cells as building blocks of life',
      'states of matter: solid, liquid, gas', 'changes of state: melting, evaporation, condensation, freezing',
      'water cycle', 'properties of materials: strength, flexibility, transparency',
      'magnets: poles, attraction and repulsion', 'electricity: simple circuits and conductors/insulators',
      'light: reflection, shadows, opaque vs transparent', 'heat: conductors and insulators',
      'forces: gravity, friction, push and pull', 'simple machines: lever, pulley, inclined plane',
      'the solar system: planets and their order', 'the moon: phases and orbit',
      'day and night cycle and Earth rotation', 'weather and climate',
      'natural disasters: earthquakes, volcanoes, tsunamis', 'rocks and the rock cycle',
      'pollution: air, water, land', 'recycling and environmental conservation',
      'microorganisms: bacteria, viruses, fungi', 'ecosystems and biodiversity',
    ],
    'General Knowledge': [
      'capitals of countries in Asia', 'capitals of countries in Europe',
      'world oceans and continents', 'famous landmarks and monuments',
      'flags of countries', 'currencies of countries',
      'famous explorers and discoveries', 'ancient civilisations: Egypt, Greece, Rome, China',
      'world records: tallest, longest, largest', 'major world religions and their symbols',
      'famous scientists and their inventions', 'Nobel Prize history',
      'Olympics: sports and host cities', 'FIFA World Cup facts',
      'famous painters and artworks', 'famous composers and musicians',
      'world leaders and governments', 'United Nations and international organisations',
      'Singapore history and landmarks', 'ASEAN member countries',
      'endangered species and conservation', 'space exploration milestones',
      'famous literary characters and books', 'major world wars: causes and key events',
      'human rights and the UN Declaration', 'inventions that changed the world',
      'popular sports rules and equipment', 'world languages and number of speakers',
      'geography: longest rivers, highest mountains', 'natural wonders of the world',
    ],
  };

  // For each subject slot, build a randomised hint using 6 randomly picked subtopics
  const _buildHint = (subject) => {
    const bank = TOPIC_BANKS[subject];
    if (!bank) {
      return `CUSTOM TOPIC: "${subject}" — this question MUST be exclusively about ${subject}. Every aspect of the question and all answer choices must relate directly to ${subject}. Do NOT generate questions about unrelated subjects.`;
    }
    const picked = _pick(bank, 6).join(', ');

    const prefixes = {
      'Pure Chinese': 'PURE MANDARIN CHINESE — CRITICAL: Write EVERY question AND every answer choice ENTIRELY in Simplified Chinese characters. Absolutely NO English, NO pinyin ever. Focus specifically on these subtopics this quiz:',
      'Chinese': 'Chinese language (Mandarin). Focus specifically on these subtopics this quiz:',
    };
    const prefix = prefixes[subject] || `${subject}. Focus specifically on these subtopics this quiz:`;
    return `${prefix} ${picked}.`;
  };

  const slotDescriptions = slots
    .map((s, i) => `  Question ${i + 1}: subject = "${s}" (${_buildHint(s)})`)
    .join('\n');


  const usedList = quizAskedQuestions.length > 0
    ? `\n\nNEVER repeat or paraphrase any of these already-asked questions:\n${quizAskedQuestions.slice(-120).map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : '';

  // Content type instructions
  const types = quizSettings.contentTypes || ['text'];
  const hasText = types.includes('text');
  const hasImage = types.includes('image');
  const imageOnly = hasImage && !hasText;
  let mediumRule = '';
  if (hasText && !hasImage) {
    mediumRule = `CONTENT FORMAT — TEXT ONLY: All questions and all answer choices must be plain text.`;
  } else if (imageOnly) {
    mediumRule = `CONTENT FORMAT — IMAGE ONLY: This is the most important rule in the entire prompt. EVERY SINGLE one of the 5 questions MUST use an image — either in the question box or in the answer cards. It is STRICTLY FORBIDDEN to generate a word problem, an arithmetic equation, a grammar question, or any question that could be answered without looking at a picture. ONLY generate questions that are genuinely visual: identifying objects, animals, shapes, flags, scenes, colours, comparing diagrams. Step 1 does NOT apply — skip it entirely for all 5 questions.`;
  } else {
    mediumRule = `CONTENT FORMAT — MIXED: Some questions are text-only, some are image-based. Use your judgment per question.`;
  }

  const imageKeywordInstruction = hasImage
    ? `
- IMAGE PLACEMENT — follow this 3-step decision for EVERY question:

  STEP 1: Does this question need any image?
${imageOnly
      ? `    IMAGE ONLY MODE — SKIP STEP 1 ENTIRELY. Every question MUST have an image.
    Do NOT generate word problems or pure arithmetic. Only generate questions that are visual
    (identifying objects/animals/flags/shapes/scenes). Proceed directly to Step 2 or Step 3.`
      : `    Skip images (text-only question) for:
      * Word problems fully described in text ("Mr Tan bought 5.85 kg of apples...")
      * Pattern/sequence problems described in text ("Figure 1 has 1 square, Figure 2 has 3...")
      * Grammar, vocabulary, spelling, abstract reasoning
      * English: If the question is about matching sounds/phonetics, use "Which word rhymes with [word]?" instead of "word family".
      * Pure arithmetic or algebra (fractions, decimals, equations)
      * ANY question where the image would be decorative and unrelated to answering`}

  STEP 2 (Visual in Question): Use ONLY for "Look at this [object]" or "How many [objects] are there?".
    - FORBIDDEN: NEVER use Step 2 for Fractions, Decimals, or "Which of these..." comparisons.
    - Set 'questionImageKeyword'. Answers MUST be text-only.

  STEP 3 (Visual in Answers): MANDATORY for ALL comparison questions ("Which of these...?", "Identify the...").
    - MANDATORY for: Fractions, Decimals, Geometry shapes.
    - DO NOT set 'questionImageKeyword'. Every answer MUST have an 'imageKeyword'.

- CRITICAL XOR RULE: NEVER generate both 'questionImageKeyword' AND answer 'imageKeyword' in the same question. If one is present, the other MUST be null/absent.

- KEYWORD QUALITY: imageKeyword MUST be a short English noun phrase (2-5 words max). NEVER put a sentence or description in imageKeyword.
  - Good: "analog clock face", "Singapore flag", "labrador retriever", "upward arrow", "red apple".
  - Bad: "a picture of a downward arrow", "图片", "figure", "math problem", "photo of clock".
  - For Step 3 answers: the 'imageKeyword' field is MANDATORY on every answer object. If you cannot find a suitable imageKeyword, choose a different question type.
  - NEVER describe the image in the 'text' field — 'text' is the ANSWER LABEL only (e.g. "Australia", "是", "True"). The 'imageKeyword' is the search term.
`
    : '';

  // JSON templates — note: in image mode the AI may choose text-only (no image fields) per step 1 above.
  // We provide all three template shapes so the AI can use the correct one per question.
  const answerTemplateWithImg = `{"id":"1","text":"[answer]","imageKeyword":"[kw]"},{"id":"2","text":"[answer]","imageKeyword":"[kw]"},{"id":"3","text":"[answer]","imageKeyword":"[kw]"},{"id":"4","text":"[answer]","imageKeyword":"[kw]"}`;
  const answerTemplateTextOnly = `{"id":"1","text":"[answer]"},{"id":"2","text":"[answer]"},{"id":"3","text":"[answer]"},{"id":"4","text":"[answer]"}`;

  // Odd question: questionImageKeyword set, answers text-only
  const questionTemplateImgInQ = `{"question":"[text]","questionImageKeyword":"[kw]","answers":[${answerTemplateTextOnly}],"correctId":"1"}`;
  // Even question: no questionImageKeyword, answers have imageKeyword
  const questionTemplateImgInA = `{"question":"[text]","answers":[${answerTemplateWithImg}],"correctId":"2"}`;
  // Text-only question (no images at all — correct choice for word problems)
  const questionTemplateText = `{"question":"[text]","answers":[${answerTemplateTextOnly}],"correctId":"1"}`;

  // In image mode: alternate ODD/EVEN as default, but the AI may override to text-only per step 1
  // In IMAGE ONLY mode: force ALL questions to ODD pattern (every question has an image stimulus)
  const questionTemplate = hasImage
    ? (imageOnly
      ? `${questionTemplateImgInQ},${questionTemplateImgInA},${questionTemplateImgInQ},${questionTemplateImgInA},${questionTemplateImgInQ}`
      : `${questionTemplateImgInQ},${questionTemplateImgInA},${questionTemplateImgInQ},${questionTemplateImgInA},${questionTemplateImgInQ}`)
    : `${questionTemplateText},${questionTemplateText},${questionTemplateText},${questionTemplateText},${questionTemplateText}`;

  const prompt = `You are an educational quiz generator aligned to the Singapore school curriculum.
Education Level: ${levelDesc}
Generate exactly 5 multiple-choice questions at this exact difficulty. Each question MUST match its assigned subject:
${slotDescriptions}${usedList}

DIVERSITY: Each question MUST be on a DIFFERENT topic/concept within its subject. Vary the question format (fill-in-the-blank, identify, compare, solve, sequence, true-concept, application). Avoid generic or common questions — surprise the student with creative, unusual angles on each topic.

${mediumRule}

CRITICAL OUTPUT RULES:
- Return ONLY a raw JSON object. No markdown, no explanation, no backtick wrapper.
- JSON must be 100% valid. All string values must contain only simple characters.
- Do NOT use double quotes inside string values. Rephrase to avoid them.
- Strictly match education level ${eduLevel}.
- Chinese: Topic FIRST, then question word.
- ALWAYS generate exactly 4 answer choices per question. NEVER generate 2 or 3 answers. NEVER use binary yes/no or true/false format. Always provide 4 distinct plausible options.
- MATH QUESTIONS WITH IMAGES: Math questions MUST ONLY use Step 2 format (image in question, text-only answers). NEVER put images in Math answer boxes. The questionImageKeyword for Math MUST be a DETAILED diagram description that includes ALL exact dimensions, values, and layout needed to solve the question. Examples:
  * Instead of "rectangle", write "rectangle 8cm wide 5cm tall"
  * Instead of "number line", write "number line showing 1.0 1.02 ? 1.06 1.08 with ? at position 3"
  * Instead of "shaded shape", write "outer rectangle 12cm x 8cm with inner rectangle 6cm x 4cm shaded"
  * Instead of "bar graph", write "bar graph with values Red=5 Blue=8 Green=3 Yellow=6"
  The SVG generator will use this description to draw an EXACT, mathematically consistent diagram. Math answers must always be text-only numbers or words.
- SCIENCE QUESTIONS WITH DIAGRAMS: For Science questions that need a diagram (circuits, water cycle, solar system, food chain, life cycle, etc.), use Step 2 format (image in question, text-only answers). The questionImageKeyword MUST be a DETAILED description of the diagram. Examples:
  * Instead of "circuit", write "simple circuit with battery, closed switch, bulb, and wires connected in a loop"
  * Instead of "water cycle", write "water cycle diagram showing evaporation from ocean, condensation in clouds, precipitation as rain"
  * Instead of "food chain", write "food chain: grass arrow to grasshopper arrow to frog arrow to snake arrow to eagle"
  * Instead of "solar system", write "solar system showing Sun, Mercury, Venus, Earth, Mars in order with orbits"
  For real-world Science subjects (animals, plants, body parts), use Pixabay photos instead.
- COUNTING QUESTIONS: NEVER use questionImageKeyword for counting questions about real-world objects (apples, animals, people, etc.) because sourced photos show unpredictable quantities. Counting questions MUST be either: (a) text-only (describe the scenario in words), or (b) use abstract shapes as questionImageKeyword (circles, dots, stars shape, blocks) which will be rendered as precise diagrams. NEVER ask "How many X are in the picture?" with a real-world keyword.
- FLAG / COUNTRY QUESTIONS: Flag and country identification questions MUST use Step 3 (images in answers). NEVER put a flag or country image in the question box — that gives away the answer. Each answer MUST have an imageKeyword. For flag questions use "[Country] flag" as imageKeyword. For country questions use a representative keyword like a famous landmark, iconic food, or scenery (e.g. "Eiffel Tower" for France, "Mount Fuji" for Japan, "pizza" for Italy).
- CHINESE CHARACTER IMAGE CONSISTENCY: If you generate a Chinese character recognition question with a questionImageKeyword (e.g. the question asks "Is this character X?"), the questionImageKeyword MUST be the SAME character that the question asks about. The correctId must logically match — if the image shows X and the question asks "Is this X?", the correct answer must be "yes/是". Do NOT set the imageKeyword to a different character than what the question references.${imageKeywordInstruction}

Return exactly this JSON (replace [text], [answer], [kw] with real values — follow the image-XOR rule strictly):
{"questions":[${questionTemplate}]}`;


  // Secure proxy call — key lives in Firebase Secret Manager, never in the browser
  console.log('[Quiz] fetchQuizBatch — subjects:', allSubjects, '| level:', eduLevel, '| types:', types);


  let text = await window.callGemini(prompt, { temperature: 0.95 });
  if (!text) throw new Error('AI returned no content');
  const parsed = extractJSON(text);
  if (!parsed) throw new Error('AI returned malformed data');

  const batch = Array.isArray(parsed) ? parsed : (parsed.questions || []);
  if (!batch.length) throw new Error('Empty batch from AI');
  // Tag each question with its assigned subject from the slots
  batch.forEach((q, i) => { if (q) q._subject = slots[i % slots.length]; });

  // ── Post-generation sanitization ─────────────────────────────────────
  for (let qi = batch.length - 1; qi >= 0; qi--) {
    const q = batch[qi];
    // Reject binary/true-false questions — replace with fallback bank question
    if (q.answers && q.answers.length < 4) {
      const binaryWords = /^(true|false|yes|no|correct|incorrect|right|wrong|是|不是|对|错|正确|不正确)$/i;
      const allBinary = q.answers.every(a => binaryWords.test((a.text || '').trim()));
      if (allBinary) {
        console.warn('[Quiz] Replacing binary question:', q.question);
        batch[qi] = pickFromBank();
        continue;
      }
      // Non-binary but fewer than 4 — pad with placeholder answers
      while (q.answers.length < 4) {
        const padId = String(q.answers.length + 1);
        q.answers.push({ id: padId, text: `Option ${padId}` });
      }
    }
    // Also catch 4-answer true/false disguised questions
    if (q.answers && q.answers.length >= 4) {
      const texts = q.answers.map(a => (a.text || '').toLowerCase().trim());
      const hasTF = texts.some(t => /^(true|false|yes|no|是|不是|对|错)$/.test(t));
      if (hasTF) {
        console.warn('[Quiz] Replacing true/false-style question:', q.question);
        batch[qi] = pickFromBank();
        continue;
      }
    }
    // ── Flag/country → Step 3 conversion ──────────────────────────────
    // Flag and country questions must ALWAYS use images in answers (Step 3),
    // never in the question box (which gives away the answer).
    const qLower = (q.question || '').toLowerCase();
    const isFlagQ = qLower.includes('flag');
    const isCountryQ = /\b(country|countries|nation|capital)\b/i.test(qLower);
    if ((isFlagQ || isCountryQ) && q.questionImageKeyword && q.answers) {
      console.warn('[Quiz] Converting flag/country question to Step 3:', q.question);
      delete q.questionImageKeyword;
      // Ensure each answer has an appropriate imageKeyword
      q.answers.forEach(a => {
        if (!a.imageKeyword) {
          const ansText = (a.text || '').trim();
          if (isFlagQ) {
            // For flag questions: search for the country's flag
            a.imageKeyword = ansText + ' flag';
          } else {
            // For country questions: use the country name as keyword
            // Pixabay/Wikimedia will find landmarks, scenery, etc.
            a.imageKeyword = ansText;
          }
        }
      });
    }

    // ── Counting questions + real-world images guard ────────────────────
    // "How many apples in the picture?" with a questionImageKeyword is broken
    // because Pixabay returns unpredictable quantities. Strip the image and
    // make it text-only, or keep it only if the keyword is an abstract shape.
    const isCountingQ = /how many|几个|几只|几条|几块|数一数|count/i.test(qLower);
    if (isCountingQ && q.questionImageKeyword) {
      const kwLower = (q.questionImageKeyword || '').toLowerCase();
      const isAbstractKw = /^(circle|dot|star|block|cube|square|triangle|shape|line|arrow|coin|dice|group|set)s?$/.test(kwLower);
      if (!isAbstractKw) {
        console.warn('[Quiz] Stripping image from real-world counting question:', q.question);
        delete q.questionImageKeyword;
        // Remove "in the picture" / "图片里" / "Look at the picture" from question text
        q.question = (q.question || '')
          .replace(/[。，]?\s*(看图[。，]?|图片里|Look at the picture\.?\s*)/gi, '')
          .replace(/\s*in (the|this) (picture|image|photo)\s*/gi, ' ')
          .trim();
      }
    }

    // ── Math questions: force Step 2 only (image in Q, text answers) ──
    // Math should never have images in answers — strip them.
    const isMathQ = /^(math|mathematics)$/i.test(q._subject || '') ||
      /^(math|mathematics)$/i.test(q.subject || '') ||
      /\b(fraction|decimal|equivalent|perimeter|area|arithmetic|calculate|equation|multiply|divide|angle|symmetry|geometry|number line)\b/i.test(qLower);
    if (isMathQ && q.answers) {
      let hadAnswerImages = false;
      q.answers.forEach(a => {
        if (a.imageKeyword) { hadAnswerImages = true; delete a.imageKeyword; }
      });
      if (hadAnswerImages) {
        console.warn('[Quiz] Stripped answer images from Math question (must be text-only):', q.question);
      }
    }

    // ── Step 2 → Step 3 auto-correction ─────────────────────────────────
    // Comparison questions ("Which X is Y?", "Identify the...", "Where is...")
    // must NOT show the answer image in the question box (gives it away).
    // Convert: remove questionImageKeyword, add imageKeyword to each answer.
    // "Which of these X?" → Step 3 (images in answers)
    // BUT "Which sport uses THIS equipment?" → Step 2 (image in question, text answers)
    // Demonstrative pronouns (this/that/these) refer to something shown in the question image.
    const hasDemonstrative = /\b(this|that|these)\b/i.test(qLower) ||
      /\bthe (picture|image|photo|diagram)\b/i.test(qLower);
    const isComparisonQ = /\b(which|identify|where)\b/i.test(qLower) &&
      !isMathQ &&
      !hasDemonstrative &&
      !qLower.includes('how many') && !qLower.includes('count') &&
      !qLower.includes('look at') && !qLower.includes('what is shown');
    if (isComparisonQ && q.questionImageKeyword && q.answers) {
      const hasAnswerImages = q.answers.some(a => a.imageKeyword);
      if (!hasAnswerImages) {
        console.warn('[Quiz] Converting comparison question from Step 2→3:', q.question);
        // Use each answer's text as its own image keyword
        q.answers.forEach(a => { a.imageKeyword = a.text; });
        delete q.questionImageKeyword;
      }
    }

    // ── Shuffle answers so correct answer isn't always in position 1 ───
    if (q.answers && q.answers.length > 1 && q.correctId) {
      // Fisher-Yates shuffle
      const arr = [...q.answers];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      // Find where the correct answer ended up and update correctId
      const newIdx = arr.findIndex(a => String(a.id) === String(q.correctId));
      // Re-assign sequential IDs 1-4 and update correctId
      arr.forEach((a, i) => { a.id = String(i + 1); });
      q.correctId = String(newIdx + 1);
      q.answers = arr;
    }
  }

  // Kick off background visual pre-loading
  preLoadBatchVisuals(batch);

  return batch;
}

// ── Wikimedia Commons image search helper ─────────────────────────────────
// Searches Commons for JPEG/PNG photos only — explicitly rejects SVGs, diagrams,
// worksheets, and tiny thumbnails so we always get real photographic content.
const _wikiImageCache = {};
async function fetchWikiImage(keyword) {
  if (!keyword) return null;
  const kw = keyword.toLowerCase().trim();
  if (_wikiImageCache[kw] !== undefined) return _wikiImageCache[kw];

  // Context map: expand ambiguous single terms to more specific photo queries
  const contextMap = {
    'triangle': 'equilateral triangle shape',
    'circle': 'circle shape',
    'square': 'geometric square shape',
    'rectangle': 'rectangle shape',
    'hexagon': 'hexagon geometry shape',
    'pentagon': 'pentagon geometry shape',
    'octagon': 'octagon geometry shape',
    'star': 'five pointed star shape',
    'heart': 'red heart symbol',
    'cube': 'cube 3d shape diagram',
    'sphere': 'sphere 3d shape diagram',
    'cylinder': 'cylinder 3d shape diagram',
    'pyramid': 'pyramid 3d shape diagram',
    'cone': 'cone 3d shape diagram',
    'flowers': 'colorful flowers garden photo',
    'flower': 'flower blossom photo',
    'apple': 'red apple fruit photo',
    'dog': 'dog photo',
    'cat': 'cat photo',
    'fish': 'fish swimming photo',
    'bird': 'bird photo',
    'tree': 'tree nature photo',
    'sun': 'sun sky photo',
    'rain': 'rain drops photo',
    'cloud': 'clouds sky photo',
    // Geometry/Math context bias
    'ruler': 'ruler measurement diagram',
    'number line': 'number line mathematics diagram',
    'protractor': 'protractor geometry diagram',
    'pentagon': 'pentagon geometry shape',
    'hexagon': 'hexagon geometry shape',
    'octagon': 'octagon geometry shape',
    'cylinder': 'cylinder 3d shape diagram',
    'sphere': 'sphere 3d shape diagram',
    'pyramid': 'pyramid 3d shape diagram',
    'cube': 'cube 3d shape diagram',
    'cone': 'cone 3d shape diagram',
    'analog clock': 'analog clock face diagram',
    'clock face': 'analog clock face diagram',
    'clock': 'analog clock face diagram',
    '5 identical squares': 'square grid diagram',
    'identical squares': 'square grid diagram',
    'square': 'geometric square shape'
  };
  const baseQuery = contextMap[kw] || kw;

  // Try fetching with a given query string. Returns a usable thumb URL or null.
  async function _trySearch(query) {
    // Request MIME type + dimensions so we can filter quality
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=600&format=json&origin=*`;
    const resp = await fetch(apiUrl);
    const data = await resp.json();
    const pages = data?.query?.pages;
    if (!pages) return null;

    // Build a scored candidate list.
    // Accept JPEG/PNG photos AND SVG diagrams — Wikimedia renders SVG→PNG via thumburl.
    // Educational tools (protractors, number lines, shapes) are primarily SVG on Commons.
    const candidates = Object.values(pages)
      .map(p => {
        const ii = p?.imageinfo?.[0];
        if (!ii) return null;
        const mime = (ii.mime || '').toLowerCase();
        const url = ii.thumburl || ii.url || '';
        const w = ii.width || 0;
        if (!url) return null;
        const isPhoto = mime.startsWith('image/jpeg') || mime.startsWith('image/png');
        const isSvg = mime.startsWith('image/svg');
        if (!isPhoto && !isSvg) return null;  // reject PDF, OGG, audio, video
        // For general subjects (landmarks, animals, objects) PREFER real photos.
        // SVGs are only good for educational diagrams — give them low priority here.
        if (isPhoto && w < 200) return null;
        const score = isPhoto ? w : 50; // photos win by pixel width; SVGs are last resort
        return { url, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.url || null;
  }

  try {
    // Attempt 1: exact keyword
    let result = await _trySearch(baseQuery);

    // Attempt 2: add 'photo' suffix to bias towards real photographs
    if (!result) result = await _trySearch(baseQuery + ' photo');

    // Attempt 3: try a simplified keyword (drop words like 'of', 'the', 'famous')
    if (!result) {
      const simplified = baseQuery
        .replace(/\b(famous|the|of|a|an|historical|ancient|modern)\b/gi, '')
        .replace(/\s+/g, ' ').trim();
      if (simplified && simplified !== baseQuery) {
        result = await _trySearch(simplified + ' photo');
      }
    }

    _wikiImageCache[kw] = result || null;
    return _wikiImageCache[kw];
  } catch (e) {
    _wikiImageCache[kw] = null;
    return null;
  }
}

// ── Built-in question bank (Bank mode + AI error fallback) ────────────────
const QUIZ_FALLBACK_BANK = [
  { subject: 'Pure Chinese', question: '下面哪个是动物？', answers: [{ id: '1', text: '苹果' }, { id: '2', text: '狗' }, { id: '3', text: '桌子' }, { id: '4', text: '书' }], correctId: '2' },
  { subject: 'Pure Chinese', question: '什么颜色是天空？', answers: [{ id: '1', text: '红色' }, { id: '2', text: '绿色' }, { id: '3', text: '蓝色' }, { id: '4', text: '黄色' }], correctId: '3' },
  { subject: 'Pure Chinese', question: '哪个数字最大？', answers: [{ id: '1', text: '三' }, { id: '2', text: '七' }, { id: '3', text: '五' }, { id: '4', text: '二' }], correctId: '2' },
  { subject: 'Pure Chinese', question: '妈妈的妈妈叫什么？', answers: [{ id: '1', text: '阿姨' }, { id: '2', text: '姐姐' }, { id: '3', text: '奶奶' }, { id: '4', text: '外婆' }], correctId: '4' },
  { subject: 'Pure Chinese', question: '什么动物会飞？', answers: [{ id: '1', text: '狗' }, { id: '2', text: '猫' }, { id: '3', text: '鸟' }, { id: '4', text: '鱼' }], correctId: '3' },
  { subject: 'Pure Chinese', question: '苹果是什么颜色的？', answers: [{ id: '1', text: '蓝色' }, { id: '2', text: '红色' }, { id: '3', text: '黑色' }, { id: '4', text: '紫色' }], correctId: '2' },
  { subject: 'Pure Chinese', question: '哪个是水果？', answers: [{ id: '1', text: '桌子' }, { id: '2', text: '椅子' }, { id: '3', text: '香蕉' }, { id: '4', text: '书包' }], correctId: '3' },
  { subject: 'Pure Chinese', question: '"\u5927"的反义词是什么？', answers: [{ id: '1', text: '快' }, { id: '2', text: '长' }, { id: '3', text: '高' }, { id: '4', text: '小' }], correctId: '4' },
  { subject: 'Pure Chinese', question: '太阳什么时候出来？', answers: [{ id: '1', text: '晚上' }, { id: '2', text: '早上' }, { id: '3', text: '下午' }, { id: '4', text: '凌晨' }], correctId: '2' },
  { subject: 'Pure Chinese', question: '水是什么颜色？', answers: [{ id: '1', text: '红色' }, { id: '2', text: '蓝色' }, { id: '3', text: '无色' }, { id: '4', text: '黄色' }], correctId: '3' },
  { subject: 'English', question: 'Which word is a noun?', answers: [{ id: '1', text: 'Run' }, { id: '2', text: 'Happy' }, { id: '3', text: 'Apple' }, { id: '4', text: 'Quickly' }], correctId: '3' },
  { subject: 'English', question: "What is the plural of 'child'?", answers: [{ id: '1', text: 'Childs' }, { id: '2', text: 'Children' }, { id: '3', text: 'Childes' }, { id: '4', text: "Child's" }], correctId: '2' },
  { subject: 'English', question: 'Which sentence is correct past tense?', answers: [{ id: '1', text: 'She runned fast' }, { id: '2', text: 'She run fast' }, { id: '3', text: 'She ran fast' }, { id: '4', text: 'She runs fast' }], correctId: '3' },
  { subject: 'English', question: "What does 'enormous' mean?", answers: [{ id: '1', text: 'Very small' }, { id: '2', text: 'Very fast' }, { id: '3', text: 'Very large' }, { id: '4', text: 'Very loud' }], correctId: '3' },
  { subject: 'English', question: 'What punctuation ends a question?', answers: [{ id: '1', text: 'Full stop' }, { id: '2', text: 'Comma' }, { id: '3', text: 'Question mark' }, { id: '4', text: 'Exclamation mark' }], correctId: '3' },
  { subject: 'English', question: "Synonym for 'happy'?", answers: [{ id: '1', text: 'Sad' }, { id: '2', text: 'Angry' }, { id: '3', text: 'Joyful' }, { id: '4', text: 'Tired' }], correctId: '3' },
  { subject: 'English', question: "What does 'curious' mean?", answers: [{ id: '1', text: 'Bored' }, { id: '2', text: 'Eager to know things' }, { id: '3', text: 'Very tired' }, { id: '4', text: 'Very hungry' }], correctId: '2' },
  { subject: 'English', question: "Antonym of 'hot'?", answers: [{ id: '1', text: 'Warm' }, { id: '2', text: 'Boiling' }, { id: '3', text: 'Cold' }, { id: '4', text: 'Spicy' }], correctId: '3' },
  { subject: 'Chinese', question: 'What does "ni hao" (你好) mean?', answers: [{ id: '1', text: 'Good night' }, { id: '2', text: 'Thank you' }, { id: '3', text: 'Hello' }, { id: '4', text: 'Goodbye' }], correctId: '3' },
  { subject: 'Chinese', question: 'How do you say "cat" in Mandarin?', answers: [{ id: '1', text: 'Gou (狗)' }, { id: '2', text: 'Mao (猫)' }, { id: '3', text: 'Niao (鸟)' }, { id: '4', text: 'Yu (鱼)' }], correctId: '2' },
  { subject: 'Chinese', question: 'What does "xie xie" (谢谢) mean?', answers: [{ id: '1', text: 'Sorry' }, { id: '2', text: 'Please' }, { id: '3', text: 'Hello' }, { id: '4', text: 'Thank you' }], correctId: '4' },
  { subject: 'Chinese', question: 'Colour of "hong se" (红色)?', answers: [{ id: '1', text: 'Blue' }, { id: '2', text: 'Green' }, { id: '3', text: 'Red' }, { id: '4', text: 'Yellow' }], correctId: '3' },
  { subject: 'Chinese', question: 'What does "da" (大) mean?', answers: [{ id: '1', text: 'Small' }, { id: '2', text: 'Big' }, { id: '3', text: 'Fast' }, { id: '4', text: 'Old' }], correctId: '2' },
  { subject: 'Chinese', question: 'What number is "wu" (五)?', answers: [{ id: '1', text: '3' }, { id: '2', text: '4' }, { id: '3', text: '5' }, { id: '4', text: '6' }], correctId: '3' },
  { subject: 'Math', question: 'What is 5 + 3?', answers: [{ id: '1', text: '6' }, { id: '2', text: '7' }, { id: '3', text: '8' }, { id: '4', text: '9' }], correctId: '3' },
  { subject: 'Math', question: 'How many sides does a triangle have?', answers: [{ id: '1', text: '2' }, { id: '2', text: '3' }, { id: '3', text: '4' }, { id: '4', text: '5' }], correctId: '2' },
  { subject: 'Math', question: 'What is 4 x 3?', answers: [{ id: '1', text: '10' }, { id: '2', text: '11' }, { id: '3', text: '12' }, { id: '4', text: '14' }], correctId: '3' },
  { subject: 'Math', question: 'Largest: 47, 74, 54?', answers: [{ id: '1', text: '47' }, { id: '2', text: '74' }, { id: '3', text: '54' }, { id: '4', text: '45' }], correctId: '2' },
  { subject: 'Science', question: 'How many legs does a spider have?', answers: [{ id: '1', text: '4' }, { id: '2', text: '6' }, { id: '3', text: '8' }, { id: '4', text: '10' }], correctId: '3' },
  { subject: 'Science', question: 'Planet closest to the Sun?', answers: [{ id: '1', text: 'Earth' }, { id: '2', text: 'Venus' }, { id: '3', text: 'Mars' }, { id: '4', text: 'Mercury' }], correctId: '4' },
  { subject: 'Science', question: 'What do plants need to make food?', answers: [{ id: '1', text: 'Darkness' }, { id: '2', text: 'Sunlight' }, { id: '3', text: 'Salt' }, { id: '4', text: 'Sugar' }], correctId: '2' },
  { subject: 'General Knowledge', question: 'Mix red + blue =?', answers: [{ id: '1', text: 'Green' }, { id: '2', text: 'Purple' }, { id: '3', text: 'Orange' }, { id: '4', text: 'Yellow' }], correctId: '2' },
  { subject: 'General Knowledge', question: 'Days in a week?', answers: [{ id: '1', text: '5' }, { id: '2', text: '6' }, { id: '3', text: '7' }, { id: '4', text: '8' }], correctId: '3' },
  { subject: 'General Knowledge', question: 'Country with the Great Wall?', answers: [{ id: '1', text: 'Japan' }, { id: '2', text: 'India' }, { id: '3', text: 'China' }, { id: '4', text: 'Korea' }], correctId: '3' },
];
function pickFromBank() {
  const activeSubs = quizSettings.subjects;
  const bySubject = QUIZ_FALLBACK_BANK.filter(f => activeSubs.includes(f.subject));
  const pool_all = bySubject.length > 0 ? bySubject : QUIZ_FALLBACK_BANK;
  const unused = pool_all.filter(f => !quizAskedQuestions.includes(f.question));
  const pool = unused.length > 0 ? unused : pool_all;
  return { ...pool[Math.floor(Math.random() * pool.length)], _source: 'fallback' };
}

async function generateQuizQuestion() {
  const grid = document.getElementById('quiz-answers-grid');
  const questionEl = document.getElementById('quiz-display-question');
  if (!grid || !questionEl) return;

  // ── BANK MODE: skip AI entirely ─────────────────────────────────────────
  if (quizSettings.questionSource === 'bank') {
    if (quizQuestionQueue.length > 0) {
      quizCurrentQ = quizQuestionQueue.shift();
    } else {
      quizCurrentQ = pickFromBank();
      // Pre-load more into queue for smooth navigation
      for (let i = 0; i < 4; i++) quizQuestionQueue.push(pickFromBank());
    }
    if (quizCurrentQ?.question && !quizAskedQuestions.includes(quizCurrentQ.question)) {
      quizAskedQuestions.push(quizCurrentQ.question);
      if (quizAskedQuestions.length > 150) quizAskedQuestions.shift();
      saveQuizAsked();
    }
    quizHistory.push(quizCurrentQ);
    quizHistoryIdx = quizHistory.length - 1;
    updateQuizNavButtons();
    renderQuizBoard();
    return;
  }

  // ── AI MODE ───────────────────────────────────────────────────────────────────────

  // If queue has items, use next one immediately (no loading flicker)
  if (quizQuestionQueue.length > 0) {
    quizCurrentQ = quizQuestionQueue.shift();
    // Push to history
    quizHistory.push(quizCurrentQ);
    quizHistoryIdx = quizHistory.length - 1;
    updateQuizNavButtons();
    renderQuizBoard();
    // Kick off background refill when queue gets low
    if (quizQuestionQueue.length === 0) {
      fetchQuizBatch().then(batch => {
        batch.forEach(q => {
          q._source = 'ai';
          quizQuestionQueue.push(q);
          if (!quizAskedQuestions.includes(q.question)) {
            quizAskedQuestions.push(q.question);
            if (quizAskedQuestions.length > 150) quizAskedQuestions.shift();
          }
        });
        saveQuizAsked();
      }).catch(console.error);
    }
    return;
  }
  // Queue empty — check if intro pre-fetch is already running
  if (_introPrefetchPromise) {
    questionEl.textContent = 'Thinking...';
    const prefetchedBatch = await _introPrefetchPromise.catch(() => null);
    _introPrefetchPromise = null; // consume it
    if (prefetchedBatch && prefetchedBatch.length > 0) {
      prefetchedBatch.forEach(q => {
        q._source = 'ai';
        if (q?.question && !quizAskedQuestions.includes(q.question)) {
          quizAskedQuestions.push(q.question);
          if (quizAskedQuestions.length > 150) quizAskedQuestions.shift();
        }
        quizQuestionQueue.push(q);
      });
      saveQuizAsked();
      quizCurrentQ = quizQuestionQueue.shift();
      quizHistory.push(quizCurrentQ);
      quizHistoryIdx = quizHistory.length - 1;
      updateQuizNavButtons();
      renderQuizBoard();
      return;
    }
  }

  questionEl.textContent = 'Thinking...';
  const startTime = Date.now();

  // Build a human-readable summary of what's being generated
  const loadSubjects = (() => {
    const custom = (quizSettings.customSubject || '').trim();
    const chips = (quizSettings.subjects || []).join(', ');
    return custom ? `${chips}, ${custom}` : chips;
  })();
  const loadLevel = quizSettings.eduLevel || 'P2';
  const loadTypes = (quizSettings.contentTypes || ['text'])
    .map(t => t === 'text' ? '📝 Text' : '🖼️ Image').join(' + ');

  grid.innerHTML = `
        <div class="quiz-generating col-span-full">
          <div class="quiz-spinner"></div>
          <p class="text-slate-400 text-sm font-medium">Generating questions... <span id="quiz-loading-timer" class="text-violet-400 ml-1">0s</span></p>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px;align-items:center;">
            <p style="font-size:0.7rem;color:#64748b;">📚 <span style="color:#a78bfa">${loadLevel}</span> &nbsp;·&nbsp; ${loadSubjects.split(', ').map(s => `<span style="color:#94a3b8">${s}</span>`).join(' <span style="color:#475569">·</span> ')}</p>
            <p style="font-size:0.7rem;color:#64748b;">Format: <span style="color:#a78bfa">${loadTypes}</span></p>
          </div>
        </div>`;

  const timerInterval = setInterval(() => {
    const timerEl = document.getElementById('quiz-loading-timer');
    if (timerEl) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      timerEl.textContent = `${elapsed}s`;
    }
  }, 1000);

  try {
    const batch = await fetchQuizBatch();
    clearInterval(timerInterval);
    // Record asked questions and persist to localStorage
    batch.forEach(q => {
      q._source = 'ai';
      if (q?.question && !quizAskedQuestions.includes(q.question)) {
        quizAskedQuestions.push(q.question);
        if (quizAskedQuestions.length > 150) quizAskedQuestions.shift();
      }
    });
    saveQuizAsked();
    // Use first; queue the rest
    quizCurrentQ = batch[0];
    quizQuestionQueue = batch.slice(1);
  } catch (err) {
    clearInterval(timerInterval);
    console.error('Quiz generation error:', err);
    // Show error in badge so it's visible without opening DevTools
    const _badgeEl = document.getElementById('quiz-source-badge');
    if (_badgeEl) {
      _badgeEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:0.6rem;font-weight:600;color:#f87171;opacity:0.7;font-family:monospace">AI ERR: ${String(err.message).slice(0, 50)}...</span>
              <button onclick="window.generateQuizQuestion()" style="font-size:0.6rem;background:#ef4444;color:white;border-radius:4px;padding:2px 6px;font-weight:bold;cursor:pointer">Retry AI</button>
            </div>`;
    }
    // Fallback to built-in bank on AI error
    quizCurrentQ = pickFromBank();
  }


  if (quizCurrentQ?.question && !quizAskedQuestions.includes(quizCurrentQ.question)) {
    quizAskedQuestions.push(quizCurrentQ.question);
    if (quizAskedQuestions.length > 150) quizAskedQuestions.shift();
    saveQuizAsked();
  }
  // Push to history
  quizHistory.push(quizCurrentQ);
  quizHistoryIdx = quizHistory.length - 1;
  updateQuizNavButtons();
  renderQuizBoard();
}

function updateQuizNavButtons() {
  const prev = document.getElementById('btn-quiz-prev');
  const next = document.getElementById('btn-quiz-next');
  if (!prev || !next) return;
  prev.disabled = quizHistoryIdx <= 0;
  // Next is always enabled (can always generate a new question forward)
  next.disabled = false;
}

function quizNavPrev() {
  if (quizHistoryIdx <= 0) return;
  quizHistoryIdx--;
  quizCurrentQ = quizHistory[quizHistoryIdx];
  updateQuizNavButtons();
  renderQuizBoard();
}

function quizNavNext() {
  if (quizHistoryIdx < quizHistory.length - 1) {
    // Navigate forward in history (already-fetched question)
    quizHistoryIdx++;
    quizCurrentQ = quizHistory[quizHistoryIdx];
    updateQuizNavButtons();
    renderQuizBoard();
  } else {
    // At the latest — generate a new question
    generateQuizQuestion();
  }
}

function renderQuizBoard() {
  quizRenderGen++;
  const currentGen = quizRenderGen;
  const q = quizCurrentQ;
  if (!q) return;

  const questionEl = document.getElementById('quiz-display-question');
  const grid = document.getElementById('quiz-answers-grid');
  if (!questionEl || !grid) return;

  // Resolve theme for this question (Mixed picks randomly once per question)
  if (quizSettings.theme === 'mixed') {
    const pool = ['normal', 'ben-holly', 'peppa', 'kung-fu-panda'];
    currentQuizTheme = pool[Math.floor(Math.random() * pool.length)];
  } else {
    currentQuizTheme = quizSettings.theme;
  }

  prepareHighlightableText(questionEl, q.question);
  questionEl.dataset.prepared = 'true';

  // Question image: rendered INSIDE questionContainer as a flex-column child,
  // so it appears below the question text and hover naturally contributes to qread bar.
  // First clean up any old image from EITHER location.
  const qSection = questionEl.closest('.quiz-question-section');
  if (qSection) {
    const old1 = qSection.querySelector('.quiz-question-img-wrap');
    if (old1) old1.remove();
  }
  // RUNTIME XOR GUARD: Strict mutual exclusion — image in question OR answers, never both
  const hasAnswerImages = q.answers.some(a => !!a.imageKeyword);
  const hasQuestionImage = !!(quizSettings.contentTypes || []).includes('image') && !!q.questionImageKeyword;

  if (hasAnswerImages && hasQuestionImage) {
    // Question image wins only if explicitly a 'Look at the picture' type
    const qtxtLower = (q.question || '').toLowerCase();
    const questionImageTakesOverride = qtxtLower.includes('look at the picture') ||
      qtxtLower.includes('look at this') ||
      qtxtLower.includes('how many') ||
      qtxtLower.includes('what is shown');
    if (questionImageTakesOverride) {
      // Keep question image, strip all answer images
      console.log('[XOR] Kept questionImage, cleared answer imageKeywords');
      q.answers.forEach(a => { a.imageKeyword = null; });
    } else {
      // Answers win — strip question image
      console.log('[XOR] Kept answer images, cleared questionImageKeyword');
      q.questionImageKeyword = null;
    }
  }

  let _hasQImg = (quizSettings.contentTypes || []).includes('image') && !!q.questionImageKeyword;

  // ── Chinese character question image fix ─────────────────────────────
  // For "这个字怎么读？" / "哪个字是X" / "which character" questions the image
  // should show the EXACT correct character as a clean SVG, not a Pixabay
  // calligraphy photo. Override questionImageKeyword with the correct answer's
  // CJK character so the CJK fast-path in resolveVisual renders it cleanly.
  if (_hasQImg && !hasAnswerImages) {
    const _qtxtChar = (q.question || '');
    const _isCharQuestion =
      _qtxtChar.includes('这个字') || _qtxtChar.includes('哪个字') ||
      _qtxtChar.includes('哪一个字') || _qtxtChar.includes('怎么读') ||
      _qtxtChar.includes('which character') || _qtxtChar.includes('what character');
    if (_isCharQuestion) {
      // Find the correct answer and extract its CJK character(s)
      const _cid = String(q.correctId || (Array.isArray(q.correctAnswerIds) ? q.correctAnswerIds[0] : null) || '');
      const _correctAns = q.answers.find(a => String(a.id) === _cid) || q.answers[0];
      const _cjkMatch = (_correctAns?.text || '').match(/[\u4e00-\u9fff\u3400-\u4dbf]+/);
      if (_cjkMatch) {
        q.questionImageKeyword = _cjkMatch[0]; // e.g. "山" → CJK fast-path SVG
      }
    }
  }

  // Fallback: extract keyword from question text if AI forgot it.
  // CRITICAL: Only run if answers do NOT have images — otherwise we'd re-break XOR.
  if (!_hasQImg && !hasAnswerImages && (quizSettings.contentTypes || []).includes('image')) {
    const qtxt = (q.question || '').toLowerCase();
    // 1. Try patterns: "Look at the [subject]", "Examine the [subject]", "The [subject] below..."
    // Priority capture for "figure made up of..."
    const compositeMatch = qtxt.match(/(?:the|this) (figure|shape) (?:below |shown )?(?:is )?made up of ([^.\?,!]{3,})/i);
    if (compositeMatch) {
      const extracted = compositeMatch[2].trim();
      if (extracted) { q.questionImageKeyword = extracted; _hasQImg = true; }
    }

    if (!_hasQImg) {
      const obsMatch = qtxt.match(/(?:look at|examine|study|observe|shown in|identify the|what is|find the|draw the|sketch the|the) (?:the |this |a |an )?([^.\?,!]{3,})(?: below| shown| indicated| represented)?/i);
      if (obsMatch) {
        let extracted = obsMatch[1].trim();
        // Cleanup trailing noise and generic terms
        extracted = extracted.replace(/\s+(?:shown|below|indicated|represented|is made up of.*|model|models|figure|figures|diagram|diagrams)$/i, '');
        if (extracted) { q.questionImageKeyword = extracted; _hasQImg = true; }
      }
    }
    // 2. If still no keyword, scan for specific educational tools
    if (!_hasQImg) {
      const tools = ['number line', 'protractor', 'ruler', 'pentagon', 'hexagon', 'octagon', 'cylinder', 'sphere', 'pyramid', 'cube', 'cone', 'clock', 'thermometer', 'fraction bar', 'geometry', 'shape', 'identical squares'];
      for (const t of tools) {
        if (qtxt.includes(t)) { q.questionImageKeyword = t; _hasQImg = true; break; }
      }
    }
  }

  // ── Answer imageKeyword fallback extraction ───────────────────────────
  // When image mode is on and answers lack imageKeyword, try to derive one
  // from the answer text. Handles AI-generated text like:
  //   "一个向下箭头的图片" → imageKeyword: "向下箭头"
  //   "a picture of a downward arrow" → imageKeyword: "downward arrow"
  // Also strips category suffixes from display labels ("apple fruit" → label "apple").
  const _stripCategoryTag = (txt) =>
    (txt || '').replace(/\s+(fruit|vegetable|vegetables|animal|animals|shape|shapes|building|buildings|landmark|landmarks|photo|picture|image|color|colour|object|objects|food|plant|plants|flower|flowers)\s*$/i, '').trim();

  if ((quizSettings.contentTypes || []).includes('image') && !_hasQImg) {
    const _extractKwFromText = (txt) => {
      if (!txt) return null;
      // Chinese: "一个X的图片", "X图片", "X图像"
      let m = txt.match(/一个(.+?)(?:的)?图(?:片|像)/);
      if (m) return m[1].trim();
      m = txt.match(/(.+?)(?:的)?图(?:片|像)/);
      if (m && m[1].length < 30) return m[1].trim();
      // English: "a picture of X", "image of X", "photo of X"
      m = txt.match(/(?:a\s+)?(?:picture|image|photo)\s+of\s+(?:a\s+|an\s+)?(.+)/i);
      if (m) return m[1].trim();
      // Short text with no question mark → use as imageKeyword
      if (txt.length <= 30 && !/[?？]/.test(txt)) return txt.trim();
      return null;
    };

    q.answers.forEach(a => {
      if (!a.imageKeyword && a.text) {
        const extracted = _extractKwFromText(a.text);
        if (extracted) {
          a.imageKeyword = extracted;          // full term for image search
          a.text = _stripCategoryTag(extracted); // clean label (strip "fruit" etc.)
        }
      } else if (a.imageKeyword) {
        // imageKeyword already set — just clean the display label
        a.text = _stripCategoryTag(a.text);
      }
    });
  }

  quizSpeakCancel(); // stop any leftover TTS from the previous question
  const _capturedGen = currentGen;
  // TTS is deferred: if qReadEnabled, starts on first hover; if not, fires immediately below.
  let _questionSpoken = false;
  _quizVoiceDelay = 0; // reset for next question
  // Update source badge — left-aligned, discreet
  const badge = document.getElementById('quiz-source-badge');
  if (badge) {
    // Subject tag
    const subjectLabel = q._subject || q.subject || '';
    const subjectTag = subjectLabel
      ? `<span style="font-size:0.6rem;font-weight:700;padding:0.1rem 0.4rem;border-radius:4px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.25);color:#60a5fa;letter-spacing:0.06em;font-family:monospace;margin-right:4px">${subjectLabel}</span>`
      : '';
    // Source tag
    if (q._source === 'ai') {
      badge.innerHTML = subjectTag + '<span style="font-size:0.6rem;font-weight:700;padding:0.1rem 0.4rem;border-radius:4px;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.3);color:#a78bfa;letter-spacing:0.08em;font-family:monospace">AI</span>';
    } else if (q._source === 'fallback') {
      badge.innerHTML = `${subjectTag}
            <span style="font-size:0.6rem;font-weight:700;padding:0.1rem 0.4rem;border-radius:4px;background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.25);color:#d97706;letter-spacing:0.08em;font-family:monospace">FB</span>
            <button onclick="window.forceAIGeneration()" style="font-size:0.6rem;background:rgba(59,130,246,0.2);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);border-radius:4px;padding:2px 6px;font-weight:600;cursor:pointer;transition:all 0.2s" onmouseover="this.style.background='rgba(59,130,246,0.3)'" onmouseout="this.style.background='rgba(59,130,246,0.2)'">Get more questions</button>`;
    } else {
      badge.innerHTML = subjectTag;
    }
  }
  grid.innerHTML = '';

  // ── 2-answer detection (True/False, Yes/No) ──────────────────────────
  // Detect binary questions and reduce to 2 answers for cleaner UX.
  const _isBinaryAnswer = (txt) => {
    const t = (txt || '').toLowerCase().trim();
    return ['true', 'false', 'yes', 'no', 'correct', 'incorrect', 'right', 'wrong',
      '是', '不是', '对', '错', '吗', '正确', '不正确'].some(w => t === w || t.startsWith(w));
  };
  const _qtxt = (q.question || '').toLowerCase();
  const _isBinaryQ =
    // Question phrasing signals a yes/no
    _qtxt.includes('true or false') || _qtxt.includes('yes or no') ||
    _qtxt.includes('吗?') || _qtxt.includes('吗？') ||
    _qtxt.includes('true/false') ||
    // All answers are binary-style words (must ALL be binary, not just 2-answer count)
    (q.answers.length >= 2 && q.answers.every(a => _isBinaryAnswer(a.text)));

  let displayAnswers = q.answers;
  if (_isBinaryQ && q.answers.length > 2) {
    // Keep the correct answer + its best foil.
    // Use String() coercion: AI may return id as number (1) or string ("1").
    const _correctId = String(q.correctId || (Array.isArray(q.correctAnswerIds) ? q.correctAnswerIds[0] : null) || '');
    const correctAns = q.answers.find(a => String(a.id) === _correctId) || q.answers[0];
    const wrongAns = q.answers.find(a => a !== correctAns && _isBinaryAnswer(a.text)) ||
      q.answers.find(a => a !== correctAns);
    displayAnswers = [correctAns, wrongAns].filter(Boolean);
    // Shuffle so correct isn't always first
    if (Math.random() < 0.5) displayAnswers.reverse();
  }
  const isTwoAnswer = displayAnswers.length === 2;

  // Apply grid layout
  grid.className = 'quiz-answers-grid-inner';
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: isTwoAnswer ? '1fr' : '1fr 1fr',
    alignContent: 'stretch',
    justifyContent: 'stretch',
    gap: '16px',
    boxSizing: 'border-box',
    width: '100%',
    minHeight: '0'
  });
  // Reset to let CSS flex:1 fill, then immediately size via JS for accuracy
  grid.style.removeProperty('height');
  // Always reset visibility — qRead logic below will hide them again if needed
  grid.style.opacity = '1';
  grid.style.pointerEvents = 'auto';
  grid.style.transition = '';
  // Fire sizer immediately (before image loads) so grid fills space from the start
  requestAnimationFrame(() => _sizeAnswerGrid());

  // _qReadDone / _skipQRead: shared state between qRead bar and doSelect.
  // _qReadDone: false while bar is filling; doSelect checks this before allowing selection.
  // _skipQRead: called by doSelect to instantly complete the bar (assigned by shouldDelay block).
  let _qReadDone = true;       // default: no delay → selection always allowed
  let _skipQRead = () => { };   // no-op by default; overwritten if qRead is active

  // Question read time — questionContainer is always flex-row (← text →).
  // The image goes AFTER questionContainer inside qSection (the outer flex-column section).
  const questionContainer = questionEl.parentElement;

  questionContainer.style.flexDirection = '';   // always row — never change this
  questionContainer.style.alignItems = '';
  questionContainer.style.gap = '';
  questionContainer.style.border = '1px solid rgba(139, 92, 246, 0.12)';
  questionContainer.style.borderRadius = '0.75rem';
  questionContainer.style.padding = '0.75rem 1rem';
  questionContainer.style.position = 'relative';
  questionContainer.style.overflow = 'hidden';

  // Inject question image into qSection (below questionContainer)
  let _qImgWrapRef = null;
  if (_hasQImg && qSection) {
    // Ensure qSection is a flex column and its existing children have correct order
    qSection.style.display = 'flex';
    qSection.style.flexDirection = 'column';
    qSection.style.gap = '8px';

    // Force order: score (0), question row (1), image (2)
    const scoreRow = qSection.querySelector('.quiz-score-row');
    if (scoreRow) scoreRow.style.order = '0';
    questionContainer.style.order = '1';

    const qImgWrap = document.createElement('div');
    qImgWrap.className = 'quiz-question-img-wrap';
    qImgWrap.style.order = '2'; // always below question
    _qImgWrapRef = qImgWrap;

    Object.assign(qImgWrap.style, {
      width: '100%',
      maxHeight: Math.floor(window.innerHeight * 0.40) + 'px', // max 30vh
      height: Math.floor(window.innerHeight * 0.40) + 'px',
      flexShrink: '1',
      borderRadius: '10px',
      overflow: 'hidden',
      position: 'relative',  // required for absolute-positioned source badge
      background: 'linear-gradient(90deg,#1e2d42 25%,#243553 50%,#1e2d42 75%)'
    });
    const qImg = document.createElement('img');
    Object.assign(qImg.style, {
      width: '100%', height: '100%', objectFit: 'contain',
      borderRadius: '10px', display: 'block', opacity: '0',
      transition: 'opacity 0.3s ease', pointerEvents: 'none'
    });
    qImg.alt = q.questionImageKeyword;

    // Badge helper — shows P (Pixabay), W (Wikimedia), A (AI SVG)
    const _showQBadge = (src) => {
      const old = qImgWrap.querySelector('.img-src-badge');
      if (old) old.remove();
      const lbl = src === 'ai' ? 'A' : src === 'wikimedia' ? 'W' : 'P';
      const col = src === 'ai' ? 'rgba(139,92,246,0.92)' : src === 'wikimedia' ? 'rgba(59,130,246,0.92)' : 'rgba(16,185,129,0.92)';
      const b = document.createElement('span');
      b.className = 'img-src-badge';
      b.textContent = lbl;
      Object.assign(b.style, {
        position: 'absolute', bottom: '5px', right: '7px', zIndex: '30',
        fontSize: '10px', fontWeight: '900', fontFamily: 'monospace',
        background: col, color: '#fff', borderRadius: '4px',
        padding: '2px 5px', pointerEvents: 'none', lineHeight: '1.4',
        boxShadow: '0 1px 4px rgba(0,0,0,0.4)', userSelect: 'none'
      });
      qImgWrap.appendChild(b);
    };

    // ── Loading indicator while resolveVisual fetches ──────────────────
    let _loaderEl = null, _loaderTimer = null;
    const _startLoader = () => {
      if (_loaderEl) return;
      _loaderEl = document.createElement('div');
      Object.assign(_loaderEl.style, {
        position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '6px',
        background: 'rgba(15,23,42,0.0)', color: '#a78bfa',
        fontFamily: 'inherit', zIndex: '5', pointerEvents: 'none'
      });
      let sec = 0;
      _loaderEl.innerHTML = `
            <div style="width:32px;height:32px;border-radius:50%;border:2.5px solid #7c3aed;border-top-color:transparent;animation:spin 1s linear infinite;"></div>
            <div style="font-size:0.78rem;font-weight:600;">Generating image&hellip; <span id="_qimg_sec">0</span> s</div>`;
      qImgWrap.appendChild(_loaderEl);
      _loaderTimer = setInterval(() => {
        sec++;
        const el = _loaderEl?.querySelector('#_qimg_sec');
        if (el) el.textContent = sec;
      }, 1000);
    };
    const _stopLoader = () => {
      if (_loaderTimer) { clearInterval(_loaderTimer); _loaderTimer = null; }
      if (_loaderEl) { _loaderEl.remove(); _loaderEl = null; }
    };
    const _showFailMsg = () => {
      _stopLoader();
      const msg = document.createElement('div');
      Object.assign(msg.style, {
        position: 'absolute', inset: '0', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        color: '#f87171', fontSize: '0.8rem', fontWeight: '600',
        fontFamily: 'inherit', pointerEvents: 'none'
      });
      msg.textContent = 'Image not available';
      qImgWrap.appendChild(msg);
      // Shrink wrap so it takes minimal space
      qImgWrap.style.height = '2.5rem';
      qImgWrap.style.background = 'transparent';
      requestAnimationFrame(() => requestAnimationFrame(() => _sizeAnswerGrid()));
    };

    // Start loading indicator immediately
    _startLoader();

    // Resolve via Pixabay → Wikimedia → AI SVG (uses cache)
    const _isMathSubject = /^(math|mathematics)$/i.test(q._subject || q.subject || '');
    const _correctAnsObj = q.answers?.find(a => String(a.id) === String(q.correctId));
    resolveVisual(q.questionImageKeyword, [], q.question, {
      forceAI: _isMathSubject,
      correctAnswer: _correctAnsObj?.text || ''
    }).then(res => {
      _stopLoader();
      if (res?.url) {
        qImg.src = res.url;
        qImg.onload = () => {
          qImg.style.opacity = '1';
          qImgWrap.style.background = 'transparent';
          _showQBadge(res.source || 'pixabay');
          requestAnimationFrame(() => requestAnimationFrame(() => _sizeAnswerGrid()));
          setTimeout(() => _sizeAnswerGrid(), 200);
          setTimeout(() => _sizeAnswerGrid(), 600);
        };
        qImg.onerror = () => handleImageFail();
      } else if (res?.svg) {
        qImgWrap.innerHTML = res.svg;
        const svgEl = qImgWrap.querySelector('svg');
        if (svgEl) {
          svgEl.style.width = '100%'; svgEl.style.height = '100%';
          svgEl.style.display = 'block'; qImgWrap.style.background = 'transparent';
          _showQBadge('ai');
          requestAnimationFrame(() => requestAnimationFrame(() => _sizeAnswerGrid()));
          setTimeout(() => _sizeAnswerGrid(), 200);
          setTimeout(() => _sizeAnswerGrid(), 600);
        }
      } else { handleImageFail(); }
    }).catch(() => handleImageFail());

    function handleImageFail() {
      _stopLoader();
      _showFailMsg();
    }

    qImgWrap.appendChild(qImg);
    qSection.appendChild(qImgWrap);
    requestAnimationFrame(() => requestAnimationFrame(() => _sizeAnswerGrid()));
  } else {
    if (qSection) { qSection.style.gap = ''; }
  }

  const existingBar = questionContainer.querySelector('.quiz-qread-bar');
  if (existingBar) existingBar.remove();
  if (quizQReadTimerId) { cancelAnimationFrame(quizQReadTimerId); quizQReadTimerId = null; }
  if (quizQReadOnEnter) questionContainer.removeEventListener('mouseenter', quizQReadOnEnter);
  if (quizQReadOnLeave) questionContainer.removeEventListener('mouseleave', quizQReadOnLeave);
  if (quizQReadOnClick) questionContainer.removeEventListener('click', quizQReadOnClick);
  questionContainer.style.cursor = '';

  const shouldDelay = quizSettings.qReadEnabled && quizSettings.qReadTimeMs > 0;
  if (shouldDelay) {
    // Hide answers AND disable interaction until bar completes
    _qReadDone = false;
    grid.style.opacity = '0';
    grid.style.pointerEvents = 'none';
    grid.style.transition = 'opacity 0.4s ease';

    const bar = document.createElement('div');
    bar.className = 'quiz-qread-bar';
    bar.style.cssText = 'position:absolute;bottom:0;left:0;height:3px;background:linear-gradient(90deg,#7c3aed,#a855f7);width:0%;z-index:10;border-radius:0 2px 2px 0;';
    questionContainer.appendChild(bar);

    let elapsed = 0, hovering = false, lastT = null, done = false;

    const _onBarComplete = () => {
      if (done) return;
      done = true;
      _qReadDone = true;
      grid.style.opacity = '1';
      grid.style.pointerEvents = 'auto';
      bar.style.background = 'linear-gradient(90deg,#10b981,#06b6d4)';
      setTimeout(() => { if (bar.parentNode) bar.style.opacity = '0'; }, 600);
      questionContainer.removeEventListener('mouseenter', onEnter);
      questionContainer.removeEventListener('mouseleave', onLeave);
      questionContainer.removeEventListener('click', onClick);
      if (_qImgWrapRef) {
        _qImgWrapRef.removeEventListener('mouseenter', onEnter);
        _qImgWrapRef.removeEventListener('mouseleave', onLeave);
        _qImgWrapRef.removeEventListener('click', onClick);
      }
      questionContainer.style.cursor = '';
      // Sequencing rule: read answers ONLY AFTER question TTS finishes.
      // If question is still being spoken, mark as pending — quizSpeak's onEnd will trigger it.
      if (quizSettings.voiceOver && _capturedGen === quizRenderGen) {
        if (window.speechSynthesis?.speaking) {
          // Question TTS still running — defer answers until it ends naturally
          window._quizQReadAnswerPending = _capturedGen;
        } else {
          _speakAnswers(q, _capturedGen);
        }
      }
      _attachVoOverHoverBar(questionContainer, q, currentGen);
    };

    const animate = (t) => {
      if (currentGen !== quizRenderGen || done) return;
      if (!lastT) lastT = t;
      const dt = t - lastT; lastT = t;
      if (hovering) elapsed += dt;
      const pct = Math.min((elapsed / quizSettings.qReadTimeMs) * 100, 100);
      bar.style.width = `${pct}%`;
      if (pct >= 100) { _onBarComplete(); return; }
      quizQReadTimerId = requestAnimationFrame(animate);
    };

    const onEnter = () => {
      hovering = true;
      if (!_questionSpoken && quizSettings.voiceOver && _capturedGen === quizRenderGen) {
        _questionSpoken = true;
        quizSpeak(q.question, {
          rate: 0.88,
          targetElement: questionEl,
          onEnd: () => {
            // If bar completed while we were reading, speak answers now
            if (window._quizQReadAnswerPending === _capturedGen) {
              window._quizQReadAnswerPending = null;
              _speakAnswers(q, _capturedGen);
            }
          }
        });
      }
    };
    const onLeave = () => { hovering = false; lastT = null; };
    // Click on question = skip bar instantly
    const onClick = () => {
      if (!_questionSpoken && quizSettings.voiceOver && _capturedGen === quizRenderGen) {
        _questionSpoken = true;
        quizSpeak(q.question, {
          rate: 0.88,
          targetElement: questionEl,
          onEnd: () => {
            if (window._quizQReadAnswerPending === _capturedGen) {
              window._quizQReadAnswerPending = null;
              _speakAnswers(q, _capturedGen);
            }
          }
        });
      }
      elapsed = quizSettings.qReadTimeMs;
    };
    // _skipQRead: assigns elapsed = max to trigger _onBarComplete on next rAF.
    // Called by doSelect when user clicks an answer before bar completes.
    _skipQRead = () => { elapsed = quizSettings.qReadTimeMs; };
    quizQReadOnEnter = onEnter;
    quizQReadOnLeave = onLeave;
    quizQReadOnClick = onClick;
    questionContainer.addEventListener('mouseenter', onEnter);
    questionContainer.addEventListener('mouseleave', onLeave);
    questionContainer.addEventListener('click', onClick);
    if (_qImgWrapRef) {
      _qImgWrapRef.addEventListener('mouseenter', onEnter);
      _qImgWrapRef.addEventListener('mouseleave', onLeave);
      _qImgWrapRef.addEventListener('click', onClick);
      _qImgWrapRef.style.cursor = 'pointer';
    }
    questionContainer.style.cursor = 'pointer';
    quizQReadTimerId = requestAnimationFrame(animate);
  } else {
    // No qRead delay — answers immediately interactive
    _qReadDone = true;
    grid.style.opacity = '1';
    grid.style.pointerEvents = '';
    grid.style.transition = '';
    // Rule (b): Read question immediately, then answers when done
    if (quizSettings.voiceOver && _capturedGen === quizRenderGen) {
      _questionSpoken = true;
      quizSpeak(q.question, {
        rate: 0.88,
        targetElement: questionEl,
        onEnd: () => _speakAnswers(q, _capturedGen)
      });
    }
    _attachVoOverHoverBar(questionContainer, q, currentGen);
  }

  quizWrongAttempts = 0;

  function _attachVoOverHoverBar(container, question, gen) {
    // Rule (c): Only attach if voiceOver AND voiceOverHoverRepeat are both enabled
    if (!quizSettings.voiceOver || !quizSettings.voiceOverHoverRepeat) return;
    if (!quizSettings.dwellTimeMs) return;
    if (gen !== quizRenderGen) return;
    const old = container.querySelector('.quiz-vo-rebar');
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.className = 'quiz-vo-rebar';
    bar.style.cssText = 'position:absolute;bottom:0;left:0;height:3px;background:linear-gradient(90deg,#06b6d4,#10b981);width:0%;z-index:10;border-radius:0 2px 2px 0;opacity:0;transition:opacity 0.2s;';
    container.appendChild(bar);
    const _capturedAbortGen = _voAbortGen; // capture at attach time
    let timer = null, elapsed = 0, lastT = null;
    const animate = (t) => {
      if (gen !== quizRenderGen) { cancelAnimationFrame(timer); return; }
      if (!lastT) lastT = t;
      elapsed += t - lastT;
      lastT = t;
      const pct = Math.min((elapsed / quizSettings.dwellTimeMs) * 100, 100);
      bar.style.width = `${pct}%`;
      if (pct >= 100) {
        bar.style.opacity = '0'; elapsed = 0;
        if (_voAbortGen !== _capturedAbortGen) return;
        quizSpeak(question.question, {
          rate: 0.88,
          targetElement: questionEl,
          onEnd: () => {
            if (_voAbortGen !== _capturedAbortGen || gen !== quizRenderGen) return;
            _speakAnswers(question, gen);
          }
        });
        return;
      }
      timer = requestAnimationFrame(animate);
    };
    const onEnter = () => { bar.style.opacity = '1'; lastT = null; timer = requestAnimationFrame(animate); };
    const onLeave = () => { if (timer) cancelAnimationFrame(timer); elapsed = 0; lastT = null; bar.style.width = '0%'; bar.style.opacity = '0'; };
    container.addEventListener('mouseenter', onEnter);
    container.addEventListener('mouseleave', onLeave);
    container.style.cursor = 'pointer';
  }
  // Render answer cards
  // Robust correct answer identification
  const effectiveCorrectId = q.correctId || (Array.isArray(q.correctAnswerIds) ? q.correctAnswerIds[0] : null);

  displayAnswers.forEach((answer, idx) => {
    const isCorrect = answer.id === effectiveCorrectId;
    const card = document.createElement('div');
    Object.assign(card.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      minHeight: '0',
      width: '100%',
      padding: '1.5rem',
      boxSizing: 'border-box',
      textAlign: 'center',
      background: '#20293a',
      border: 'none',
      borderRadius: '20px',
      transition: 'transform 0.2s ease, background 0.2s ease',
      position: 'relative',
      overflow: 'hidden',
      cursor: 'pointer',
      userSelect: 'none'
    });
    card.className = 'quiz-answer-card';

    // Hover: lighten on mouseenter, restore on mouseleave (unless answered)
    card.addEventListener('mouseenter', () => {
      if (!card.dataset.answered && card.dataset.state !== 'wrong') card.style.background = '#364154';
    });
    card.addEventListener('mouseleave', () => {
      if (card.dataset.state === 'wrong') {
        card.style.background = '#7f1d1d';
      } else if (!card.dataset.answered) {
        card.style.background = '#20293a';
      }
    });

    const fontSizeClass = `quiz-font-${quizSettings.fontSize}`;
    const hasImageType = (quizSettings.contentTypes || []).includes('image');
    // ── Render-time Math guard: strip answer images for Math questions ──
    const _renderIsMath = /^(math|mathematics)$/i.test(q._subject || '') ||
      /^(math|mathematics)$/i.test(q.subject || '') ||
      /\b(fraction|decimal|equivalent|perimeter|area|calculate|equation|multiply|divide|angle|geometry)\b/i.test((q.question || '').toLowerCase());
    if (_renderIsMath && answer.imageKeyword) {
      console.warn('[Quiz][Render] Stripping answer imageKeyword for Math:', answer.imageKeyword);
      delete answer.imageKeyword;
    }
    const imageKeyword = answer.imageKeyword || '';

    if (hasImageType && imageKeyword) {
      card.style.flexDirection = 'column';
      card.style.padding = '8px';
      card.style.gap = '4px';
      card.style.display = 'flex';

      const imgWrapper = document.createElement('div');
      imgWrapper.className = 'quiz-answer-img';
      Object.assign(imgWrapper.style, {
        position: 'relative',
        borderRadius: '12px',
        overflow: 'hidden',
        flex: '1 1 0',
        minHeight: '0',
        background: 'linear-gradient(90deg, #1e2d42 25%, #243553 50%, #1e2d42 75%)'
      });

      const ansImg = document.createElement('img');
      ansImg.alt = imageKeyword;
      Object.assign(ansImg.style, {
        width: '100%', height: '100%', objectFit: 'contain', display: 'block',
        borderRadius: '12px', pointerEvents: 'none', opacity: '0', transition: 'opacity 0.3s ease'
      });

      // Badge helper for answer images
      const _showAnsBadge = (src) => {
        const old = imgWrapper.querySelector('.img-src-badge');
        if (old) old.remove();
        const lbl = src === 'ai' ? 'A' : src === 'wikimedia' ? 'W' : 'P';
        const col = src === 'ai' ? 'rgba(139,92,246,0.92)' : src === 'wikimedia' ? 'rgba(59,130,246,0.92)' : 'rgba(16,185,129,0.92)';
        const b = document.createElement('span');
        b.className = 'img-src-badge';
        b.textContent = lbl;
        Object.assign(b.style, {
          position: 'absolute', bottom: '4px', right: '5px', zIndex: '30',
          fontSize: '9px', fontWeight: '900', fontFamily: 'monospace',
          background: col, color: '#fff', borderRadius: '3px',
          padding: '1px 4px', pointerEvents: 'none', lineHeight: '1.4',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)', userSelect: 'none'
        });
        imgWrapper.appendChild(b);
      };

      // ── Loading label for answer images ──────────────────────────────
      const loadingLabel = document.createElement('div');
      loadingLabel.className = 'quiz-img-loading-label';
      Object.assign(loadingLabel.style, {
        position: 'absolute', inset: '0', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        color: '#64748b', fontSize: '0.75rem', fontWeight: '600',
        fontFamily: 'inherit', pointerEvents: 'none', zIndex: '5'
      });
      loadingLabel.textContent = 'Loading image...';
      imgWrapper.appendChild(loadingLabel);

      // Shimmer animation on wrapper
      imgWrapper.style.backgroundSize = '200% 100%';
      imgWrapper.style.animation = 'shimmer 1.5s infinite linear';

      const _showImgSuccess = () => {
        loadingLabel.remove();
        imgWrapper.style.animation = '';
      };
      const _showImgError = () => {
        loadingLabel.textContent = 'Image not available';
        loadingLabel.style.color = '#94a3b8';
        imgWrapper.style.animation = '';
        imgWrapper.style.background = 'rgba(30, 41, 59, 0.6)';
      };

      const cachedAns = quizResolvedVisuals.get(imageKeyword);
      if (cachedAns) {
        if (cachedAns.url) {
          ansImg.src = cachedAns.url;
          ansImg.onload = () => {
            ansImg.style.opacity = '1'; imgWrapper.style.background = 'transparent';
            _showAnsBadge(cachedAns.source || 'pixabay');
            _showImgSuccess();
          };
          ansImg.onerror = () => _showImgError();
        } else if (cachedAns.svg) {
          _showImgSuccess();
          imgWrapper.innerHTML = cachedAns.svg;
          const _svgEl = imgWrapper.querySelector('svg');
          if (_svgEl) { _svgEl.style.cssText = 'width:100%;height:100%;display:block;'; }
          _showAnsBadge('ai');
        } else {
          _showImgError();
        }
      } else {
        resolveVisual(imageKeyword, [], q.question).then(res => {
          if (res?.url) {
            ansImg.src = res.url;
            ansImg.onload = () => {
              ansImg.style.opacity = '1'; imgWrapper.style.background = 'transparent';
              _showAnsBadge(res.source || 'pixabay');
              _showImgSuccess();
            };
            ansImg.onerror = () => _showImgError();
          } else if (res?.svg) {
            _showImgSuccess();
            imgWrapper.innerHTML = res.svg;
            const _svgEl2 = imgWrapper.querySelector('svg');
            if (_svgEl2) { _svgEl2.style.cssText = 'width:100%;height:100%;display:block;'; }
            _showAnsBadge('ai');
          } else {
            _showImgError();
          }
        }).catch(() => _showImgError());
      }

      imgWrapper.appendChild(ansImg);
      card.appendChild(imgWrapper);

      const caption = document.createElement('span');
      caption.className = `quiz-answer-text ${fontSizeClass}`;
      Object.assign(caption.style, {
        color: '#f2f5f9', fontWeight: '700', textAlign: 'center', display: 'block',
        width: '100%', fontSize: 'clamp(0.6rem, 1.6vh, 0.9rem)', flexShrink: '0',
        overflowWrap: 'break-word', lineHeight: '1.3',
        pointerEvents: 'none', position: 'relative', zIndex: '10'
      });
      prepareHighlightableText(caption, answer.text);
      caption.dataset.prepared = 'true';
      card.appendChild(caption);
    } else {
      const textSpan = document.createElement('span');
      textSpan.className = `quiz-answer-text ${fontSizeClass}`;
      Object.assign(textSpan.style, {
        color: '#f2f5f9', fontWeight: '700', textAlign: 'center', display: 'block',
        width: '100%', overflowWrap: 'break-word', pointerEvents: 'none', zIndex: '10'
      });
      prepareHighlightableText(textSpan, answer.text);
      textSpan.dataset.prepared = 'true';
      card.appendChild(textSpan);
    }

    if (isCorrect) window._currentCorrectCard = card;

    const progressBar = document.createElement('div');
    progressBar.className = 'absolute bottom-0 left-0 h-1.5 bg-violet-500/40 transition-none z-10';
    progressBar.style.width = '0%';
    card.appendChild(progressBar);

    let timer = null;
    let svgOverlay = null;
    const removeOverlay = () => { if (svgOverlay && svgOverlay.parentNode === card) { card.removeChild(svgOverlay); svgOverlay = null; } };
    const addOverlay = () => {
      if (!svgOverlay) {
        svgOverlay = document.createElement('div');
        svgOverlay.className = 'absolute inset-0 flex items-center justify-center z-20 pointer-events-none';
        svgOverlay.innerHTML = `<svg class="w-28 h-28 transform -rotate-90"><circle cx="56" cy="56" r="44" class="text-slate-700/80" stroke-width="7" stroke="currentColor" fill="transparent" /><circle cx="56" cy="56" r="44" class="text-violet-400" style="opacity:0.55" stroke-width="7" stroke-dasharray="276.46" stroke-dashoffset="276.46" stroke-linecap="round" stroke="currentColor" fill="transparent" /></svg>`;
        card.appendChild(svgOverlay);
      }
    };

    applyQuizCardTheme(card, answer, idx);

    let quizQuestionAnswered = false;

    const doSelect = () => {
      if (quizQuestionAnswered) return;
      // If qRead bar hasn't completed yet, skip it instantly then re-invoke after 2 frames
      if (!_qReadDone) {
        _skipQRead();
        requestAnimationFrame(() => requestAnimationFrame(() => doSelect()));
        return;
      }
      if (isCorrect) {
        quizQuestionAnswered = true;
        _voAbortGen++; // cancel any ongoing answer TTS
        quizSpeakCancel();
        card.dataset.answered = 'true';
        card.style.background = '#10b981'; // Green
        card.style.animation = 'successBounce 0.75s ease';
        card.style.transform = 'scale(1.03)';

        // Fade out others
        grid.querySelectorAll('.quiz-answer-card').forEach(c => {
          if (c !== card) { c.style.opacity = '0.4'; c.style.pointerEvents = 'none'; }
        });

        // Sound & Celebration (Reliable Global Trigger)
        playQuizCorrectSound(); // This handles the primary horn/celebration logic
        burstConfetti(card);

        // Secondary random celebration sound
        const sounds = ['correct1.mp3', 'correct2.mp3', 'correct3.mp3'];
        const snd = new Audio('/assets/sounds/' + sounds[Math.floor(Math.random() * sounds.length)]);
        snd.volume = 0.6;
        snd.play().catch(() => { });

        let progressionTriggered = false;
        const triggerProgression = () => {
          if (progressionTriggered) return;
          progressionTriggered = true;
          // Theme-specific celebration
          if (currentQuizTheme === 'ben-holly') {
            triggerBenElfCelebration();
            _quizVoiceDelay = Date.now() + 3200;
          } else if (currentQuizTheme === 'kung-fu-panda') {
            triggerKfpCelebration();
            _quizVoiceDelay = Date.now() + 3200;
          } else {
            _quizVoiceDelay = Date.now() + 1500;
          }
          quizScore++;
          updateQuizScoreBar();
          setTimeout(() => {
            if (quizScore >= quizSettings.correctTarget) showQuizWin();
            else generateQuizQuestion();
          }, 1500);
        };

        quizSpeakCongrats(answer.text, { onEnd: triggerProgression });
        // Safety timeout: if speech fails, still progress
        setTimeout(triggerProgression, 3500);
      } else {
        // MOST-RECENT ONLY logic: Reset any previous wrong states
        grid.querySelectorAll('.quiz-answer-card').forEach(c => {
          if (c.dataset.state === 'wrong') {
            c.dataset.state = '';
            c.style.background = '#20293a'; // restore normal
            const oldCross = c.querySelector('.wrong-cross');
            if (oldCross) oldCross.remove();
          }
        });

        quizWrongAttempts++;
        card.dataset.state = 'wrong';
        card.style.background = 'rgba(239,68,68,0.18)'; // subtle red tint

        const cross = document.createElement('div');
        cross.className = 'wrong-cross';
        cross.style.pointerEvents = 'none'; // don't intercept clicks on subsequent attempts
        card.appendChild(cross);

        card.style.transform = 'translateX(-10px)';
        setTimeout(() => card.style.transform = 'translateX(10px)', 50);
        setTimeout(() => card.style.transform = 'translateX(0)', 100);

        // Play wrong sound via the reliable global helper
        playWrongSound();

        // Show hint after x wrong attempts (threshold 11 = Never)
        if (quizSettings.hintThreshold > 0 && quizSettings.hintThreshold < 11 &&
          quizWrongAttempts >= quizSettings.hintThreshold) {
          showQuizHint(q);
        }
      }
    };

    const startDwell = () => {
      if (quizSettings.dwellTimeMs === 0) return;
      let start = null;
      const animate = (t) => {
        if (currentGen !== quizRenderGen) return;
        if (!start) start = t;
        const elapsed = t - start;
        const progress = Math.min((elapsed / quizSettings.dwellTimeMs) * 100, 100);
        progressBar.style.width = `${progress}%`;
        if (progress > 0) {
          addOverlay();
          const circle = svgOverlay.querySelector('circle:last-child');
          if (circle) {
            const circ = 44 * 2 * Math.PI;
            circle.style.strokeDashoffset = circ - (progress / 100) * circ;
          }
        }
        if (progress >= 100) { doSelect(); } else { timer = requestAnimationFrame(animate); }
      };
      timer = requestAnimationFrame(animate);
    };
    const stopDwell = () => {
      if (timer) cancelAnimationFrame(timer);
      progressBar.style.width = '0%';
      removeOverlay();
    };

    card.addEventListener('mouseenter', startDwell);
    card.addEventListener('mouseleave', stopDwell);
    card.addEventListener('click', doSelect);
    card.addEventListener('touchstart', (e) => { e.preventDefault(); startDwell(); });
    card.addEventListener('touchend', (e) => { e.preventDefault(); stopDwell(); doSelect(); });
    card.addEventListener('touchcancel', (e) => { e.preventDefault(); stopDwell(); });

    grid.appendChild(card);
  });
  // After cards are in the DOM, size the grid multiple times to catch async image loads
  requestAnimationFrame(() => _sizeAnswerGrid());
  setTimeout(() => _sizeAnswerGrid(), 150);
  setTimeout(() => _sizeAnswerGrid(), 500);
  setTimeout(() => _sizeAnswerGrid(), 1000);
  setTimeout(() => _sizeAnswerGrid(), 2000);
}

// ── Dynamic answer-grid sizer ──────────────────────────────────────────
// For quiz mode: CSS flex:1 handles the layout. We just ensure no stale
// explicit height overrides the flex rule.
// For education mode: still uses JS height calculation.
function _sizeAnswerGrid() {
  const isQuiz = document.body.classList.contains('quiz-active');
  const isEdu = document.body.classList.contains('education-active');
  if (!isQuiz && !isEdu) return;

  const gridId = isQuiz ? 'quiz-answers-grid' : 'answers-grid';
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (isQuiz) {
    // Quiz mode: CSS flex:1 1 0 !important handles the height.
    // Just clear any stale explicit height that might override flex.
    grid.style.removeProperty('height');
    return;
  }

  // Education mode: use JS height calculation
  const viewId = 'view-education';
  const view = document.getElementById(viewId);
  if (!view) return;

  const q = getActiveQ();
  if (!q || !q.maximizeSpacing) {
    grid.style.removeProperty('height');
    return;
  }

  grid.style.removeProperty('height');
  void grid.offsetHeight;
  const gridTop = grid.getBoundingClientRect().top;
  const available = window.innerHeight - gridTop;
  grid.style.setProperty('height', Math.max(120, available) + 'px', 'important');
}
// Re-size on every viewport change
window.addEventListener('resize', _sizeAnswerGrid);

// ── Quiz card theme decoration ──────────────────────────────────────────
const _BH_CHAR_POSITIONS = ['0% 0%', '100% 0%', '0% 100%', '100% 100%'];
const _PEPPA_CHARS = ['assets/peppa/peppa.png', 'assets/peppa/suzy.png', 'assets/peppa/george.png', 'assets/peppa/friends.png'];
const _KFP_DECOS = ['🍭', '🐼', '⚡', '🥋'];

function applyQuizCardTheme(card, answer, idx) {
  if (currentQuizTheme === 'ben-holly') card.classList.add('quiz-card-bh');
  else if (currentQuizTheme === 'kung-fu-panda') card.classList.add('quiz-card-kfp');
  else if (currentQuizTheme === 'peppa') card.classList.add('quiz-card-peppa');
}

// ── Ben & Holly celebration toast ────────────────────────────────────
const _BH_CHARS = [
  'assets/bh/ben.png',
  'assets/bh/holly.png',
  'assets/bh/gaston.png',
  'assets/bh/nannyplum.png',
  'assets/bh/wiseoldelf.png',
  'assets/bh/mrmrself.png',
  'assets/bh/kingandqueen.png',
  'assets/bh/sqiurrel.png',
  'assets/bh/hollywand.png',
  'assets/bh/benhorn.png',
];
const _BH_SOUNDS = ['assets/bh/fairy_wow.mp3', 'assets/bh/recorder.mp3', 'assets/bh/08_elf_horn_hit.mp3'];

let _bhToastT = null;
function triggerBenElfCelebration() {
  // Pick one celebration sound randomly from the pool of 3
  try {
    const snd = new Audio(_BH_SOUNDS[Math.floor(Math.random() * _BH_SOUNDS.length)]);
    snd.volume = 0.85;
    snd.play().catch(err => console.error("Celebration sound failed:", err));
  } catch (_) { }

  const toast = document.getElementById('bh-toast');
  if (!toast) return;

  // Cancel any pending hide
  if (_bhToastT) { clearTimeout(_bhToastT); _bhToastT = null; }
  toast.classList.remove('show', 'hide');

  // Pick 2 unique random characters
  const pool = [..._BH_CHARS].sort(() => Math.random() - 0.5);
  const picked = pool.slice(0, 2);

  // Clear previous characters
  toast.innerHTML = '';

  // Each character gets a random position biased towards the centre third
  // Char 0: left half, Char 1: right half — so they don't overlap
  picked.forEach((src, i) => {
    const img = document.createElement('img');
    img.src = src;
    img.className = 'bh-toast-char';
    img.alt = '';

    // X: left char 20-48%, right char 52-80%  (% of viewport, centred on that point)
    const xMin = i === 0 ? 20 : 52;
    const x = xMin + Math.random() * 28;
    // Y: 25-65% from top
    const y = 25 + Math.random() * 40;
    img.style.left = `${x}%`;
    img.style.top = `${y}%`;

    // Stagger second character slightly
    if (i === 1) {
      img.style.animationDelay = '0.09s, 0.64s, 0.64s';
    }
    toast.appendChild(img);
  });

  void toast.offsetWidth; // force reflow
  toast.classList.add('show');

  // Hold 4.4 s then pop out (doubled per user request)
  _bhToastT = setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.add('hide');
    _bhToastT = setTimeout(() => {
      toast.classList.remove('hide');
      toast.innerHTML = ''; // clean up DOM
    }, 380);
  }, 3300);
}

// ── Confetti burst ──────────────────────────────────────────────────────
function burstConfetti(sourceEl) {
  const COLORS = ['#a78bfa', '#f59e0b', '#34d399', '#f472b6', '#60a5fa', '#fbbf24', '#fb7185'];
  const rect = sourceEl ? sourceEl.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const COUNT = 28;
  for (let i = 0; i < COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'quiz-confetti-piece';
    const angle = (Math.PI * 2 * i) / COUNT + (Math.random() - 0.5) * 0.4;
    const dist = 90 + Math.random() * 120;
    el.style.setProperty('--cx', `${Math.cos(angle) * dist}px`);
    el.style.setProperty('--cy', `${Math.sin(angle) * dist - 40}px`);
    el.style.setProperty('--cr', `${Math.random() * 540 - 270}deg`);
    el.style.background = COLORS[i % COLORS.length];
    el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    el.style.width = `${7 + Math.random() * 7}px`;
    el.style.height = `${7 + Math.random() * 7}px`;
    el.style.left = `${cx - 5}px`;
    el.style.top = `${cy - 5}px`;
    el.style.animationDelay = `${Math.random() * 0.12}s`;
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }
}

// ── Quiz correct-answer fanfare (richer than basic success chirp) ────────
function playQuizCorrectSound() {
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.28, ctx.currentTime);
    masterGain.connect(ctx.destination);

    // Ascending arpeggio: C5 → E5 → G5 → C6 → E6
    const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.1;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.6, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(gain); gain.connect(masterGain);
      osc.start(t); osc.stop(t + 0.36);
    });

    // Sparkle layer — high twinkling overtones
    [2093, 2637, 3136].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + 0.25 + i * 0.07;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.15, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain); gain.connect(masterGain);
      osc.start(t); osc.stop(t + 0.26);
    });
  } catch (_) { }
}

// ══════════════════════════════════════════════════════════════════════════
// KUNG FU PANDA THEME — Celebration, Intro & Outro
// ══════════════════════════════════════════════════════════════════════════

// All KFP character images (intro = no names popup)
const _KFP_CHARS = [
  'assets/kungfu/panda_kick.png',
  'assets/kungfu/panda_pose-removebg-preview.png',
  'assets/kungfu/panda_foldarms.png',
  'assets/kungfu/tigress_hadoken.png',
  'assets/kungfu/tigress_face.png',
  'assets/kungfu/shifu_stand.png',
  'assets/kungfu/crane_pose-removebg-preview.png',
  'assets/kungfu/crane_extendwings-removebg-preview.png',
  'assets/kungfu/mantis_kick.png',
  'assets/kungfu/mantis_pose-removebg-preview.png',
  'assets/kungfu/mantis_swing.png',
  'assets/kungfu/snake_look-removebg-preview.png',
  'assets/kungfu/snake_loop.png',
  'assets/kungfu/snake_umbrella-removebg-preview.png',
  'assets/kungfu/monkey_kick-removebg-preview.png',
  'assets/kungfu/monkey_sit.png',
  'assets/kungfu/peacock-removebg-preview.png',
  'assets/kungfu/tailung_stand-removebg-preview.png',
  'assets/kungfu/wugui-removebg-preview.png',
];

// All sfx_ and vo_ sound files available
const _KFP_SOUNDS = [
  'assets/kungfu/sfx_belly_bounce.mp3',
  'assets/kungfu/sfx_combat_combo.mp3',
  'assets/kungfu/sfx_combat_swoosh.mp3',
  'assets/kungfu/sfx_gong_impact.mp3',
  'assets/kungfu/sfx_heavy_thud.mp3',
  'assets/kungfu/sfx_impact_punch.mp3',
  'assets/kungfu/sfx_melee_combo.mp3',
  'assets/kungfu/sfx_scroll_open.mp3',
  'assets/kungfu/sfx_skill_ready_sparkle.mp3',
  'assets/kungfu/vo_dragon_warrior_intro.mp3',
  'assets/kungfu/vo_hes_a_panda.mp3',
  'assets/kungfu/vo_po_no_secret.mp3',
  'assets/kungfu/vo_shifu_limit.mp3',
  'assets/kungfu/vo_sit_on_me.mp3',
  'assets/kungfu/vo_skidush.mp3',
  'assets/kungfu/vo_the_big_fat_panda.mp3',
  'assets/kungfu/vo_wuxi_finger_hold.mp3',
];

// vo_ sounds only (for outro)
const _KFP_VO_SOUNDS = _KFP_SOUNDS.filter(s => s.includes('/vo_'));

// Background images for intro
const _KFP_BACKGROUNDS = [
  'assets/kungfu/background1.png',
  'assets/kungfu/background2.png',
  'assets/kungfu/background3.png',
];

// Outro poster images
const _KFP_POSTERS = [
  'assets/kungfu/all_character_poster.png',
  'assets/kungfu/all_character_poster2.png',
];

let _kfpToastT = null;

// ── Correct-answer celebration: 2 random characters pop in ───────────────
function triggerKfpCelebration() {
  // Play a random sfx or vo sound
  try {
    const snd = new Audio(_KFP_SOUNDS[Math.floor(Math.random() * _KFP_SOUNDS.length)]);
    snd.volume = 0.85;
    snd.play().catch(err => console.error('KFP celebration sound failed:', err));
  } catch (_) { }

  const toast = document.getElementById('kfp-toast');
  if (!toast) return;

  if (_kfpToastT) { clearTimeout(_kfpToastT); _kfpToastT = null; }
  toast.classList.remove('show', 'hide');
  toast.innerHTML = '';

  // Pick 2 UNIQUE random characters
  const pool = [..._KFP_CHARS].sort(() => Math.random() - 0.5);

  // Each character is a wrapper div (same pattern as intro) so the
  // animation fires on the container regardless of image-load timing.
  pool.slice(0, 2).forEach((src, i) => {
    // Left char: 15–42%, Right char: 58–85% (centres, because transform:translate(-50%,-50%))
    const xMin = i === 0 ? 15 : 58;
    const x = xMin + Math.random() * 27;
    const y = 25 + Math.random() * 38;  // 25–63% — keeps feet on screen

    const wrap = document.createElement('div');
    wrap.className = 'kfp-toast-char';
    wrap.style.left = `${x}%`;
    wrap.style.top = `${y}%`;
    // Stagger the second character slightly
    if (i === 1) wrap.style.animationDelay = '0.12s, 0.67s, 0.67s';

    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.style.cssText = 'width:100%;height:auto;display:block;';
    wrap.appendChild(img);
    toast.appendChild(wrap);
  });

  void toast.offsetWidth;
  toast.classList.add('show');

  _kfpToastT = setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.add('hide');
    _kfpToastT = setTimeout(() => {
      toast.classList.remove('hide');
      toast.innerHTML = '';
    }, 380);
  }, 3300);
}

// ── Intro scene ────────────────────────────────────────────────────────────
function playKungFuPandaIntro(onDone) {
  const overlay = document.getElementById('kfp-intro-overlay');
  const bgEl = document.getElementById('kfp-intro-bg');
  const titleEl = document.getElementById('kfp-intro-title');
  const charStage = document.getElementById('kfp-char-stage');
  if (!overlay) { onDone(); return; }

  // Close settings overlay
  const settingsOverlay = document.getElementById('quiz-settings-overlay');
  if (settingsOverlay) settingsOverlay.classList.remove('show');

  // Pick a random background
  const bg = _KFP_BACKGROUNDS[Math.floor(Math.random() * _KFP_BACKGROUNDS.length)];
  bgEl.style.backgroundImage = `url('${bg}')`;

  charStage.innerHTML = '';

  // ── Build guaranteed character list ─────────────────────────────────
  // Always include at least one of each major character type,
  // then fill remaining slots with random extras (no repeats).
  const _KFP_REQUIRED_GROUPS = [
    ['assets/kungfu/panda_kick.png', 'assets/kungfu/panda_pose-removebg-preview.png', 'assets/kungfu/panda_foldarms.png'],
    ['assets/kungfu/monkey_kick-removebg-preview.png', 'assets/kungfu/monkey_sit.png'],
    ['assets/kungfu/crane_pose-removebg-preview.png', 'assets/kungfu/crane_extendwings-removebg-preview.png'],
    ['assets/kungfu/mantis_kick.png', 'assets/kungfu/mantis_pose-removebg-preview.png', 'assets/kungfu/mantis_swing.png'],
    ['assets/kungfu/snake_look-removebg-preview.png', 'assets/kungfu/snake_loop.png', 'assets/kungfu/snake_umbrella-removebg-preview.png'],
  ];
  const pickedSet = new Set();
  const sceneChars = [];
  for (const group of _KFP_REQUIRED_GROUPS) {
    const choice = group[Math.floor(Math.random() * group.length)];
    sceneChars.push(choice);
    pickedSet.add(choice);
  }
  // Fill up to 10 slots with unused extras, shuffled
  const extras = [..._KFP_CHARS].filter(c => !pickedSet.has(c)).sort(() => Math.random() - 0.5);
  sceneChars.push(...extras.slice(0, 10 - sceneChars.length));
  // Shuffle the final combined list
  for (let i = sceneChars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sceneChars[i], sceneChars[j]] = [sceneChars[j], sceneChars[i]];
  }

  const TOTAL_DURATION = 40000; // 40 s max (longer than typical audio)
  const spawnInterval = 2500; // one character every 2.5 seconds

  // ── Pre-compute 5×2 grid slots (10 cells) — shuffle for random assignment ─
  const GRID_COLS = 5, GRID_ROWS = 2;
  const gridSlots = [];
  for (let row = 0; row < GRID_ROWS; row++)
    for (let col = 0; col < GRID_COLS; col++)
      gridSlots.push({ col, row });
  for (let i = gridSlots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [gridSlots[i], gridSlots[j]] = [gridSlots[j], gridSlots[i]];
  }
  let slotIdx = 0;
  let _zCounter = 10; // increments so each new character layers on top of older ones

  let spawnTimers = [];
  let done = false;

  function spawnChar(src) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // ── Character sizing: fit within the grid cell so nothing goes off-screen ────
    const topOffset = vh * 0.22; // below the title band
    const cellW = vw / GRID_COLS;
    const cellH = (vh - topOffset) / GRID_ROWS;
    // Size character so it comfortably fits its cell (88% of the smaller dimension)
    const size = Math.floor(Math.min(cellW, cellH) * 0.88);
    const margin = -size;

    // Start from a random screen edge
    const edge = Math.floor(Math.random() * 4);
    let startX, startY;
    switch (edge) {
      case 0: startX = Math.random() * vw; startY = margin; break;
      case 1: startX = vw + Math.abs(margin); startY = Math.random() * vh; break;
      case 2: startX = Math.random() * vw; startY = vh + Math.abs(margin); break;
      default: startX = margin; startY = Math.random() * vh; break;
    }

    // ── Land centred in the pre-assigned grid slot ──────────────────────
    const slot = gridSlots[slotIdx % gridSlots.length];
    slotIdx++;
    // Centre of the cell + small jitter (±10% of cell dimension)
    const jitterX = (Math.random() - 0.5) * cellW * 0.2;
    const jitterY = (Math.random() - 0.5) * cellH * 0.2;
    const endX = Math.max(0, Math.min(vw - size, slot.col * cellW + (cellW - size) * 0.5 + jitterX));
    const endY = Math.max(topOffset, Math.min(vh - size, topOffset + slot.row * cellH + (cellH - size) * 0.5 + jitterY));

    const wrap = document.createElement('div');
    wrap.style.position = 'absolute';
    wrap.style.left = `${startX}px`;
    wrap.style.top = `${startY}px`;
    wrap.style.width = `${size}px`;
    wrap.style.transform = `rotate(${(Math.random() - 0.5) * 30}deg) scale(0.3)`;
    wrap.style.opacity = '0';
    wrap.style.transition = 'left 0.9s cubic-bezier(0.175,0.885,0.32,1.275), top 0.9s cubic-bezier(0.175,0.885,0.32,1.275), opacity 0.5s ease, transform 0.9s cubic-bezier(0.175,0.885,0.32,1.275)';
    wrap.style.pointerEvents = 'none';
    wrap.style.zIndex = _zCounter++;

    // Assign a vibrant per-character glow colour cycling through a warm/cool palette
    const _KFP_GLOW_PALETTE = [
      'rgba(251,191,36,0.9)',   // golden yellow
      'rgba(239,68,68,0.85)',   // crimson red
      'rgba(168,85,247,0.9)',   // violet purple
      'rgba(34,197,94,0.85)',   // jade green
      'rgba(249,115,22,0.9)',   // fiery orange
      'rgba(56,189,248,0.9)',   // sky blue
      'rgba(244,114,182,0.85)',  // sakura pink
      'rgba(251,146,60,0.9)',   // warm amber
      'rgba(52,211,153,0.85)',  // emerald teal
      'rgba(220,38,38,0.9)',    // deep red
      'rgba(99,102,241,0.9)',   // indigo
      'rgba(250,204,21,0.85)',  // bright gold
    ];
    const glowColor = _KFP_GLOW_PALETTE[slotIdx % _KFP_GLOW_PALETTE.length];
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.style.cssText = `width:100%;height:auto;filter:drop-shadow(0 8px 32px ${glowColor})drop-shadow(0 0 16px ${glowColor})`;
    // NO name label (per requirement)
    wrap.appendChild(img);
    charStage.appendChild(wrap);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      wrap.style.left = `${endX}px`;
      wrap.style.top = `${endY}px`;
      wrap.style.opacity = '1';
      wrap.style.transform = `rotate(${(Math.random() - 0.5) * 10}deg) scale(1)`;
      setTimeout(() => {
        wrap.style.transition = `transform 2.2s ease-in-out infinite alternate`;
        wrap.style.transform = `rotate(${(Math.random() - 0.5) * 6}deg) scale(${0.96 + Math.random() * 0.08})`;
      }, 950);
    }));
  }

  // Show overlay
  overlay.style.opacity = '0';
  overlay.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    overlay.style.transition = 'opacity 0.5s ease';
    overlay.style.opacity = '1';
    titleEl.style.opacity = '1';
    titleEl.style.transform = 'scale(1) translateY(0)';
  }));

  // Play theme music
  let introAudio = null;
  try {
    introAudio = new Audio('assets/kungfu/kfptheme.mp3');
    introAudio.volume = 0.75;
    introAudio.play().catch(() => { });
  } catch (e) { }

  // Spawn first character immediately, then loop continuously via setInterval.
  // When the pool is exhausted, re-shuffle and cycle again — keeps going until done.
  let spawnPoolIdx = 0;
  const spawnNext = () => {
    if (done) return;
    // Wrap around: re-shuffle when we've gone through the whole pool
    if (spawnPoolIdx >= sceneChars.length) {
      spawnPoolIdx = 0;
      for (let i = sceneChars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sceneChars[i], sceneChars[j]] = [sceneChars[j], sceneChars[i]];
      }
      // Also re-shuffle grid slots so positions vary each cycle
      for (let i = gridSlots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gridSlots[i], gridSlots[j]] = [gridSlots[j], gridSlots[i]];
      }
      slotIdx = 0;
    }
    spawnChar(sceneChars[spawnPoolIdx++]);
  };
  spawnNext(); // first one fires immediately
  const spawnInterval_id = setInterval(spawnNext, spawnInterval);
  spawnTimers.push(spawnInterval_id); // store so finish() can clearInterval it

  function finish() {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClickEvt, true);
    // Clear both setTimeout and setInterval handles
    spawnTimers.forEach(t => { clearTimeout(t); clearInterval(t); });
    overlay.style.transition = 'opacity 0.6s ease';
    overlay.style.opacity = '0';
    if (introAudio) { try { introAudio.pause(); introAudio.currentTime = 0; } catch (e) { } introAudio = null; }
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '';
      overlay.style.transition = '';
      charStage.innerHTML = '';
      titleEl.style.opacity = '0';
      titleEl.style.transform = 'scale(0.4) translateY(-40px)';
      onDone();
    }, 650);
  }

  function onKey(e) { e.stopPropagation(); finish(); }
  function onClickEvt(e) { e.stopPropagation(); finish(); }

  // Enable skip after 600 ms
  setTimeout(() => {
    if (!done) {
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('click', onClickEvt, true);
    }
  }, 600);

  if (introAudio) introAudio.addEventListener('ended', finish);
  setTimeout(() => finish(), TOTAL_DURATION + 2000);
}

// ── Outro / Victory scene ─────────────────────────────────────────────────
function playKungFuPandaOutro(onDone) {
  const overlay = document.getElementById('kfp-outro-overlay');
  const bgEl = document.getElementById('kfp-outro-bg');
  const banner = document.getElementById('kfp-outro-banner');
  const imgEl = document.getElementById('kfp-outro-img');
  if (!overlay) { onDone(); return; }

  // Random background
  const bg = _KFP_BACKGROUNDS[Math.floor(Math.random() * _KFP_BACKGROUNDS.length)];
  bgEl.style.backgroundImage = `url('${bg}')`;

  // Random all-characters poster
  const poster = _KFP_POSTERS[Math.floor(Math.random() * _KFP_POSTERS.length)];
  imgEl.src = poster;

  overlay.style.display = 'flex';
  stopQuizMusic();

  // Play gong sound immediately on quiz end
  try {
    const gong = new Audio('assets/kungfu/sfx_gong_impact.mp3');
    gong.volume = 1.0;
    gong.play().catch(() => { });
  } catch (e) { }

  // Play a random vo_ sound
  let outroAudio = null;
  let themeAudio = null;
  try {
    const voSnd = _KFP_VO_SOUNDS[Math.floor(Math.random() * _KFP_VO_SOUNDS.length)];
    outroAudio = new Audio(voSnd);
    outroAudio.volume = 0.85;
    outroAudio.play().catch(() => { });
    // Also play theme music underneath vo
    themeAudio = new Audio('assets/kungfu/kfptheme.mp3');
    themeAudio.volume = 0.7; // louder theme
    themeAudio.play().catch(() => { });
  } catch (e) { }

  setTimeout(() => {
    if (banner) { banner.style.opacity = '1'; banner.style.transform = 'scale(1)'; }
  }, 400);

  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    if (outroAudio) { try { outroAudio.pause(); outroAudio.currentTime = 0; } catch (e) { } }
    if (themeAudio) { try { themeAudio.pause(); themeAudio.currentTime = 0; } catch (e) { } }
    overlay.style.display = 'none';
    banner.style.opacity = '0'; banner.style.transform = 'scale(0.5)';
    window.removeEventListener('keydown', finish);
    window.removeEventListener('click', finish);
    onDone();
  };

  setTimeout(() => {
    window.addEventListener('keydown', finish, { once: true });
    window.addEventListener('click', finish, { once: true });
  }, 500);

  if (outroAudio) outroAudio.addEventListener('ended', () => setTimeout(finish, 1500));
  setTimeout(() => finish(), 25000);
}

// ---- Ben & Holly Intro Scene ----

function playBenHollyIntro(onDone) {
  const overlay = document.getElementById('bh-intro-overlay');
  const titleBanner = document.getElementById('bh-title-banner');
  const starsEl = document.getElementById('bh-stars');
  const charStage = document.getElementById('bh-char-stage');
  if (!overlay) { onDone(); return; }

  // Close settings overlay so the intro is unobstructed
  const settingsOverlay = document.getElementById('quiz-settings-overlay');
  if (settingsOverlay) settingsOverlay.classList.remove('show');

  // Random background image (background1–4.png)
  const _BH_BGS = ['assets/bh/background1.png', 'assets/bh/background2.png', 'assets/bh/background3.png', 'assets/bh/background4.png'];
  const bhBg = _BH_BGS[Math.floor(Math.random() * _BH_BGS.length)];
  overlay.style.backgroundImage = `url('${bhBg}')`;
  overlay.style.backgroundSize = 'cover';
  overlay.style.backgroundPosition = 'center';

  // Clear any old dynamically-placed chars
  charStage.innerHTML = '';
  starsEl.innerHTML = '';

  // Star field
  for (let i = 0; i < 55; i++) {
    const s = document.createElement('div');
    const colours = ['#fde68a', '#f9a8d4', '#a5f3fc', '#c4b5fd', '#6ee7b7', '#fca5a5'];
    s.style.cssText = `position:absolute;border-radius:50%;
          width:${5 + Math.random() * 10}px;height:${5 + Math.random() * 10}px;
          background:${colours[Math.floor(Math.random() * colours.length)]};
          left:${Math.random() * 100}%;top:${Math.random() * 100}%;
          animation:bhStar ${1.8 + Math.random() * 2.5}s ease-in-out infinite;
          animation-delay:${Math.random() * 4}s`;
    starsEl.appendChild(s);
  }

  // Character manifest — name → file (use the actual assets we have)
  const CHARS = [
    { file: 'nannyplum.png', label: 'Nanny Plum', glow: 'rgba(244,114,182,0.9)' },
    { file: 'hollywand.png', label: 'Holly', glow: 'rgba(167,139,250,0.9)' },
    { file: 'ben.png', label: 'Ben', glow: 'rgba(52,211,153,0.9)' },
    { file: 'gaston.png', label: 'Gaston', glow: 'rgba(251,191,36,0.9)' },
    { file: 'wiseoldelf.png', label: 'Wise Old Elf', glow: 'rgba(96,165,250,0.9)' },
    { file: 'nannyplum.png', label: 'Nanny Plum', glow: 'rgba(244,114,182,0.9)' },
    { file: 'kingandqueen.png', label: 'King & Queen', glow: 'rgba(251,191,36,0.9)' },
    { file: 'mrmrself.png', label: 'Mr & Mrs Elf', glow: 'rgba(167,139,250,0.8)' },
    { file: 'sqiurrel.png', label: 'Squirrel', glow: 'rgba(52,211,153,0.8)' },
    { file: 'benholly.png', label: 'Together!', glow: 'rgba(249,168,212,0.9)' },
    { file: 'ben.png', label: 'Ben', glow: 'rgba(52,211,153,0.9)' },
    { file: 'hollywand.png', label: 'Holly', glow: 'rgba(167,139,250,0.9)' },
  ];

  // How to distribute 12 chars over 35 seconds — spawn every ~2.8 s
  const TOTAL_DURATION = 36000; // ms — matches audio length +1 s buffer
  const spawnInterval = Math.floor((TOTAL_DURATION * 0.75) / CHARS.length); // front-load spawns

  // Pre-compute non-overlapping grid slots (4 cols × 3 rows across top 55% of screen)
  const COLS = 4, ROWS = 3;
  const slots = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      slots.push({ col: c, row: r });
    }
  }
  // Fisher-Yates shuffle
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  let slotIdx = 0;
  let spawnTimers = [];
  let done = false;

  function spawnChar(ch) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const size = Math.floor(Math.min(vw, vh) * 0.24); // 24% of smaller screen dim

    // Pick a random edge: 0=top,1=right,2=bottom,3=left
    const edge = Math.floor(Math.random() * 4);
    let startX, startY, endX, endY;
    const margin = -size;
    switch (edge) {
      case 0: startX = Math.random() * (vw + size * 2) - size; startY = margin; break; // top
      case 1: startX = vw - margin; startY = Math.random() * (vh + size * 2) - size; break; // right
      case 2: startX = Math.random() * (vw + size * 2) - size; startY = vh - margin; break; // bottom
      default: startX = margin; startY = Math.random() * (vh + size * 2) - size; break; // left
    }
    // Land in a pre-assigned grid slot — no overlapping
    const slot = slots[slotIdx % slots.length];
    slotIdx++;
    const cellW = vw / COLS;
    const cellH = (vh * 0.55) / ROWS; // top 55% of screen
    const topOffset = vh * 0.08;       // start 8% from top (below title)
    endX = slot.col * cellW + (cellW - size) * 0.5 + (Math.random() - 0.5) * cellW * 0.18;
    endY = topOffset + slot.row * cellH + (cellH - size) * 0.5 + (Math.random() - 0.5) * cellH * 0.18;

    const wrap = document.createElement('div');
    wrap.style.cssText = `
          position:absolute;
          left:${startX}px; top:${startY}px;
          width:${size}px;
          display:flex; flex-direction:column; align-items:center; gap:4px;
          transform:rotate(${(Math.random() - 0.5) * 30}deg) scale(0.3);
          opacity:0;
          transition:left 0.9s cubic-bezier(0.175,0.885,0.32,1.275),
                     top  0.9s cubic-bezier(0.175,0.885,0.32,1.275),
                     opacity 0.5s ease,
                     transform 0.9s cubic-bezier(0.175,0.885,0.32,1.275);
          pointer-events:none;
          z-index:${2 + Math.floor(Math.random() * 8)};
        `;
    const img = document.createElement('img');
    img.src = `assets/bh/${ch.file}`;
    img.alt = ch.label;
    img.style.cssText = `width:100%;height:auto;filter:drop-shadow(0 8px 32px ${ch.glow})`;
    const lbl = document.createElement('div');
    lbl.textContent = ch.label;
    lbl.style.cssText = `font-family:'Comic Sans MS',cursive;font-size:${Math.max(10, size * 0.09)}px;
          font-weight:700;color:rgba(255,255,255,0.85);letter-spacing:0.04em;
          text-transform:uppercase;white-space:nowrap;
          text-shadow:0 2px 8px rgba(0,0,0,0.8)`;
    wrap.appendChild(img); wrap.appendChild(lbl);
    charStage.appendChild(wrap);

    // Trigger transition on next frame
    requestAnimationFrame(() => requestAnimationFrame(() => {
      wrap.style.left = `${endX}px`;
      wrap.style.top = `${endY}px`;
      wrap.style.opacity = '1';
      wrap.style.transform = `rotate(${(Math.random() - 0.5) * 8}deg) scale(1)`;
      // Gentle bob after landing
      setTimeout(() => {
        wrap.style.transition = `transform 2s ease-in-out infinite alternate`;
        wrap.style.transform = `rotate(${(Math.random() - 0.5) * 6}deg) scale(${0.97 + Math.random() * 0.06})`;
      }, 1000);
    }));
  }

  // Show overlay
  overlay.style.opacity = '0';
  overlay.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    overlay.style.transition = 'opacity 0.4s ease';
    overlay.style.opacity = '1';
    // Animate title banner
    titleBanner.style.opacity = '1';
    titleBanner.style.transform = 'scale(1) translateY(0)';
  }));

  // Play intro audio
  let introAudio = null;
  try {
    introAudio = new Audio('assets/bh/bnh_intro.webm');
    introAudio.volume = 0.88;
    const playPromise = introAudio.play();
    if (playPromise) playPromise.catch(() => { });
  } catch (e) { }

  // Schedule character spawns
  CHARS.forEach((ch, i) => {
    const t = setTimeout(() => { if (!done) spawnChar(ch); }, i * spawnInterval);
    spawnTimers.push(t);
  });

  function finish() {
    if (done) return;
    done = true;
    // Remove all skip listeners immediately — prevents ghost keystrokes
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClickEvt, true);
    // Cancel pending spawns
    spawnTimers.forEach(t => clearTimeout(t));
    // Fade out
    overlay.style.transition = 'opacity 0.6s ease';
    overlay.style.opacity = '0';
    if (introAudio) { try { introAudio.pause(); introAudio.currentTime = 0; } catch (e) { } introAudio = null; }
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '';
      overlay.style.transition = '';
      charStage.innerHTML = '';
      starsEl.innerHTML = '';
      titleBanner.style.opacity = '0';
      titleBanner.style.transform = 'scale(0.5) translateY(-60px)';
      onDone();
    }, 650);
  }

  function onKey(e) { e.stopPropagation(); finish(); }
  function onClickEvt(e) { e.stopPropagation(); finish(); }

  // Enable skip after 600 ms so the START QUIZ click doesn't immediately skip
  setTimeout(() => {
    if (!done) {
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('click', onClickEvt, true);
    }
  }, 600);

  // Auto-end: audio end event + absolute cap at 37 s
  if (introAudio) introAudio.addEventListener('ended', finish);
  setTimeout(() => finish(), 37000);
}

// ---- Ben & Holly Outro Scene (Victory) ----
function playBenHollyOutro(onDone) {
  const overlay = document.getElementById('bh-outro-overlay');
  const starsEl = document.getElementById('bh-outro-stars');
  const banner = document.getElementById('bh-outro-banner');
  if (!overlay) { onDone(); return; }

  // Stars
  starsEl.innerHTML = '';
  for (let i = 0; i < 40; i++) {
    const s = document.createElement('div');
    s.style.cssText = `position:absolute;border-radius:50%;width:${4 + Math.random() * 8}px;height:${4 + Math.random() * 8}px;background:#fde68a;left:${Math.random() * 100}%;top:${Math.random() * 100}%;animation:bhStar ${2 + Math.random() * 3}s infinite;animation-delay:${Math.random() * 5}s`;
    starsEl.appendChild(s);
  }

  overlay.style.display = 'flex';
  stopQuizMusic();

  let outroAudio = null;
  try {
    outroAudio = new Audio('assets/bh/count_elfband.mp3');
    outroAudio.volume = 0.6;
    outroAudio.play().catch(() => { });
  } catch (e) { }

  setTimeout(() => {
    if (banner) { banner.style.opacity = '1'; banner.style.transform = 'scale(1)'; }
  }, 500);

  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    if (outroAudio) { try { outroAudio.pause(); outroAudio.currentTime = 0; } catch (e) { } }
    overlay.style.display = 'none';
    window.removeEventListener('keydown', finish);
    overlay.removeEventListener('click', finish);
    onDone();
  };
  // Listen on WINDOW for both key and click so children don't swallow events
  setTimeout(() => {
    window.addEventListener('keydown', finish, { once: true });
    window.addEventListener('click', finish, { once: true });
  }, 500);

  if (outroAudio) outroAudio.addEventListener('ended', finish);
  setTimeout(() => finish(), 28000);
}

// Override showQuizWin to support theme celebrations
function showQuizWin() {
  const standardFinish = () => {
    const overlay = document.getElementById('quiz-win-overlay');
    const msg = document.getElementById('quiz-win-message');
    if (msg) msg.textContent = `Amazing! You got ${quizScore} correct answer${quizScore !== 1 ? 's' : ''} in a row!`;
    if (overlay) overlay.classList.add('show');
    stopQuizMusic();
  };
  if (quizSettings.theme === 'ben-holly') playBenHollyOutro(standardFinish);
  else if (quizSettings.theme === 'kung-fu-panda') playKungFuPandaOutro(standardFinish);
  else standardFinish();
}
function _doStartQuiz() {
  // Close settings if open
  document.getElementById('quiz-settings-overlay').classList.remove('show');
  // Hide win overlay
  const winOverlay = document.getElementById('quiz-win-overlay');
  if (winOverlay) winOverlay.classList.remove('show');

  // Ensure quiz view is showing and mode is set (prevents landing-page jump)
  mode = 'quiz';
  viewLanding.classList.add('hidden');
  viewEducation.classList.add('hidden');
  viewEdit.classList.add('hidden');
  viewMathGame.classList.add('hidden');
  viewPeppaGame.classList.add('hidden');
  if (viewQuiz) viewQuiz.classList.remove('hidden');
  categoryTabs.classList.add('hidden');
  btnLogout.classList.add('hidden');
  enterQuizHeaderMode();

  // Reset per-game state — load subject-scoped history fresh each game start
  quizScore = 0;
  quizCurrentQ = null;
  quizAskedQuestions = loadQuizAsked(); // load history for this exact subject combination
  quizQuestionQueue = [];  // discard pre-fetched queue from prior settings
  quizHistory = []; quizHistoryIdx = -1;
  quizRenderGen++;
  updateQuizScoreBar();
  // Start music
  startQuizMusic();
  // Log active subjects for debugging
  console.log('[Quiz] Starting — subjects:', quizSettings.subjects, '| Storage key:', _quizAskedKey(), '| Known:', quizAskedQuestions.length);
  // Generate first question
  generateQuizQuestion();
}

// Holds a pre-fetch promise started during the theme intro
let _introPrefetchPromise = null;

window.startQuiz = () => {
  if (quizSettings.theme === 'ben-holly') {
    // Kick off AI generation immediately while intro plays
    _introPrefetchPromise = fetchQuizBatch().catch(() => null);
    // Play intro first; _doStartQuiz fires exactly once when intro ends/is skipped
    playBenHollyIntro(() => _doStartQuiz());
    return;
  }
  if (quizSettings.theme === 'kung-fu-panda') {
    // Kick off AI generation immediately while intro plays
    _introPrefetchPromise = fetchQuizBatch().catch(() => null);
    // Play KFP intro first; _doStartQuiz fires exactly once when intro ends/is skipped
    playKungFuPandaIntro(() => _doStartQuiz());
    return;
  }
  _doStartQuiz();
};

function setQuizMode() {
  mode = 'quiz';
  document.body.classList.add('quiz-active');
  isEditMode = false;
  viewLanding.classList.add('hidden');
  viewEducation.classList.add('hidden');
  viewEdit.classList.add('hidden');
  viewMathGame.classList.add('hidden');
  viewPeppaGame.classList.add('hidden');
  if (viewQuiz) viewQuiz.classList.remove('hidden');
  categoryTabs.classList.add('hidden');
  btnLogout.classList.add('hidden');

  // Swap header buttons to quiz controls (double-click required)
  enterQuizHeaderMode();

  // Show settings first, let user configure before starting
  initQuizSettingsUI();
  quizScore = 0;
  quizCurrentQ = null;
  // DO NOT clear quizAskedQuestions here — it is persisted across sessions
  quizQuestionQueue = [];
  quizHistory = []; quizHistoryIdx = -1;
  quizRenderGen++;
  updateQuizScoreBar();
  // Show a placeholder while settings are visible
  const questionEl = document.getElementById('quiz-display-question');
  if (questionEl) questionEl.textContent = 'Configure your quiz below and press Start!';
  const grid = document.getElementById('quiz-answers-grid');
  if (grid) grid.innerHTML = '';
  // Open settings automatically
  document.getElementById('quiz-settings-overlay').classList.add('show');
}

// Navigation Event Listeners
const logoElement = document.getElementById('logo');
if (logoElement) {
  logoElement.ondblclick = () => setMode('landing');
}

if (btnEducation) {
  // Context-aware: in quiz mode single click does nothing (need dblclick),
  // in all other modes single click goes to education mode.
  btnEducation.addEventListener('click', () => {
    if (mode !== 'quiz') setMode('education');
  });
}

if (btnEdit) {
  // Context-aware: in quiz mode single click does nothing (need dblclick for Exit),
  // in all other modes double-click goes to edit mode.
  btnEdit.addEventListener('dblclick', () => {
    if (mode !== 'quiz') setMode('edit');
  });
}

btnPrevEdu.addEventListener('dblclick', () => {
  if (currentQuestionIndex > 0) {
    currentQuestionIndex--;
    selectedId = null; wrongSelectionsCount = {};
    renderEducationBoard();
  }
});

btnNextEdu.addEventListener('dblclick', () => {
  const list = appData.categories[appData.selectedCategory || 'Activity'];
  if (currentQuestionIndex < list.length - 1) {
    currentQuestionIndex++;
    selectedId = null; wrongSelectionsCount = {};
    renderEducationBoard();
  }
});

// Quiz nav arrows (dblclick, same as edu mode)
const btnQuizPrev = document.getElementById('btn-quiz-prev');
const btnQuizNext = document.getElementById('btn-quiz-next');
if (btnQuizPrev) btnQuizPrev.addEventListener('dblclick', () => quizNavPrev());
if (btnQuizNext) btnQuizNext.addEventListener('dblclick', () => quizNavNext());

// Edit nav
btnPrevEdit.addEventListener('click', () => {
  if (currentQuestionIndex > 0) {
    currentQuestionIndex--;
    renderEditBoard();
  }
});
btnNextEdit.addEventListener('click', () => {
  const list = appData.categories[appData.selectedCategory || 'Activity'];
  if (currentQuestionIndex < list.length - 1) {
    currentQuestionIndex++;
    renderEditBoard();
  }
});
btnAddQ.addEventListener('click', () => {
  const limit = (user && user.isGuest) ? 50 : 100;
  const list = appData.categories[appData.selectedCategory || 'Activity'];
  if (list.length >= limit) {
    showToast(`Limit reached: ${limit} questions max per category.`, 'error');
    return;
  }
  list.push(initData());
  currentQuestionIndex = list.length - 1;
  saveData();
  renderEditBoard();
});
btnDeleteQ.addEventListener('click', () => {
  const list = appData.categories[appData.selectedCategory || 'Activity'];
  if (list.length > 0) {
    list.splice(currentQuestionIndex, 1);
    if (currentQuestionIndex >= list.length) {
      currentQuestionIndex = Math.max(0, list.length - 1);
    }
    saveData();
    renderEditBoard();
  }
});

const displayQCountEdu = document.getElementById('display-q-count-edu');
// Track question read timer state
let qReadTimerId = null;
let _qReadOnEnter = null;
let _qReadOnLeave = null;
let _qReadOnClick = null;

function renderEducationBoard() {
  renderGen++;
  const currentGen = renderGen;
  const q = getActiveQ();
  const list = appData.categories[appData.selectedCategory || 'Activity'];

  const noQuestions = list.length === 0;
  viewEducation.classList.toggle('hidden', noQuestions && mode === 'education');

  if (noQuestions) {
    displayQuestion.textContent = "No questions in this category.";
    displayQCountEdu.textContent = "Empty";
    answersGrid.innerHTML = '';
    return;
  }

  prepareHighlightableText(displayQuestion, q.question);
  displayQuestion.dataset.prepared = 'true';
  displayQCountEdu.textContent = `Question ${currentQuestionIndex + 1} of ${list.length}`;

  btnPrevEdu.disabled = currentQuestionIndex === 0;
  btnNextEdu.disabled = currentQuestionIndex === list.length - 1;

  renderCategoryTabs();

  // Question read time: add border & progress around question area
  const questionContainer = displayQuestion.parentElement;
  questionContainer.style.border = '1px solid rgba(148, 163, 184, 0.25)';
  questionContainer.style.borderRadius = '1rem';
  questionContainer.style.padding = '1.5rem';
  questionContainer.style.position = 'relative';
  questionContainer.style.overflow = 'hidden';

  // Remove any existing progress bar from question container
  const existingBar = questionContainer.querySelector('.qread-progress-bar');
  if (existingBar) existingBar.remove();

  // Clear any previous read timer and hover/click listeners
  if (qReadTimerId) { cancelAnimationFrame(qReadTimerId); qReadTimerId = null; }
  if (_qReadOnEnter) { questionContainer.removeEventListener('mouseenter', _qReadOnEnter); _qReadOnEnter = null; }
  if (_qReadOnLeave) { questionContainer.removeEventListener('mouseleave', _qReadOnLeave); _qReadOnLeave = null; }
  if (_qReadOnClick) { questionContainer.removeEventListener('click', _qReadOnClick); _qReadOnClick = null; }
  questionContainer.style.cursor = '';

  const colCount = q.cols || 2;
  const colClass = colCount === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2';
  const isMaxSpacing = q.maximizeSpacing;
  const gapClass = isMaxSpacing ? 'gap-10 md:gap-12' : 'gap-6';

  answersGrid.className = `grid grid-cols-1 ${colClass} ${gapClass} w-full max-w-5xl flex-1 min-h-0 py-4 ${isMaxSpacing ? 'overflow-hidden' : ''}`;

  if (isMaxSpacing) {
    const rowCount = q.rows || 2;
    answersGrid.style.setProperty('grid-template-rows', `repeat(${rowCount}, 1fr)`, 'important');
  } else {
    answersGrid.style.removeProperty('grid-template-rows');
  }

  answersGrid.innerHTML = '';

  // Check if question read time is enabled
  const shouldDelayAnswers = q.qReadEnabled && q.qReadTimeMs > 0 && !selectedId;
  if (shouldDelayAnswers) {
    // Hide answers initially
    answersGrid.style.opacity = '0';
    answersGrid.style.pointerEvents = 'none';
    answersGrid.style.transition = 'opacity 0.4s ease';

    // Add progress bar to question container
    const qProgressBar = document.createElement('div');
    qProgressBar.className = 'qread-progress-bar';
    qProgressBar.style.cssText = 'position:absolute;bottom:0;left:0;height:3px;background:linear-gradient(90deg,#3b82f6,#06b6d4);width:0%;transition:none;z-index:10;border-radius:0 2px 2px 0;';
    questionContainer.appendChild(qProgressBar);

    // Hover-driven timer: only progresses while mouse is over the question
    let qReadElapsed = 0;
    let qReadHovering = false;
    let qReadLastTime = null;
    let qReadDone = false;

    const animateQRead = (time) => {
      if (currentGen !== renderGen) return;
      if (qReadDone) return;

      if (qReadHovering) {
        if (qReadLastTime === null) qReadLastTime = time;
        qReadElapsed += (time - qReadLastTime);
        qReadLastTime = time;
      } else {
        qReadLastTime = null;
      }

      const progress = Math.min((qReadElapsed / q.qReadTimeMs) * 100, 100);
      qProgressBar.style.width = `${progress}%`;

      if (progress >= 100) {
        qReadDone = true;
        answersGrid.style.opacity = '1';
        answersGrid.style.pointerEvents = '';
        qProgressBar.style.background = 'linear-gradient(90deg,#10b981,#06b6d4)';
        setTimeout(() => { if (qProgressBar.parentNode) qProgressBar.style.opacity = '0'; }, 600);
        qReadTimerId = null;
        // Clean up hover/click listeners
        questionContainer.removeEventListener('mouseenter', onQEnter);
        questionContainer.removeEventListener('mouseleave', onQLeave);
        questionContainer.removeEventListener('click', onQClick);
        questionContainer.style.cursor = '';
        return;
      }
      qReadTimerId = requestAnimationFrame(animateQRead);
    };

    const onQEnter = () => { qReadHovering = true; };
    const onQLeave = () => { qReadHovering = false; qReadLastTime = null; };
    const onQClick = () => { qReadElapsed = q.qReadTimeMs; };

    // Store refs for cleanup on next render
    _qReadOnEnter = onQEnter;
    _qReadOnLeave = onQLeave;
    _qReadOnClick = onQClick;

    questionContainer.addEventListener('mouseenter', onQEnter);
    questionContainer.addEventListener('mouseleave', onQLeave);
    questionContainer.addEventListener('click', onQClick);
    questionContainer.style.cursor = 'pointer';

    qReadTimerId = requestAnimationFrame(animateQRead);
  } else {
    answersGrid.style.opacity = '1';
    answersGrid.style.pointerEvents = '';
    answersGrid.style.transition = '';
  }
  getActiveQ().answers.forEach(answer => {
    const isSelected = selectedId === answer.id;
    const isCorrect = getActiveQ().correctAnswerIds.includes(answer.id);

    const card = document.createElement('div');
    let hClass = "h-56";
    if (isMaxSpacing) {
      // Proportional heights for no-scroll
      const rowCount = getActiveQ().rows;
      if (rowCount === 3) hClass = "h-1/4";
      else if (rowCount === 2) hClass = "h-2/5";
      else hClass = "h-4/5";

      // Ensure it uses height flex
      card.style.height = "auto";
      card.style.flex = "1";
    } else {
      if (getActiveQ().rows === 3) hClass = "h-32";
      else if (getActiveQ().rows === 2 && getActiveQ().cols === 3) hClass = "h-40";
      else if (getActiveQ().rows === 1) hClass = "h-64";
    }

    let basePin = answer.image ? 'p-0' : 'p-6';
    let baseClasses = `relative overflow-hidden rounded-2xl ${basePin} ${hClass} flex items-center justify-center cursor-pointer transition-all duration-300 transform outline outline-2 outline-offset-4 select-none `;

    if (isSelected) {
      if (isCorrect) {
        baseClasses += "text-white ";
      } else {
        // Selected but wrong
        const count = wrongSelectionsCount[answer.id] || 1;
        let symbolClass = "wrong-cross";
        if (count % 4 === 2) symbolClass = "wrong-ban";
        else if (count % 4 === 3) symbolClass = "wrong-question";
        else if (count % 4 === 0) symbolClass = "wrong-dash";

        baseClasses += `bg-slate-700 outline-red-500/50 ${symbolClass} text-slate-300 `;
      }
    } else {
      baseClasses += "bg-slate-800 outline-transparent hover:bg-slate-700 hover:shadow-xl ";
    }

    card.className = baseClasses;

    // Apply persistent green for correctly selected answer via inline styles
    if (isSelected && isCorrect) {
      card.style.background = '#10b981';
      card.style.border = 'none';
      card.style.outline = 'none';
      card.style.transform = 'scale(1.03)';
      card.style.cursor = 'default';
    }

    const innerContainer = document.createElement('div');
    innerContainer.className = 'flex flex-col items-center justify-center gap-3 w-full h-full z-10 pointer-events-none' + (answer.image ? '' : ' p-2');

    let textClass = 'text-3xl font-semibold text-center transition-colors ';
    if (answer.image) {
      const imgEl = document.createElement('img');
      imgEl.src = answer.image;
      imgEl.className = 'absolute inset-0 w-full h-full object-cover transition-opacity z-0 ';
      if (isSelected) {
        imgEl.classList.add(isCorrect ? 'opacity-100' : 'opacity-40');
      }
      card.appendChild(imgEl);

      textClass = 'text-xl md:text-2xl font-bold text-center transition-colors drop-shadow-md py-2 px-3 block w-full bg-slate-900/80 backdrop-blur-sm shadow-xl mt-auto ';
      innerContainer.className = 'absolute inset-0 flex flex-col items-center justify-end w-full h-full z-10 pointer-events-none';
    }

    const textSpan = document.createElement('span');
    textSpan.className = textClass + (isSelected ? (isCorrect ? 'text-white' : 'text-slate-100 opacity-50') : 'text-slate-100');
    prepareHighlightableText(textSpan, answer.text);
    textSpan.dataset.prepared = 'true';

    if (answer.text.trim().length > 0) {
      innerContainer.appendChild(textSpan);
    }

    card.appendChild(innerContainer);

    const allowDwell = !isSelected || (isSelected && !isCorrect);
    if (allowDwell) {
      // Progress bar base
      const progressBar = document.createElement('div');
      progressBar.className = "absolute bottom-0 left-0 h-1.5 bg-blue-500/30 transition-none z-10";
      progressBar.style.width = "0%";
      card.appendChild(progressBar);

      // SVG Overlay definition
      let timer = null;
      let svgOverlay = null;

      const removeOverlay = () => {
        if (svgOverlay && svgOverlay.parentNode === card) {
          card.removeChild(svgOverlay);
          svgOverlay = null;
        }
      };

      const addOverlay = () => {
        if (!svgOverlay) {
          svgOverlay = document.createElement('div');
          // Made background transparent and removed backdrop blur
          svgOverlay.className = "absolute inset-0 flex items-center justify-center z-20 pointer-events-none";
          svgOverlay.innerHTML = `<svg class="w-32 h-32 transform -rotate-90">
                       <circle cx="64" cy="64" r="48" class="text-slate-700/80" stroke-width="8" stroke="currentColor" fill="transparent" />
                       <circle cx="64" cy="64" r="48" class="text-orange-400 drop-shadow-md progress-circle" style="opacity: 0.5" stroke-width="8" stroke-dasharray="301.59" stroke-dashoffset="301.59" stroke-linecap="round" stroke="currentColor" fill="transparent" />
                    </svg>`;
          card.appendChild(svgOverlay);
        }
      };

      const doSelect = () => {
        selectedId = answer.id;
        if (getActiveQ().correctAnswerIds.includes(answer.id)) {
          // Immediate green success feedback via inline styles
          card.style.background = '#10b981';
          card.style.border = 'none';
          card.style.outline = 'none';
          card.style.animation = 'successBounce 0.75s ease';
          card.style.transform = 'scale(1.03)';
          card.style.cursor = 'default';
          const cardSpan = card.querySelector('span');
          if (cardSpan) { cardSpan.style.color = 'white'; cardSpan.style.textShadow = '0 2px 4px rgba(0,0,0,0.3)'; }
          playSuccessSound();
          // Delay re-render so the green animation is visible
          setTimeout(() => renderEducationBoard(), 600);
        } else {
          playWrongSound();
          wrongSelectionsCount[answer.id] = (wrongSelectionsCount[answer.id] || 0) + 1;
          renderEducationBoard();
        }
      };

      const startDwell = () => {
        let start = null;

        const animate = (time) => {
          if (currentGen !== renderGen) return; // Prevent ghost timers
          if (start === null) start = time;
          const elapsed = time - start;
          const progress = Math.min((elapsed / getActiveQ().dwellTimeMs) * 100, 100);

          progressBar.style.width = `${progress}%`;
          if (progress > 0) {
            addOverlay();
            const circle = svgOverlay.querySelector('.progress-circle');
            if (circle) {
              const circumference = 48 * 2 * Math.PI;
              const offset = circumference - (progress / 100) * circumference;
              circle.style.strokeDashoffset = offset;
            }
          }

          if (progress >= 100) {
            doSelect();
          } else {
            timer = requestAnimationFrame(animate);
          }
        };
        timer = requestAnimationFrame(animate);
      };

      const stopDwell = () => {
        if (timer) cancelAnimationFrame(timer);
        progressBar.style.width = "0%";
        removeOverlay();
      };

      card.addEventListener('mouseenter', startDwell);
      card.addEventListener('mouseleave', stopDwell);
      card.addEventListener('click', doSelect);

      // touch support
      card.addEventListener('touchstart', (e) => { e.preventDefault(); startDwell() });
      card.addEventListener('touchend', (e) => { e.preventDefault(); stopDwell(); doSelect(); });
      card.addEventListener('touchcancel', (e) => { e.preventDefault(); stopDwell() });
    }

    answersGrid.appendChild(card);
  });
  // After a frame, measure remaining viewport and set grid height precisely.
  requestAnimationFrame(() => _sizeAnswerGrid());
}

function renderEditBoard() {
  const q = getActiveQ();
  const list = appData.categories[appData.selectedCategory || 'Activity'];

  displayQCount.textContent = `${list.length > 0 ? (currentQuestionIndex + 1) : 0} / ${list.length}`;
  btnPrevEdit.disabled = currentQuestionIndex === 0 || list.length === 0;
  btnNextEdit.disabled = currentQuestionIndex === (list.length - 1) || list.length === 0;

  renderCategoryTabs();

  if (!q) {
    inputQuestion.value = "";
    editAnswersContainer.innerHTML = '<div class="col-span-full p-10 text-center text-slate-500">Add a question to start editing.</div>';
    btnDeleteQ.classList.add('hidden');
    // Clear sidebar anyway
    const navList = document.getElementById('edit-nav-list');
    if (navList) navList.innerHTML = '';
    return;
  }

  inputQuestion.value = q.question;
  inputLayout.value = `${q.rows || 2}x${q.cols || 2}`;
  inputSelectionType.value = q.selectionType || 'single';
  inputDwell.value = q.dwellTimeMs || appData.dwellTimeMs || 2000;
  inputDwellSlider.value = q.dwellTimeMs || appData.dwellTimeMs || 2000;
  inputMaxSpacing.checked = !!q.maximizeSpacing;

  btnDeleteQ.classList.toggle('hidden', list.length <= 1);

  // Render Sidebar
  const navList = document.getElementById('edit-nav-list');
  navList.innerHTML = '';
  list.forEach((question, idx) => {
    const item = document.createElement('button');
    const isActive = idx === currentQuestionIndex;
    item.className = `flex gap-3 items-center p-3 rounded-lg text-left transition-all group ${isActive ? 'bg-blue-600 shadow-lg' : 'bg-slate-900 hover:bg-slate-700'}`;

    const idxSpan = document.createElement('span');
    idxSpan.className = `flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-md font-bold text-xs ${isActive ? 'bg-blue-400 text-white' : 'bg-slate-800 text-slate-500 group-hover:text-slate-300'}`;
    idxSpan.textContent = `#${idx + 1}`;

    const textSpan = document.createElement('span');
    textSpan.className = `text-xs font-semibold truncate flex-1 ${isActive ? 'text-white' : 'text-slate-400'}`;
    textSpan.textContent = question.question || '(Untitled)';

    item.appendChild(idxSpan);
    item.appendChild(textSpan);
    item.onclick = () => {
      currentQuestionIndex = idx;
      renderEditBoard();
    };
    navList.appendChild(item);
  });

  // Event Handlers
  inputQuestion.oninput = (e) => { q.question = e.target.value; saveData(); };
  inputMaxSpacing.onchange = (e) => { q.maximizeSpacing = e.target.checked; saveData(); };

  const syncDwell = (val) => {
    q.dwellTimeMs = Number(val);
    inputDwell.value = val;
    inputDwellSlider.value = val;
    saveData();
  };

  inputDwell.oninput = (e) => syncDwell(e.target.value);
  inputDwellSlider.oninput = (e) => syncDwell(e.target.value);

  btnApplyAllDwell.onclick = () => {
    const currentDwell = q.dwellTimeMs;
    list.forEach(question => {
      question.dwellTimeMs = currentDwell;
    });
    saveData();
    showToast(`Applied ${currentDwell}ms dwell time to all ${list.length} questions in this category!`);
  };

  // Question Read Time controls
  inputQReadEnabled.checked = !!q.qReadEnabled;
  inputQRead.value = q.qReadTimeMs !== undefined ? q.qReadTimeMs : 1000;
  inputQReadSlider.value = q.qReadTimeMs !== undefined ? q.qReadTimeMs : 1000;

  // Toggle enabled/disabled state of controls
  const updateQReadControlsState = () => {
    if (inputQReadEnabled.checked) {
      qreadControls.classList.remove('opacity-40', 'pointer-events-none');
    } else {
      qreadControls.classList.add('opacity-40', 'pointer-events-none');
    }
  };
  updateQReadControlsState();

  inputQReadEnabled.onchange = (e) => {
    q.qReadEnabled = e.target.checked;
    updateQReadControlsState();
    saveData();
  };

  const syncQRead = (val) => {
    q.qReadTimeMs = Number(val);
    inputQRead.value = val;
    inputQReadSlider.value = val;
    saveData();
  };
  inputQRead.oninput = (e) => syncQRead(e.target.value);
  inputQReadSlider.oninput = (e) => syncQRead(e.target.value);

  btnApplyAllQRead.onclick = () => {
    const currentQRead = q.qReadTimeMs;
    const currentEnabled = q.qReadEnabled;
    list.forEach(question => {
      question.qReadTimeMs = currentQRead;
      question.qReadEnabled = currentEnabled;
    });
    saveData();
    showToast(`Applied ${currentQRead}ms question read time to all ${list.length} questions in this category!`);
  };

  inputSelectionType.onchange = (e) => {
    q.selectionType = e.target.value;
    if (q.selectionType === 'single' && q.correctAnswerIds.length > 1) {
      q.correctAnswerIds = [q.correctAnswerIds[0]];
    }
    saveData();
    renderEditBoard();
  };

  inputLayout.onchange = (e) => {
    const [r, c] = e.target.value.split('x').map(Number);
    q.rows = r;
    q.cols = c;
    const total = r * c;
    while (q.answers.length < total) {
      q.answers.push({ id: Date.now().toString() + Math.random(), text: 'New Answer' });
    }
    if (q.answers.length > total) {
      q.answers = q.answers.slice(0, total);
    }
    q.correctAnswerIds = q.correctAnswerIds.filter(id => q.answers.find(a => a.id === id));
    if (q.selectionType === 'single' && q.correctAnswerIds.length === 0 && q.answers.length > 0) {
      q.correctAnswerIds = [q.answers[0].id];
    }
    saveData();
    renderEditBoard();
  };

  editAnswersContainer.innerHTML = '';
  q.answers.forEach((answer, index) => {
    const div = document.createElement('div');
    div.className = "flex flex-col gap-2 p-4 bg-slate-900 border border-slate-700 rounded-lg relative overflow-hidden";

    const isCorrect = q.correctAnswerIds.includes(answer.id);
    const inputType = q.selectionType === 'multi' ? 'checkbox' : 'radio';

    div.innerHTML = `
           <div class="flex items-center justify-between mb-1">
              <label class="text-sm font-medium text-slate-400">Answer ${index + 1}</label>
              <label class="flex items-center gap-2 text-sm text-emerald-400 cursor-pointer">
                 <input type="${inputType}" name="correctAnswer" value="${answer.id}" ${isCorrect ? 'checked' : ''} class="w-4 h-4 text-emerald-500 bg-slate-800 border-slate-600 focus:ring-emerald-500">
                 Correct
              </label>
           </div>
           <input type="text" value="${answer.text}" class="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-slate-100 focus:outline-none focus:border-blue-500 transition-all">
           <div class="flex items-center gap-3 mt-1">
              <button class="btn-upload text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-600 transition-colors">
                 ${answer.image ? 'Change Image' : 'Add Image'}
              </button>
              <input type="file" accept="image/*" class="file-input hidden">
              ${answer.image ? `
                 <img src="${answer.image}" class="h-8 w-8 object-cover rounded shadow-sm border border-slate-600">
                 <button class="btn-remove-img text-xs text-red-400 hover:text-red-300 ml-auto">Remove</button>
              ` : ''}
           </div>
         `;

    const textInput = div.querySelector('input[type="text"]');
    textInput.oninput = (e) => { answer.text = e.target.value; saveData(); };

    const fileInput = div.querySelector('.file-input');
    const btnUpload = div.querySelector('.btn-upload');
    const btnRemove = div.querySelector('.btn-remove-img');

    btnUpload.onclick = () => fileInput.click();
    fileInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        btnUpload.textContent = "Processing...";
        const dataUrl = await resizeImageFileToDataURL(file, 400);
        answer.image = dataUrl;
        saveData();
        renderEditBoard();
      } catch (err) {
        console.error(err);
        showToast("Failed to read image", "error");
        btnUpload.textContent = "Try Again";
      }
    };

    if (btnRemove) {
      btnRemove.onclick = () => {
        delete answer.image;
        saveData();
        renderEditBoard();
      };
    }

    const checkInput = div.querySelector(`input[type="${inputType}"]`);
    checkInput.onchange = (e) => {
      if (q.selectionType === 'multi') {
        if (e.target.checked) {
          if (!q.correctAnswerIds.includes(e.target.value)) q.correctAnswerIds.push(e.target.value);
        } else {
          q.correctAnswerIds = q.correctAnswerIds.filter(id => id !== e.target.value);
        }
      } else {
        if (e.target.checked) q.correctAnswerIds = [e.target.value];
      }
      saveData();
    }

    editAnswersContainer.appendChild(div);
  });
}

// Export for debugging if needed
window.logout = () => signOut(auth);

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  // Mode Toggle Ctrl+E
  if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) {
    e.preventDefault();
    setMode(mode === 'education' ? 'edit' : 'education');
  }

  // Navigation
  if (mode === 'education') {
    if (e.key === 'ArrowRight') {
      const list = appData.categories[appData.selectedCategory || 'Activity'];
      if (currentQuestionIndex < list.length - 1) {
        currentQuestionIndex++;
        selectedId = null; wrongSelectionsCount = {};
        renderEducationBoard();
      }
    } else if (e.key === 'ArrowLeft') {
      if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        selectedId = null; wrongSelectionsCount = {};
        renderEducationBoard();
      }
    }
  } else if (mode === 'quiz') {
    if (e.key === 'ArrowRight') { e.preventDefault(); quizNavNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); quizNavPrev(); }
  } else if (mode === 'edit') {
    // Check if typing in a text field
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT') {
      return;
    }
    if (e.key === 'ArrowRight') {
      const list = appData.categories[appData.selectedCategory || 'Activity'];
      if (currentQuestionIndex < list.length - 1) {
        currentQuestionIndex++;
        renderEditBoard();
      }
    } else if (e.key === 'ArrowLeft') {
      if (currentQuestionIndex > 0) {
        currentQuestionIndex--;
        renderEditBoard();
      }
    }
  }
});

const categoryTabsContainer = document.getElementById('category-tabs');
function renderCategoryTabs() {
  categoryTabsContainer.innerHTML = '';
  const inEducation = mode === 'education';
  CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    const isActive = appData.selectedCategory === cat;
    btn.className = `px-4 py-2 rounded-full text-xs font-bold transition-all uppercase tracking-widest ${isActive ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-800 text-slate-500' + (inEducation ? '' : ' hover:bg-slate-700')}`;
    btn.textContent = cat;
    if (inEducation) {
      btn.style.pointerEvents = 'none';
      if (!isActive) btn.style.opacity = '0.5';
    } else {
      btn.onclick = () => {
        appData.selectedCategory = cat;
        currentQuestionIndex = 0;
        if (mode === 'education') renderEducationBoard();
        else renderEditBoard();
        saveData();
      };
    }
    categoryTabsContainer.appendChild(btn);
  });
}
renderCategoryTabs();
onAuthStateChanged(auth, handleAuthStateChanged);
// Settings event listener for Peppa speed
const peppaSpeedInput = document.getElementById('input-peppa-speed');
if (peppaSpeedInput) {
  peppaSpeedInput.oninput = (e) => {
    appData.peppaSpeed = parseFloat(e.target.value);
    updatePeppaSpeedFactor();
  };
}
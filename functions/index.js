const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

// Initialize Admin SDK (idempotent)
if (!admin.apps.length) {
  admin.initializeApp();
}

const geminiApiKey   = defineSecret('GEMINI_API_KEY');
const pixabayApiKey  = defineSecret('PIXABAY_API_KEY');
const unsplashApiKey = defineSecret('UNSPLASH_ACCESS_KEY');

const GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Secure proxy for Gemini API — keeps the API key server-side.
 * Firebase Hosting rewrites POST /api/quiz-generate to this function.
 */
exports.quizGenerate = onRequest(
  {
    secrets: [geminiApiKey],
    cors: true,
    invoker: 'public',
    timeoutSeconds: 60,
    memory: '256MiB',
    region: 'us-central1',
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const apiKey = geminiApiKey.value();
    if (!apiKey) {
      res.status(503).json({ error: 'GEMINI_API_KEY secret not configured' });
      return;
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    try {
      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });

      const data = await response.json();
      res.set('Access-Control-Allow-Origin', '*');
      res.status(response.status).json(data);
    } catch (err) {
      console.error('[quizGenerate] Gemini API error:', err.message);
      res.status(502).json({ error: err.message });
    }
  }
);

/**
 * Secure proxy for Pixabay image search — keeps the API key server-side.
 * Firebase Hosting rewrites GET /api/pixabay-search to this function.
 * Query params: q (search term), per_page (optional, default 5)
 */
exports.pixabaySearch = onRequest(
  {
    secrets: [pixabayApiKey],
    cors: true,
    invoker: 'public',
    timeoutSeconds: 15,
    memory: '128MiB',
    region: 'us-central1',
  },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.status(204).send('');
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const apiKey = pixabayApiKey.value();
    if (!apiKey) {
      res.status(503).json({ error: 'PIXABAY_API_KEY secret not configured' });
      return;
    }

    const q        = req.query.q || '';
    const per_page = Math.min(parseInt(req.query.per_page || '5', 10), 20);

    if (!q) {
      res.status(400).json({ error: 'Missing query parameter: q' });
      return;
    }

    const pixabayUrl = `https://pixabay.com/api/?key=${apiKey}&q=${encodeURIComponent(q)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=${per_page}&min_width=400`;

    try {
      const response = await fetch(pixabayUrl);
      const data     = await response.json();
      // Return only the URLs to minimise response payload
      const hits = (data.hits || []).map(h => ({
        webformatURL: h.webformatURL,
        largeImageURL: h.largeImageURL,
        tags: h.tags,
      }));
      res.status(200).json({ hits });
    } catch (err) {
      console.error('[pixabaySearch] Pixabay API error:', err.message);
      res.status(502).json({ error: err.message });
    }
  }
);

/**
 * Secure proxy for Unsplash image search — keeps the Access Key server-side.
 * Firebase Hosting rewrites GET /api/unsplash-search to this function.
 * Query params: q (search term), per_page (optional, default 10), orientation (optional)
 */
exports.unsplashSearch = onRequest(
  {
    secrets: [unsplashApiKey],
    cors: true,
    invoker: 'public',
    timeoutSeconds: 15,
    memory: '128MiB',
    region: 'us-central1',
  },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.status(204).send('');
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const apiKey = unsplashApiKey.value();
    if (!apiKey) {
      res.status(503).json({ error: 'UNSPLASH_ACCESS_KEY secret not configured' });
      return;
    }

    const q           = req.query.q || '';
    const perPage     = Math.min(parseInt(req.query.per_page || '10', 10), 30);
    const orientation = req.query.orientation || 'landscape';

    if (!q) {
      res.status(400).json({ error: 'Missing query parameter: q' });
      return;
    }

    const unsplashUrl = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${perPage}&orientation=${orientation}`;

    try {
      const response = await fetch(unsplashUrl, {
        headers: { 'Authorization': `Client-ID ${apiKey}` }
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error('[unsplashSearch] API error:', response.status, errText.slice(0, 200));
        res.status(response.status).json({ error: errText });
        return;
      }
      const data = await response.json();
      // Normalize to hits array (same shape as Pixabay proxy for easy client use)
      const hits = (data.results || []).map(photo => ({
        webformatURL: photo.urls?.regular || photo.urls?.small,
        tags: photo.description || photo.alt_description || '',
        unsplashId: photo.id,
        credit: `Photo by ${photo.user?.name || 'Unknown'} on Unsplash`,
        creditUrl: `${photo.links?.html}?utm_source=EduGaze&utm_medium=referral`,
      }));
      res.status(200).json({ hits });
    } catch (err) {
      console.error('[unsplashSearch] Fetch error:', err.message);
      res.status(502).json({ error: err.message });
    }
  }
);

/**
 * Admin action proxy — uses Firebase Admin SDK for privileged operations.
 * Firebase Hosting rewrites POST /api/admin-action to this function.
 *
 * Body: { action: 'deleteUser'|'grantAdmin'|'revokeAdmin', targetUid: string }
 * Auth: Bearer token in Authorization header — must belong to an admin user.
 */
exports.adminAction = onRequest(
  {
    cors: true,
    invoker: 'public',
    timeoutSeconds: 30,
    memory: '128MiB',
    region: 'us-central1',
  },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    // --- Verify caller identity ---
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    const idToken = authHeader.slice(7);

    let callerUid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      callerUid = decoded.uid;
    } catch (err) {
      console.error('[adminAction] Token verification failed:', err.message);
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { action, targetUid } = req.body;
    if (!action) {
      res.status(400).json({ error: 'Missing action' });
      return;
    }

    const db   = admin.firestore();
    const auth = admin.auth();

    // --- Special bootstrap: lets the first admin elevate themselves without pre-existing admin status ---
    if (action === 'bootstrapFirstAdmin') {
      const FIRST_ADMIN_EMAIL = 'tissuepeanut@gmail.com';
      const callerRecord = await auth.getUser(callerUid);
      if (callerRecord.email !== FIRST_ADMIN_EMAIL) {
        res.status(403).json({ error: 'Not the designated first admin email' });
        return;
      }
      await db.collection('users').doc(callerUid).set({ isAdmin: true }, { merge: true });
      console.log(`[adminAction] Bootstrapped first admin ${callerUid} (${callerRecord.email})`);
      res.status(200).json({ success: true, action, targetUid: callerUid });
      return;
    }

    // --- All other actions require caller to be an admin ---
    const callerDoc = await db.collection('users').doc(callerUid).get();
    if (!callerDoc.exists || callerDoc.data().isAdmin !== true) {
      res.status(403).json({ error: 'Forbidden: caller is not an admin' });
      return;
    }

    if (!targetUid) {
      res.status(400).json({ error: 'Missing targetUid' });
      return;
    }

    // Prevent admins from demoting themselves
    if (action === 'revokeAdmin' && targetUid === callerUid) {
      res.status(400).json({ error: 'Cannot revoke your own admin rights' });
      return;
    }

    try {
      switch (action) {
        case 'deleteUser': {

          // Delete Firestore data
          await db.collection('configs').doc(targetUid).delete().catch(() => {});
          await db.collection('users').doc(targetUid).delete().catch(() => {});
          // Delete Firebase Auth account
          await auth.deleteUser(targetUid).catch(err => {
            console.warn('[adminAction] Auth delete warning:', err.message);
          });
          console.log(`[adminAction] Deleted user ${targetUid} by admin ${callerUid}`);
          res.status(200).json({ success: true, action, targetUid });
          break;
        }

        case 'grantAdmin': {
          await db.collection('users').doc(targetUid).update({ isAdmin: true });
          console.log(`[adminAction] Granted admin to ${targetUid} by ${callerUid}`);
          res.status(200).json({ success: true, action, targetUid });
          break;
        }

        case 'revokeAdmin': {
          await db.collection('users').doc(targetUid).update({ isAdmin: false });
          console.log(`[adminAction] Revoked admin from ${targetUid} by ${callerUid}`);
          res.status(200).json({ success: true, action, targetUid });
          break;
        }

        default:
          res.status(400).json({ error: `Unknown action: ${action}` });
      }
    } catch (err) {
      console.error(`[adminAction] Error executing ${action}:`, err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

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

/**
 * Comprehension Adventure — two-phase AI endpoint.
 *
 * Phase "source":  Gemini picks appropriate YouTube video / generates text passage / image keyword
 * Phase "questions": Gemini analyses the media content and returns N comprehension questions
 *
 * Body: { phase, medium, subject, educationLevel, numQuestions, videoDurationMin,
 *          passageLength, mediaContent (for questions phase) }
 */
exports.comprehensionGenerate = onRequest(
  {
    secrets: [geminiApiKey],
    cors: true,
    invoker: 'public',
    timeoutSeconds: 120,
    memory: '256MiB',
    region: 'us-central1',
  },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

    const apiKey = geminiApiKey.value();
    if (!apiKey) { res.status(503).json({ error: 'GEMINI_API_KEY not configured' }); return; }

    const { phase, medium, subject, educationLevel, numQuestions = 5,
            videoDurationMin = 3, passageLength = 'medium', mediaContent } = req.body;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    // ── Helper: call Gemini ──────────────────────────────────────────────
    const callGemini = async (parts) => {
      const r = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
      });
      const d = await r.json();
      const txt = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return txt;
    };

    try {
      // ════════════════════════════════════════════════════════════
      // PHASE 1 — SOURCE MEDIA
      // ════════════════════════════════════════════════════════════
      if (phase === 'source') {

        if (medium === 'video') {
          // Validate a videoId is real and embeddable using YouTube's free oEmbed API
          const validateYT = async (videoId) => {
            if (!videoId || videoId.length !== 11) return false;
            try {
              const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
              return r.ok; // 200 = valid+embeddable; 401/404 = unavailable or embedding disabled
            } catch { return false; }
          };

          let videoData = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const retryNote = attempt > 1
              ? `Attempt ${attempt - 1} returned an invalid or non-embeddable video ID. Try a DIFFERENT specific video.`
              : '';
            const prompt = `You are an expert educational content curator.
Suggest ONE real, publicly available, EMBEDDABLE YouTube video about "${subject}" suitable for ${educationLevel} students (~${videoDurationMin} min).
CRITICAL: The videoId must be a real, currently live YouTube video that allows embedding.
Prefer: TED-Ed, National Geographic, BBC, SciShow Kids, Kurzgesagt, Khan Academy, Crash Course.
${retryNote}
Return ONLY valid JSON (no markdown):
{
  "videoId": "exact 11-character YouTube video ID",
  "title": "Video title as it appears on YouTube",
  "description": "One sentence about this video for a ${educationLevel} student",
  "channel": "Channel name"
}`;
            const raw = await callGemini([{ text: prompt }]);
            const m = raw.match(/\{[\s\S]*\}/);
            if (!m) continue;
            let parsed;
            try { parsed = JSON.parse(m[0]); } catch { continue; }
            if (!parsed.videoId) continue;
            const ok = await validateYT(parsed.videoId);
            console.log(`[comp video] attempt=${attempt} id=${parsed.videoId} valid=${ok}`);
            if (ok) { videoData = parsed; break; }
          }

          if (!videoData) {
            // All 3 attempts failed — return a graceful error flag
            res.status(200).json({ medium: 'video', error: 'no_valid_video', videoId: null, youtubeUrl: null, title: 'No video found' });
          } else {
            res.status(200).json({
              medium: 'video',
              ...videoData,
              youtubeUrl: `https://www.youtube.com/watch?v=${videoData.videoId}`,
              durationMin: videoDurationMin,
            });
          }


        } else if (medium === 'image') {
          // Ask Gemini to suggest a search keyword for a Pixabay image + write a caption
          const prompt = `You are an educational content creator.
Choose an interesting, visually rich topic related to "${subject}" suitable for ${educationLevel} students.
Return ONLY valid JSON:
{
  "imageKeyword": "2-3 word Pixabay search term for a clear, educational photo",
  "title": "Short title for what the image shows",
  "caption": "One engaging sentence describing the image for a ${educationLevel} student (max 30 words)",
  "passage": "Write a 60-80 word educational passage about this image topic for ${educationLevel} students. Make it interesting and factual."
}`;
          const raw = await callGemini([{ text: prompt }]);
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('No JSON in Gemini response for image source');
          const imgData = JSON.parse(jsonMatch[0]);
          res.status(200).json({ medium: 'image', ...imgData });

        } else if (medium === 'text') {
          const wordCount = passageLength === 'short' ? 100 : passageLength === 'long' ? 500 : 250;
          const prompt = `Write an engaging, educational passage about "${subject}" for ${educationLevel} students.
The passage should be approximately ${wordCount} words.
Make it factual, interesting, and age-appropriate.
Return ONLY valid JSON:
{
  "title": "Passage title",
  "passage": "The full text passage here (${wordCount} words)"
}`;
          const raw = await callGemini([{ text: prompt }]);
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('No JSON in Gemini response for text source');
          const textData = JSON.parse(jsonMatch[0]);
          res.status(200).json({ medium: 'text', ...textData });

        } else if (medium === 'sounds') {
          // Generate a passage that will be read aloud via TTS
          const prompt = `Write a short, engaging narration script about "${subject}" for ${educationLevel} students.
It should take about 90 seconds to read aloud at a natural pace.
Make it feel like a friendly narrator telling an interesting story.
Return ONLY valid JSON:
{
  "title": "Narration title",
  "passage": "The narration text here"
}`;
          const raw = await callGemini([{ text: prompt }]);
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('No JSON in Gemini response for sounds source');
          const soundsData = JSON.parse(jsonMatch[0]);
          res.status(200).json({ medium: 'sounds', ...soundsData });

        } else {
          res.status(400).json({ error: `Unknown medium: ${medium}` });
        }

      // ════════════════════════════════════════════════════════════
      // PHASE 2 — GENERATE COMPREHENSION QUESTIONS
      // ════════════════════════════════════════════════════════════
      } else if (phase === 'questions') {

        const isVideo = medium === 'video';
        const isUserPasted = !mediaContent?.channel && isVideo; // user-pasted has no channel
        const contentDescription = isVideo
          ? (isUserPasted
              ? `a YouTube video (URL: https://www.youtube.com/watch?v=${mediaContent?.videoId}) about the topic: ${subject}. Since you cannot view the video directly, generate high-quality comprehension questions based on what a typical educational video about "${subject}" for ${educationLevel} students would cover.`
              : `a YouTube video titled "${mediaContent?.title}" by ${mediaContent?.channel}, about: ${mediaContent?.description}`)
          : `a ${medium} passage/content titled "${mediaContent?.title}": \n\n${mediaContent?.passage || mediaContent?.caption || ''}`;

        const prompt = `You are an expert at creating comprehension questions for ${educationLevel} students.
Based on ${contentDescription}, generate exactly ${numQuestions} multiple-choice comprehension questions.

Rules:
- Questions must be directly answerable from the content (true comprehension, not general knowledge)
- Each question has exactly 4 answer options (A, B, C, D)
- Only one answer is correct
- Wrong answers should be plausible but clearly wrong to someone who watched/read the content
- Language appropriate for ${educationLevel}
- Question images should relate to the topic

Return ONLY valid JSON in this exact format:
{
  "questions": [
    {
      "question": "Question text here?",
      "questionImageKeyword": "2-3 word image search term related to the question",
      "subject": "${subject}",
      "answers": [
        { "id": "a", "text": "First option", "imageKeyword": "keyword for this answer" },
        { "id": "b", "text": "Second option", "imageKeyword": "keyword" },
        { "id": "c", "text": "Third option", "imageKeyword": "keyword" },
        { "id": "d", "text": "Fourth option", "imageKeyword": "keyword" }
      ],
      "correctId": "a",
      "explanation": "Brief explanation of why this answer is correct"
    }
  ]
}`;

        const parts = [{ text: prompt }];
        // NOTE: Gemini fileData only supports gs:// Cloud Storage URIs, NOT YouTube URLs.
        // Questions are generated from the textual description in the prompt.

        const raw = await callGemini(parts);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in Gemini response for questions');
        const qData = JSON.parse(jsonMatch[0]);
        res.status(200).json(qData);

      } else {
        res.status(400).json({ error: `Unknown phase: ${phase}` });
      }

    } catch (err) {
      console.error('[comprehensionGenerate] Error:', err.message);
      res.status(502).json({ error: err.message });
    }
  }
);


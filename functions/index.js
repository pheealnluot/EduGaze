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
    const category = req.query.category || ''; // optional Pixabay category filter

    if (!q) {
      res.status(400).json({ error: 'Missing query parameter: q' });
      return;
    }

    let pixabayUrl = `https://pixabay.com/api/?key=${apiKey}&q=${encodeURIComponent(q)}&image_type=photo&orientation=horizontal&safesearch=true&per_page=${per_page}&min_width=400`;
    if (category) pixabayUrl += `&category=${encodeURIComponent(category)}`;

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

// ── YouTube transcript fetcher (free, no API key) ──────────────────────────
// Fetches auto-generated or manual captions by:
//   1. Scraping the YouTube watch page to find caption track URLs
//   2. Fetching the JSON3-format caption track
//   3. Joining all segment texts into a single transcript string
async function fetchYouTubeTranscript(videoId) {
  try {
    // Fetch the watch page — YouTube embeds caption track metadata here
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    // Extract just the captionTracks array from ytInitialPlayerResponse
    // YouTube embeds it as:  "captionTracks":[{...},{...}],"audioTracks"
    const captionMatch = html.match(/"captionTracks"\s*:\s*(\[\{[\s\S]*?\}\])\s*,\s*"(?:audioTracks|translationLanguages|defaultAudioTrackIndex)"/);
    if (!captionMatch) {
      console.log(`[transcript] No captionTracks found for ${videoId}`);
      return null;
    }

    let tracks;
    try { tracks = JSON.parse(captionMatch[1]); } catch { return null; }
    if (!tracks || tracks.length === 0) return null;

    // Prefer English (manual first, then auto-generated), fall back to first available
    const en = tracks.find(t => t.languageCode === 'en' && !t.kind) ||
               tracks.find(t => t.languageCode === 'en') ||
               tracks.find(t => t.languageCode?.startsWith('en')) ||
               tracks[0];
    if (!en?.baseUrl) return null;

    // Fetch captions in JSON3 format (segments with timestamps)
    const captRes = await fetch(en.baseUrl + '&fmt=json3');
    if (!captRes.ok) return null;
    const captData = await captRes.json();

    // Flatten all segments into a plain text string
    const events = captData?.events || [];
    const transcript = events
      .filter(e => e.segs)
      .map(e => e.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join(''))
      .join(' ')
      .replace(/\[.*?\]/g, '')   // strip [Music], [Applause] etc.
      .replace(/\s+/g, ' ')
      .trim();

    if (transcript.length < 100) return null; // too short to be useful
    console.log(`[transcript] Fetched ${transcript.length} chars for ${videoId} (lang: ${en.languageCode}${en.kind ? '/'+en.kind : ''})`);
    return transcript;
  } catch (err) {
    console.warn('[transcript] Fetch failed:', err.message);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Comprehension Adventure — two-phase AI endpoint.
 *
 * Phase "source":  Gemini picks appropriate YouTube video / generates text passage / image keyword
 * Phase "questions": Gemini analyses the media content and returns N comprehension questions
 *                    For video, the real transcript is fetched and sent to Gemini so questions
 *                    are genuinely based on what was said in the video.
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

        const isVideo   = medium === 'video';
        const isImage   = medium === 'image';
        const videoId   = mediaContent?.videoId || null;
        const videoUrl  = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
        const imageUrl  = mediaContent?.imageUrl || null;

        // ── Fetch YouTube transcript as supplementary grounding ──────────────
        // Gemini natively watches the video AND sees the transcript below —
        // double-grounding ensures questions are about this specific content.
        let transcript = null;
        if (isVideo && videoId) {
          transcript = await fetchYouTubeTranscript(videoId);
        }

        // ════════════════════════════════════════════════════════════
        // VIDEO PROMPT — mirrors Gemini app's "quiz on video" ability
        // ════════════════════════════════════════════════════════════
        const buildVideoPrompt = () => {
          const transcriptSection = transcript
            ? `\n\nHere is the full auto-generated transcript of the video for additional grounding:\n"""\n${transcript.slice(0, 6000)}\n"""\nUse the transcript to verify timestamps, quotes, and factual details.`
            : '';

          return (
            `You are an expert educational content creator analysing a YouTube video for ${educationLevel} students.\n\n` +

            `## Your Task\n` +
            `Watch the YouTube video provided above in its entirety. Pay close attention to:\n` +
            `- **Narration and dialogue** — every word spoken\n` +
            `- **Visuals and demonstrations** — what is physically shown on screen\n` +
            `- **On-screen text** — titles, labels, captions, subtitles\n` +
            `- **Key facts, sequences, and cause-effect relationships** presented\n` +
            `- **Main characters, people, or subjects** featured\n` +
            `- **Tone and purpose** — is it a tutorial, story, documentary, experiment?\n` +
            `${transcriptSection}\n\n` +

            `## Output Requirements\n` +
            `Generate exactly **${numQuestions}** multiple-choice comprehension questions.\n\n` +

            `### Strict Rules\n` +
            `1. Every question must be answerable ONLY by someone who watched this specific video — not from general knowledge\n` +
            `2. Distribute questions across the video timeline (beginning, middle, end)\n` +
            `3. Include a mix of question types: recall ("What was shown..."), inference ("Why did..."), sequence ("What happened after..."), and vocabulary ("What does X mean in this context?")\n` +
            `4. Each question has exactly 4 answer options (A, B, C, D)\n` +
            `5. Only ONE answer is correct; distractors must be plausible to someone who didn't pay attention\n` +
            `6. The "explanation" field must cite the SPECIFIC moment or quote from the video that proves the correct answer\n` +
            `7. Language and cognitive complexity appropriate for education level: ${educationLevel}\n` +
            `8. No meta-questions about the video itself (e.g. "What is the title?") — ask about the CONTENT\n` +
            `9. Answer text must be plain English only — do NOT include Chinese characters, symbols, or non-Latin scripts in any answer option\n\n` +

            `Return ONLY valid JSON in this exact format (no markdown, no commentary):\n` +
            `{\n` +
            `  "questions": [\n` +
            `    {\n` +
            `      "question": "Question text here?",\n` +
            `      "answers": [\n` +
            `        { "id": "a", "text": "First option" },\n` +
            `        { "id": "b", "text": "Second option" },\n` +
            `        { "id": "c", "text": "Third option" },\n` +
            `        { "id": "d", "text": "Fourth option" }\n` +
            `      ],\n` +
            `      "correctId": "a",\n` +
            `      "explanation": "Cite the specific video moment or quote that proves this answer"\n` +
            `    }\n` +
            `  ]\n` +
            `}`
          );
        };

        // ════════════════════════════════════════════════════════════
        // IMAGE PROMPT — Gemini visually analyses the image
        // ════════════════════════════════════════════════════════════
        const buildImagePrompt = () => (
          `You are an expert educational content creator analysing an image for ${educationLevel} students.\n\n` +

          `## Your Task\n` +
          `Examine the image provided above in full detail. Study:\n` +
          `- **What is shown** — all objects, people, animals, places, and their relationships\n` +
          `- **Text in the image** — labels, captions, signs, titles, annotations\n` +
          `- **Colours, patterns, and visual details** that carry meaning\n` +
          `- **Context and setting** — where does this appear to take place?\n` +
          `- **Key concepts** the image illustrates (scientific, geographic, historical, artistic, etc.)\n\n` +

          `## Output Requirements\n` +
          `Generate exactly **${numQuestions}** multiple-choice comprehension questions about this specific image.\n\n` +

          `### Strict Rules\n` +
          `1. Every question must be answerable ONLY by carefully looking at THIS specific image\n` +
          `2. Include a mix of: observation ("What colour is...?"), inference ("What is the person doing?"), label/text reading (if applicable), and deeper understanding ("What concept does this illustrate?")\n` +
          `3. Each question has exactly 4 answer options (A, B, C, D)\n` +
          `4. Only ONE answer is correct; wrong options must be visually plausible (e.g. nearby colours, similar objects)\n` +
          `5. The "explanation" field must describe the SPECIFIC visual detail in the image that proves the answer\n` +
          `6. Language and complexity appropriate for: ${educationLevel}\n` +
          `7. Do NOT ask questions answerable by general knowledge alone — anchor every question in what's visually present\n` +
          `8. Answer text must be plain English only — no Chinese characters or non-Latin scripts\n\n` +

          `Return ONLY valid JSON (no markdown, no commentary):\n` +
          `{\n` +
          `  "questions": [\n` +
          `    {\n` +
          `      "question": "Question text here?",\n` +
          `      "answers": [\n` +
          `        { "id": "a", "text": "First option" },\n` +
          `        { "id": "b", "text": "Second option" },\n` +
          `        { "id": "c", "text": "Third option" },\n` +
          `        { "id": "d", "text": "Fourth option" }\n` +
          `      ],\n` +
          `      "correctId": "a",\n` +
          `      "explanation": "Describe the specific visual detail in the image that proves this answer"\n` +
          `    }\n` +
          `  ]\n` +
          `}`
        );

        // ── Call Gemini ───────────────────────────────────────────────────────
        // Primary: pass the media as fileData so Gemini natively analyses it.
        // For video: Gemini watches visuals + audio + captions + metadata.
        // For image: Gemini visually inspects the image in full resolution.
        // Fallback: text-only prompt (transcript context embedded for video).
        let raw;

        if (isVideo && videoUrl) {
          const prompt = buildVideoPrompt();
          console.log('[comp questions] VIDEO prompt (first 300 chars):', prompt.slice(0, 300));
          try {
            raw = await callGemini([
              { fileData: { fileUri: videoUrl } },
              { text: prompt },
            ]);
            console.log(`[comp questions] Native video analysis succeeded for ${videoId}`);
          } catch (videoErr) {
            console.warn(`[comp questions] Native video analysis failed (${videoErr.message}), using transcript fallback`);
            // Fallback: use the transcript as the content source.
            // If we have no transcript, refuse to generate rather than hallucinate.
            if (!transcript || transcript.trim().length < 50) {
              throw new Error('Could not analyse the video (native analysis failed and no transcript available). Please try a different video.');
            }
            const fallbackPrompt =
              `You are an expert educational content creator for ${educationLevel} students.\n\n` +
              `Below is the full transcript of a YouTube video. Read it carefully — your questions MUST be based ONLY on what is stated in this transcript.\n\n` +
              `TRANSCRIPT:\n"""\n${transcript.slice(0, 8000)}\n"""\n\n` +
              `Generate exactly ${numQuestions} multiple-choice comprehension questions that test understanding of the content in the transcript above.\n\n` +
              `Strict rules:\n` +
              `1. Every question must be directly and uniquely answerable from the transcript text above\n` +
              `2. Do NOT add questions from general knowledge — only from the transcript\n` +
              `3. Each question has exactly 4 answer options (A, B, C, D)\n` +
              `4. Only ONE answer is correct; distractors must be plausible to someone who skimmed the text\n` +
              `5. The "explanation" must quote or paraphrase the specific transcript line that proves the answer\n` +
              `6. Language appropriate for ${educationLevel}\n` +
              `7. Answer text must be in English only — no Chinese characters, no symbols\n\n` +
              `Return ONLY valid JSON:\n` +
              `{ "questions": [{ "question": "?", "answers": [{"id":"a","text":""},{"id":"b","text":""},{"id":"c","text":""},{"id":"d","text":""}], "correctId": "a", "explanation": "" }] }`;
            raw = await callGemini([{ text: fallbackPrompt }]);
          }

        } else if (isImage && imageUrl) {
          const prompt = buildImagePrompt();
          console.log('[comp questions] IMAGE prompt (first 300 chars):', prompt.slice(0, 300));
          try {
            // Attempt 1: pass image URL as a fileData URI (works for public HTTP images)
            raw = await callGemini([
              { fileData: { fileUri: imageUrl } },
              { text: prompt },
            ]);
            console.log(`[comp questions] Native image analysis succeeded for ${imageUrl}`);
          } catch (imgErr) {
            console.warn(`[comp questions] Native image fileData failed (${imgErr.message}), trying inlineData fetch`);
            try {
              // Attempt 2: fetch the image bytes and pass as inlineData
              const imgResp = await fetch(imageUrl);
              if (!imgResp.ok) throw new Error(`Image fetch failed: ${imgResp.status}`);
              const imgBuf  = await imgResp.arrayBuffer();
              const imgB64  = Buffer.from(imgBuf).toString('base64');
              const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';
              raw = await callGemini([
                { inlineData: { mimeType, data: imgB64 } },
                { text: prompt },
              ]);
              console.log(`[comp questions] Inline image analysis succeeded for ${imageUrl}`);
            } catch (inlineErr) {
              console.warn(`[comp questions] Inline image also failed (${inlineErr.message}), text-only fallback`);
              raw = await callGemini([{ text: `An image was provided at this URL: ${imageUrl}\n\n` + prompt }]);
            }
          }

        } else {
          // Legacy text/passage path
          const contentDescription =
            `a ${medium} passage titled "${mediaContent?.title}":\n\n${mediaContent?.passage || mediaContent?.caption || ''}`;
          const prompt =
            `You are an expert at creating comprehension questions for ${educationLevel} students.\n` +
            `Based on ${contentDescription}, generate exactly ${numQuestions} multiple-choice questions.\n\n` +
            `Rules: questions directly from content, 4 options each, one correct answer, plausible distractors, ${educationLevel}-appropriate language.\n\n` +
            `Return ONLY valid JSON:\n` +
            `{ "questions": [{ "question": "?", "answers": [{"id":"a","text":""},{"id":"b","text":""},{"id":"c","text":""},{"id":"d","text":""}], "correctId": "a", "explanation": "" }] }`;
          raw = await callGemini([{ text: prompt }]);
        }

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


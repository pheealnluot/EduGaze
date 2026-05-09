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
const youtubeApiKey  = defineSecret('YOUTUBE_API_KEY');

// gemini-2.5-flash: best free-tier stable model — superior reasoning & 1M context window
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

// ── YouTube Data API v3 search — returns a real, embeddable video ──────────
// Fix B: replaces Gemini hallucinated video IDs with real search results.
// Requires YOUTUBE_API_KEY Firebase secret (YouTube Data API v3, free 10k quota/day).
// If no key is configured, returns null so the caller falls back to Gemini.
async function searchYouTubeVideo(query, maxDurationMin, ytApiKey, requireCaption = false) {
  if (!ytApiKey) return null;

  // Map duration to YouTube's coarse filter buckets
  // short=<4min, medium=4-20min, long=>20min
  let videoDuration = 'medium';
  if (maxDurationMin <= 4)  videoDuration = 'short';
  else if (maxDurationMin > 20) videoDuration = 'long';

  // videoCaption=closedCaption filters to only videos with captions on YouTube's side.
  // This is far more reliable than post-hoc scraping for every candidate.
  const captionParam = requireCaption ? '&videoCaption=closedCaption' : '';

  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&type=video&q=${encodeURIComponent(query)}` +
    `&videoDuration=${videoDuration}&videoEmbeddable=true` +
    `&safeSearch=strict&maxResults=10&key=${ytApiKey}${captionParam}`;

  try {
    const r = await fetch(searchUrl);
    if (!r.ok) {
      const errBody = await r.text();
      console.warn('[ytSearch] API error:', r.status, errBody.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const items = data.items || [];
    if (!items.length) {
      console.log('[ytSearch] No results for query:', query);
      return null;
    }

    // Validate embeddability and pick the first valid result
    for (const item of items) {
      const videoId = item.id?.videoId;
      if (!videoId || videoId.length !== 11) continue;
      try {
        const oEmbed = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
        );
        if (!oEmbed.ok) continue; // not embeddable
        const meta = await oEmbed.json();
        console.log(`[ytSearch] Found embeddable video: ${videoId} — "${meta.title}"${requireCaption ? ' (caption-filtered)' : ''}`);
        return {
          videoId,
          title:       meta.title       || item.snippet?.title       || 'Educational Video',
          channel:     meta.author_name || item.snippet?.channelTitle || '',
          description: item.snippet?.description?.slice(0, 150) || '',
        };
      } catch { continue; }
    }
    console.warn('[ytSearch] No embeddable video found in results');
    return null;
  } catch (err) {
    console.warn('[ytSearch] Fetch failed:', err.message);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── YouTube transcript fetcher — timedtext API (Cloud Run compatible) ───────
// YouTube's timedtext API endpoint is more reliable from Cloud Run IPs
// than scraping the full watch page (which gets blocked by YouTube's bot detection).
// Strategy:
//   1. Try YouTube's timedtext API directly (lightweight, less bot detection)
//   2. Fall back to watch page scraping if timedtext fails
async function fetchTranscriptTimedText(videoId) {
  // YouTube's timedtext API accepts a video ID and returns captions.
  // First, get the list of available caption tracks.
  const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${videoId}`;
  try {
    const listRes = await fetch(listUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!listRes.ok) {
      console.log(`[timedtext] List request failed: HTTP ${listRes.status} for ${videoId}`);
      return null;
    }
    const listXml = await listRes.text();
    if (!listXml || listXml.length < 20) {
      console.log(`[timedtext] Empty or invalid track list for ${videoId}`);
      return null;
    }

    // Parse XML to find English track (or first available)
    // Format: <track id="0" name="" lang_code="en" lang_original="English" .../>
    const trackMatches = [...listXml.matchAll(/<track[^>]*lang_code="([^"]*)"[^>]*(?:kind="([^"]*)")?[^>]*\/?\s*>/gi)];
    if (!trackMatches.length) {
      console.log(`[timedtext] No caption tracks found for ${videoId}`);
      return null;
    }

    // Prefer English manual > English auto > first available
    let bestLang = null;
    for (const m of trackMatches) {
      const lang = m[1], kind = m[2] || '';
      if (lang === 'en' && kind !== 'asr') { bestLang = { lang, kind }; break; }
      if (lang === 'en' && !bestLang) bestLang = { lang, kind };
      if (lang?.startsWith('en') && !bestLang) bestLang = { lang, kind };
    }
    if (!bestLang) bestLang = { lang: trackMatches[0][1], kind: trackMatches[0][2] || '' };

    // Fetch the actual captions in JSON3 format
    let captUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${bestLang.lang}&fmt=json3`;
    if (bestLang.kind) captUrl += `&kind=${bestLang.kind}`;

    const captRes = await fetch(captUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
    });
    if (!captRes.ok) {
      console.log(`[timedtext] Caption fetch failed: HTTP ${captRes.status} for ${videoId}`);
      return null;
    }
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

    if (transcript.length < 100) {
      console.log(`[timedtext] Transcript too short (${transcript.length} chars) for ${videoId}`);
      return null;
    }
    console.log(`[timedtext] ✅ Fetched ${transcript.length} chars for ${videoId} (lang: ${bestLang.lang})`);
    return transcript;
  } catch (err) {
    console.warn(`[timedtext] Error for ${videoId}:`, err.message);
    return null;
  }
}

// ── YouTube transcript fetcher (watch page scraping — fallback) ─────────────
// Fetches auto-generated or manual captions by:
//   1. Scraping the YouTube watch page to find caption track URLs
//   2. Fetching the JSON3-format caption track
//   3. Joining all segment texts into a single transcript string
// NOTE: This often fails on Cloud Run due to YouTube's bot detection.
// Use fetchTranscriptTimedText() first — this is the fallback.
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

    // Strategy 1: Find "captions":{...} directly (most stable)
    let tracks = [];
    const captionsMatch = html.match(/"captions":\s*({[\s\S]*?})\s*,\s*"videoDetails"/);
    if (captionsMatch) {
      try {
        const captionsObj = JSON.parse(captionsMatch[1]);
        tracks = captionsObj.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (tracks.length > 0) console.log(`[transcript] Found ${tracks.length} tracks via Strategy 1 (captions object)`);
      } catch (e) { }
    }

    // Strategy 2: Parse ytInitialPlayerResponse more greedily
    if (tracks.length === 0) {
      const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({[\s\S]*?});\s*(?:var|window|window\.ytplayer|<\/script)/);
      if (playerResponseMatch) {
        try {
          const playerResponse = JSON.parse(playerResponseMatch[1]);
          tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          if (tracks.length > 0) console.log(`[transcript] Found ${tracks.length} tracks via Strategy 2 (playerResponse)`);
        } catch (e) { }
      }
    }

    // Strategy 3: Target "captionTracks":[...] directly
    if (tracks.length === 0) {
      const directMatch = html.match(/"captionTracks"\s*:\s*(\[[\s\S]*?\])/);
      if (directMatch) {
        try {
          tracks = JSON.parse(directMatch[1]);
          if (tracks.length > 0) console.log(`[transcript] Found ${tracks.length} tracks via Strategy 3 (direct array)`);
        } catch (e) { }
      }
    }

    if (!tracks || tracks.length === 0) {
      console.log(`[transcript] No captionTracks found for ${videoId}. Length of HTML: ${html.length}`);
      return null;
    }

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
    secrets: [geminiApiKey, youtubeApiKey],
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
            videoDurationMin = 3, passageLength = 'medium', mediaContent,
            videoTimeLimitSec = null } = req.body;
    const ytKey = youtubeApiKey.value() || null;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    // ── Helper: call Gemini ──────────────────────────────────────────────
    const callGemini = async (parts, extraConfig = {}) => {
      const r = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000), // increased from 55s for YouTube video analysis via fileData
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            // Disable thinking mode -- gemini-2.5-flash thinks by default and adds 60-120s latency
            thinkingConfig: { thinkingBudget: 0 },
            maxOutputTokens: 4096,
            ...extraConfig,
          },
        }),
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
          // ── Fix B: Real YouTube Data API search (preferred over Gemini hallucination) ──
          // Uses YouTube Data API v3 if key is set; falls back to Gemini if not.
          let videoData = null;

          // --- Path A: YouTube Data API (Fix B) ---
          if (ytKey) {
            console.log('[comp video] Using YouTube Data API for video search');
            // Build a focused query from subject + level
            const ytQuery = `${subject} educational ${educationLevel} for kids`;
            videoData = await searchYouTubeVideo(ytQuery, videoDurationMin, ytKey);
            if (videoData) {
              console.log(`[comp video] YouTube API found: ${videoData.videoId} — "${videoData.title}"`);
            } else {
              console.warn('[comp video] YouTube API returned no results — falling back to Gemini');
            }
          }

          // --- Path B: Gemini fallback (used only if no YouTube API key or search failed) ---
          if (!videoData) {
            console.log('[comp video] Using Gemini for video suggestion (YouTube API not available)');
            // Validate a videoId is real and embeddable using YouTube's free oEmbed API
            const validateYT = async (videoId) => {
              if (!videoId || videoId.length !== 11) return false;
              try {
                const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
                return r.ok; // 200 = valid+embeddable; 401/404 = unavailable or embedding disabled
              } catch { return false; }
            };

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
              let parsedVid;
              try { parsedVid = JSON.parse(m[0]); } catch { continue; }
              if (!parsedVid.videoId) continue;
              const ok = await validateYT(parsedVid.videoId);
              console.log(`[comp video] Gemini attempt=${attempt} id=${parsedVid.videoId} valid=${ok}`);
              if (ok) { videoData = parsedVid; break; }
            }
          }

          if (!videoData) {
            // All paths failed — return a graceful error flag
            res.status(200).json({ medium: 'video', error: 'no_valid_video', videoId: null, youtubeUrl: null, title: 'No video found' });
          } else {
            res.status(200).json({
              medium: 'video',
              ...videoData,
              youtubeUrl: `https://www.youtube.com/watch?v=${videoData.videoId}`,
              durationMin: videoDurationMin,
              source: ytKey ? 'youtube_api' : 'gemini', // for debugging
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

        // ── Fix C: Transcript-first, metadata fallback ──────────────────────
        // We no longer rely on Gemini "watching" the video via fileData (unreliable).
        // PRIMARY: use the transcript (most accurate, grounded questions).
        // FALLBACK: if no transcript, use video title/description from oEmbed to generate
        //           topic-relevant questions about the video's subject matter.
        //
        // CRITICAL: The proxy (server.js) pre-fetches the transcript from a residential/dev
        // IP where YouTube doesn't block. If prefetchedTranscript is provided, use it
        // directly instead of trying to scrape YouTube from Cloud Run (which gets blocked).
        let transcript = null;
        let videoMetaTitle = null;
        let videoMetaChannel = null;
        let videoMetaDesc = null; // description for enriched metadata fallback
        const allowMetadataFallback = req.body.allowMetadataFallback !== false; // default: true
        const prefetchedTranscript = req.body.prefetchedTranscript || null;

        if (isVideo && videoId) {
          if (prefetchedTranscript && prefetchedTranscript.trim().length >= 50) {
            // Use the transcript pre-fetched by the proxy server
            console.log(`[comp questions] Using pre-fetched transcript (${prefetchedTranscript.length} chars) for ${videoId}`);
            // If a time limit is set, trim to the watched portion
            if (videoTimeLimitSec && videoTimeLimitSec > 0) {
              const estimatedChars = Math.round(videoTimeLimitSec * 12.5);
              transcript = prefetchedTranscript.slice(0, estimatedChars);
              console.log(`[comp questions] Trimmed pre-fetched transcript to ${transcript.length} chars for ${videoTimeLimitSec}s time limit`);
            } else {
              transcript = prefetchedTranscript;
            }
          } else {
            // No pre-fetched transcript — try fetching ourselves.
            // Strategy 1: timedtext API (lightweight, more likely to work from Cloud Run)
            console.log(`[comp questions] Trying timedtext API for ${videoId}...`);
            let rawTranscript = await fetchTranscriptTimedText(videoId);

            // Strategy 2: watch page scraping (fallback, often blocked on Cloud Run)
            if (!rawTranscript) {
              console.log(`[comp questions] timedtext failed, trying watch page scraping for ${videoId}...`);
              rawTranscript = await fetchYouTubeTranscript(videoId);
            }

            // If a time limit is set, estimate how many characters correspond to
            // the watched portion using ~2.5 words/sec × ~5 chars/word = ~12.5 chars/sec.
            if (rawTranscript && videoTimeLimitSec && videoTimeLimitSec > 0) {
              const estimatedChars = Math.round(videoTimeLimitSec * 12.5);
              transcript = rawTranscript.slice(0, estimatedChars);
              console.log(`[comp questions] Trimmed transcript to ${transcript.length} chars for ${videoTimeLimitSec}s time limit`);
            } else {
              transcript = rawTranscript;
            }
          }

          if (!transcript || transcript.trim().length < 50) {
            if (!allowMetadataFallback) {
              // Strict mode — caller explicitly opted out of the metadata fallback
              console.warn(`[comp questions] No transcript for videoId=${videoId} and allowMetadataFallback=false — returning error`);
              res.status(200).json({
                error: 'no_transcript',
                videoId,
                message: 'This video does not have captions. Please try a different video that has captions enabled.',
              });
              return;
            }
            // Metadata fallback: fetch title/channel via oEmbed + description via YouTube Data API
            console.warn(`[comp questions] No transcript for videoId=${videoId} — using enriched metadata fallback`);
            try {
              const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
              if (oembed.ok) {
                const od = await oembed.json();
                videoMetaTitle   = od.title       || null;
                videoMetaChannel = od.author_name || null;
              }
            } catch { /* metadata fetch failed — generate from videoId only */ }

            // Try YouTube Data API for full description + tags (much richer than oEmbed)
            if (ytKey) {
              try {
                const snippetUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${ytKey}`;
                const snippetResp = await fetch(snippetUrl);
                if (snippetResp.ok) {
                  const snippetData = await snippetResp.json();
                  const snippet = snippetData?.items?.[0]?.snippet;
                  if (snippet) {
                    if (!videoMetaTitle) videoMetaTitle = snippet.title || null;
                    if (!videoMetaChannel) videoMetaChannel = snippet.channelTitle || null;
                    videoMetaDesc = (snippet.description || '').slice(0, 800).trim();
                    const tags = (snippet.tags || []).slice(0, 10).join(', ');
                    if (tags && videoMetaDesc) videoMetaDesc += `\nTags: ${tags}`;
                    console.log(`[comp questions] YouTube API enriched metadata — desc: ${videoMetaDesc.length} chars, tags: ${tags.length} chars`);
                  }
                }
              } catch (e) {
                console.warn(`[comp questions] YouTube API snippet fetch failed:`, e.message);
              }
            }

            console.log(`[comp questions] Metadata fallback — title: "${videoMetaTitle}", channel: "${videoMetaChannel}", desc: ${videoMetaDesc?.length || 0} chars`);
          }
        }

        // ════════════════════════════════════════════════════════════
        // VIDEO PROMPT — mirrors Gemini app's "quiz on video" ability
        // ════════════════════════════════════════════════════════════
        const buildVideoPrompt = () => {
          const timeLimitNote = videoTimeLimitSec && videoTimeLimitSec > 0
            ? `\n\n⚠️ IMPORTANT: The student ONLY watched the FIRST ${videoTimeLimitSec} SECONDS of this video. Every question MUST be answerable from that opening ${videoTimeLimitSec}-second segment ONLY. Do NOT ask about anything that appears after the ${videoTimeLimitSec}-second mark.`
            : '';

          const transcriptSection = transcript
            ? `\n\nHere is the auto-generated transcript covering the watched portion of the video:\n"""\n${transcript.slice(0, 6000)}\n"""\nUse this transcript to verify quotes and factual details. All questions must relate to content within this transcript excerpt.`
            : '';

          return (
            `You are an expert educational content creator analysing a YouTube video for ${educationLevel} students.\n\n` +

            `## Your Task\n` +
            (videoTimeLimitSec && videoTimeLimitSec > 0
              ? `Watch ONLY the first **${videoTimeLimitSec} seconds** of the YouTube video provided above. Stop at the ${videoTimeLimitSec}-second mark. Pay close attention to:\n`
              : `Watch the YouTube video provided above in its entirety. Pay close attention to:\n`) +
            `- **Narration and dialogue** — every word spoken\n` +
            `- **Visuals and demonstrations** — what is physically shown on screen\n` +
            `- **On-screen text** — titles, labels, captions, subtitles\n` +
            `- **Key facts, sequences, and cause-effect relationships** presented\n` +
            `- **Main characters, people, or subjects** featured\n` +
            `- **Tone and purpose** — is it a tutorial, story, documentary, experiment?\n` +
            `${timeLimitNote}${transcriptSection}\n\n` +

            `## Output Requirements\n` +
            `Generate exactly **${numQuestions}** multiple-choice comprehension questions.\n\n` +

            `### Strict Rules\n` +
            `1. Every question must be answerable ONLY by someone who watched the specified portion of this video — not from general knowledge\n` +
            (videoTimeLimitSec && videoTimeLimitSec > 0
              ? `2. ALL questions must be about content within the FIRST ${videoTimeLimitSec} seconds only — do not reference anything after that point\n`
              : `2. Distribute questions across the video timeline (beginning, middle, end)\n`) +
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
          `8. Answer text must be plain English only — no Chinese characters or non-Latin scripts\n` +
          `9. ⚠️ COUNTING RULE — If you include a counting question (e.g. "How many X are visible?"): count EVERY item individually in the image before writing the answer. Only ask a counting question if you are CERTAIN of the exact number. If you are not 100% sure of the count, ask a different type of question instead. NEVER guess a count.\n\n` +
          `10. ⚠️ SPATIAL ACCURACY — Be extremely careful with "left" and "right". If you refer to a person's "left hand" or "right eye", ensure it matches their body orientation. For musical instruments (like guitar), remember standard orientations (e.g., the fretting hand on the neck is the LEFT hand for a right-handed player). If you mean the left/right side of the image, state that clearly. Errors in spatial orientation are unacceptable.\n\n` +

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

        // ── Counting-question verifier ──────────────────────────────────────────
        // After initial generation, re-check any question that involves counting.
        // Gemini vision models are notoriously poor at counting objects; this
        // second pass sends the image back with a focused count-verification prompt
        // and patches the correctId / answer text if the count disagrees.
        const verifyCounts = async (questions, imgB64, mimeType) => {
          const countingKeywords = /\bhow many\b|\bcount\b|\bnumber of\b|\btotal.*\b/i;
          const needsVerify = questions.filter(q => countingKeywords.test(q.question));
          if (!needsVerify.length) return questions; // nothing to verify

          console.log(`[comp questions] Verifying ${needsVerify.length} counting question(s) against image`);

          const verifyPrompt =
            `Look carefully at the image. For each question below, count the relevant objects/items ` +
            `one by one (do not guess) and return the verified correct answer ID.\n\n` +
            `Questions to verify:\n` +
            needsVerify.map((q, i) =>
              `Q${i + 1}: ${q.question}\n` +
              q.answers.map(a => `  ${a.id}) ${a.text}`).join('\n')
            ).join('\n\n') +
            `\n\nReturn ONLY valid JSON — an array in the same order as the questions above:\n` +
            `[{ "verifiedCorrectId": "a" }, ...]`;

          try {
            const verifyRaw = await callGemini([
              { inlineData: { mimeType, data: imgB64 } },
              { text: verifyPrompt },
            ]);
            const arrMatch = verifyRaw.match(/\[[\s\S]*\]/);
            if (!arrMatch) throw new Error('No JSON array in verify response');
            const verified = JSON.parse(arrMatch[0]);

            // Patch correctId if verification disagrees
            let patchCount = 0;
            needsVerify.forEach((q, i) => {
              const v = verified[i];
              if (!v?.verifiedCorrectId) return;
              if (v.verifiedCorrectId !== q.correctId && q.answers.some(a => a.id === v.verifiedCorrectId)) {
                console.log(`[comp questions] Count mismatch — patching Q "${q.question.slice(0, 60)}..." correctId ${q.correctId} → ${v.verifiedCorrectId}`);
                q.correctId = v.verifiedCorrectId;
                patchCount++;
              }
            });
            if (patchCount > 0) console.log(`[comp questions] Patched ${patchCount} counting answer(s)`);
          } catch (verifyErr) {
            console.warn('[comp questions] Count verification failed (using original answers):', verifyErr.message);
          }

          return questions;
        };

        // ── Spatial-accuracy verifier ───────────────────────────────────────────
        // Re-checks any question/answer that mentions "left" or "right" against the image.
        // Vision models often confuse orientation; this second pass focuses solely on
        // spatial correctness (handedness, image sides, etc.) to prevent errors.
        const verifySpatial = async (questions, imgB64, mimeType) => {
          const spatialKeywords = /\bleft\b|\bright\b/i;
          const needsVerify = questions.filter(q => spatialKeywords.test(q.question) || q.answers.some(a => spatialKeywords.test(a.text)));
          if (!needsVerify.length) return questions;

          console.log(`[comp questions] Verifying ${needsVerify.length} spatial question(s) against image`);

          const verifyPrompt =
            `Look carefully at the image. For each question below, verify if the use of "left" or "right" is correct. ` +
            `Study the anatomy, handedness, and positioning in the image. ` +
            `If a question or answer incorrectly identifies left vs right (e.g. says "right wrist" but it's the "left wrist"), provide the CORRECTED text.\n\n` +
            `Questions to verify:\n` +
            needsVerify.map((q, i) =>
              `Q${i + 1}: ${q.question}\n` +
              q.answers.map(a => `  ${a.id}) ${a.text}`).join('\n')
            ).join('\n\n') +
            `\n\nReturn ONLY valid JSON — an array in the same order as the questions above:\n` +
            `[{ "question": "Original or corrected question", "answers": [{ "id": "a", "text": "Original or corrected text" }, ...] }, ...]`;

          try {
            const verifyRaw = await callGemini([
              { inlineData: { mimeType, data: imgB64 } },
              { text: verifyPrompt },
            ]);
            const arrMatch = verifyRaw.match(/\[[\s\S]*\]/);
            if (!arrMatch) throw new Error('No JSON array in spatial verify response');
            const verified = JSON.parse(arrMatch[0]);

            let patchCount = 0;
            needsVerify.forEach((q, i) => {
              const v = verified[i];
              if (!v) return;
              let changed = false;
              if (v.question && v.question !== q.question) {
                console.log(`[comp questions] Spatial mismatch — patching Q: "${q.question}" → "${v.question}"`);
                q.question = v.question;
                changed = true;
              }
              if (Array.isArray(v.answers)) {
                v.answers.forEach(va => {
                  const qa = q.answers.find(a => a.id === va.id);
                  if (qa && va.text && va.text !== qa.text) {
                    console.log(`[comp questions] Spatial mismatch — patching A ${qa.id}: "${qa.text}" → "${va.text}"`);
                    qa.text = va.text;
                    changed = true;
                  }
                });
              }
              if (changed) patchCount++;
            });
            if (patchCount > 0) console.log(`[comp questions] Patched ${patchCount} spatial question(s)`);
          } catch (verifyErr) {
            console.warn('[comp questions] Spatial verification failed:', verifyErr.message);
          }

          return questions;
        };

        // ── Call Gemini ───────────────────────────────────────────────────────
        // Primary: pass the media as fileData so Gemini natively analyses it.
        // For video: Gemini watches visuals + audio + captions + metadata.
        // For image: Gemini visually inspects the image in full resolution.
        // Fallback: text-only prompt (transcript context embedded for video).
        let raw;

        if (isVideo && videoUrl) {
          if (transcript && transcript.trim().length >= 50) {
            // ── PATH A: Transcript-grounded (most accurate) ──────────────────
            console.log('[comp questions] Generating VIDEO questions from transcript');
            const transcriptPrompt =
              `You are an expert educational content creator for ${educationLevel} students.\n\n` +
              (videoTimeLimitSec && videoTimeLimitSec > 0
                ? `The student watched ONLY the first ${videoTimeLimitSec} seconds of this video. Questions must relate to that portion only.\n\n`
                : '') +
              `Below is the transcript of the YouTube video (video ID: ${videoId}). ` +
              `Read it carefully — every question MUST be based ONLY on what is stated in this transcript.\n\n` +
              `TRANSCRIPT:\n"""\n${transcript.slice(0, 10000)}\n"""\n\n` +
              `Generate exactly ${numQuestions} multiple-choice comprehension questions that test understanding of the content in the transcript above.\n\n` +
              `Strict rules:\n` +
              `1. Every question must be directly and uniquely answerable from the transcript text — not from general knowledge\n` +
              `2. Include a mix of: recall ("What was said about..."), inference ("Why did..."), sequence ("What happened after..."), vocabulary\n` +
              `3. Each question has exactly 4 answer options (A, B, C, D)\n` +
              `4. Only ONE answer is correct; distractors must be plausible to someone who skimmed the text\n` +
              `5. The "explanation" must quote or paraphrase the specific transcript line that proves the answer\n` +
              `6. Language and cognitive complexity appropriate for: ${educationLevel}\n` +
              `7. Answer text must be in English only — no Chinese characters, no symbols\n` +
              `8. No meta-questions ("What is the title?") — ask about the CONTENT\n\n` +
              `Return ONLY valid JSON:\n` +
              `{ "questions": [{ "question": "?", "answers": [{"id":"a","text":""},{"id":"b","text":""},{"id":"c","text":""},{"id":"d","text":""}], "correctId": "a", "explanation": "" }] }`;
            raw = await callGemini([{ text: transcriptPrompt }]);
            console.log(`[comp questions] Transcript-based generation complete for ${videoId}`);

          } else {
            // ── PATH B: Gemini native YouTube video analysis (no transcript) ─
            // Instead of using metadata-only, let Gemini WATCH the video directly.
            // Gemini 2.5 Flash can natively analyse YouTube videos via fileData —
            // it sees the visuals, hears the audio, and reads the captions.
            // This produces questions specific to the actual video content,
            // even when we can't scrape the transcript ourselves.
            console.log('[comp questions] PATH B: Trying Gemini native YouTube video analysis...');

            const timeLimitNote = videoTimeLimitSec && videoTimeLimitSec > 0
              ? `\n\n⚠️ IMPORTANT: The student ONLY watched the FIRST ${videoTimeLimitSec} SECONDS of this video. Every question MUST be answerable from that opening ${videoTimeLimitSec}-second segment ONLY. Do NOT ask about anything that appears after the ${videoTimeLimitSec}-second mark.`
              : '';

            const videoAnalysisPrompt =
              `You are an expert educational content creator for ${educationLevel} students.\n\n` +
              `Watch the YouTube video above carefully. Pay attention to the visuals, narration, and on-screen text.${timeLimitNote}\n\n` +
              `Generate exactly ${numQuestions} multiple-choice comprehension questions that test understanding of this specific video's content.\n\n` +
              `Strict rules:\n` +
              `1. Every question must be based ONLY on what is shown, said, or presented in this specific video — not from general knowledge\n` +
              `2. Include a mix of: recall ("What did the video show about..."), inference ("Why did..."), sequence ("What happened after..."), visual details\n` +
              `3. Each question has exactly 4 answer options (A, B, C, D)\n` +
              `4. Only ONE answer is correct; distractors must be plausible to someone who only partially watched\n` +
              `5. The "explanation" must reference the specific part of the video that proves the answer\n` +
              `6. Language and cognitive complexity appropriate for: ${educationLevel}\n` +
              `7. Answer text must be in English only — no Chinese characters, no symbols\n` +
              `8. No meta-questions ("What is the title?") — ask about the CONTENT of the video\n\n` +
              `Return ONLY valid JSON:\n` +
              `{ "questions": [{ "question": "?", "answers": [{"id":"a","text":""},{"id":"b","text":""},{"id":"c","text":""},{"id":"d","text":""}], "correctId": "a", "explanation": "" }] }`;

            try {
              raw = await callGemini([
                {
                  fileData: {
                    fileUri: `https://www.youtube.com/watch?v=${videoId}`,
                    mimeType: 'video/mp4',
                  },
                },
                { text: videoAnalysisPrompt },
              ]);
              console.log(`[comp questions] PATH B: Gemini native video analysis complete for ${videoId} (${raw.length} chars)`);
            } catch (fileDataErr) {
              // ── PATH C: Pure metadata fallback (if fileData also fails) ─────
              console.warn(`[comp questions] PATH B failed (fileData):`, fileDataErr.message);
              console.log('[comp questions] PATH C: Falling back to metadata-only generation');

              const topicHint = videoMetaTitle
                ? `The video is titled "${videoMetaTitle}"${videoMetaChannel ? ` by ${videoMetaChannel}` : ''}.`
                : `The video ID is ${videoId}.`;
              const descSection = videoMetaDesc
                ? `\n\nHere is the video's full description:\n"""\n${videoMetaDesc}\n"""\n`
                : '';
              const metadataPrompt =
                `You are an expert educational content creator for ${educationLevel} students.\n\n` +
                `${topicHint}${descSection}\n` +
                `Based on the topic of this educational video${videoMetaDesc ? ' and its description' : ''}, generate exactly ${numQuestions} multiple-choice comprehension questions ` +
                `that a student could answer after watching a video on this topic.\n\n` +
                `Important rules:\n` +
                `1. Extract the EDUCATIONAL TOPIC from the title${videoMetaDesc ? ' and description' : ''} (e.g. "The Water Cycle" → ask about evaporation, condensation, precipitation)\n` +
                `2. Generate questions that test UNDERSTANDING of the topic — facts, causes, effects, definitions\n` +
                `3. Do NOT ask meta-questions about YouTube, the video format, or "what is this video about?"\n` +
                `4. Each question has exactly 4 answer options (A, B, C, D)\n` +
                `5. Only ONE answer is correct; wrong options must be plausible but clearly incorrect to someone who knows the topic\n` +
                `6. The "explanation" must explain WHY the correct answer is right based on the topic\n` +
                `7. Language and cognitive complexity appropriate for: ${educationLevel}\n` +
                `8. Answer text must be in English only — no Chinese characters, no symbols\n\n` +
                `Return ONLY valid JSON:\n` +
                `{ "questions": [{ "question": "?", "answers": [{"id":"a","text":""},{"id":"b","text":""},{"id":"c","text":""},{"id":"d","text":""}], "correctId": "a", "explanation": "" }] }`;
              raw = await callGemini([{ text: metadataPrompt }]);
              console.log(`[comp questions] PATH C: Metadata-based generation complete for ${videoId}`);
            }
          }


        } else if (isImage && imageUrl) {
          const prompt = buildImagePrompt();
          console.log('[comp questions] IMAGE prompt (first 300 chars):', prompt.slice(0, 300));

          // Attempt to download the image so Gemini can actually see it.
          // If this fails for any reason, we refuse to generate guessed questions.
          // imgB64/mimeType declared in outer block so verifyCounts can reuse them.
          let imgB64 = null, mimeType = null;
          try {
            const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
            if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status} ${imgResp.statusText}`);
            const contentType = imgResp.headers.get('content-type') || '';
            if (!contentType.startsWith('image/')) throw new Error(`URL returned non-image content (${contentType})`);
            const imgBuf = await imgResp.arrayBuffer();
            imgB64   = Buffer.from(imgBuf).toString('base64');
            mimeType = contentType.split(';')[0].trim();
            console.log(`[comp questions] Image fetched OK (${imgBuf.byteLength} bytes, ${mimeType})`);
          } catch (fetchErr) {
            console.warn('[comp questions] Image fetch failed:', fetchErr.message);
            // Throw a structured error the frontend can display helpfully
            const err = new Error(fetchErr.message);
            err.reason = 'IMAGE_UNREACHABLE';
            throw err;
          }

          raw = await callGemini([
            { inlineData: { mimeType, data: imgB64 } },
            { text: prompt },
          ]);
          console.log(`[comp questions] Native image analysis succeeded for ${imageUrl}`);
          // Store for later use by verifyCounts
          raw._imgB64   = imgB64;
          raw._mimeType = mimeType;

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

        // Validate that each correctId actually matches one of the answer ids
        if (Array.isArray(qData.questions)) {
          const invalid = qData.questions.filter(q =>
            !q.answers?.some(a => a.id === q.correctId)
          );
          if (invalid.length > 0) {
            console.error('[comp questions] correctId mismatch in', invalid.length, 'question(s):', JSON.stringify(invalid.map(q => ({q: q.question, correctId: q.correctId, ids: q.answers?.map(a => a.id)}))));
            const err = new Error(`Gemini returned ${invalid.length} question(s) with a correctId that does not match any answer option.`);
            err.reason = 'INVALID_CORRECT_ID';
            throw err;
          }

          // For image mode: run a second Gemini pass to verify counting questions.
          // raw._imgB64 / raw._mimeType are set earlier only in the isImage branch.
          if (isImage && raw._imgB64 && raw._mimeType) {
            qData.questions = await verifyCounts(qData.questions, raw._imgB64, raw._mimeType);
            qData.questions = await verifySpatial(qData.questions, raw._imgB64, raw._mimeType);
          }
        }

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


// -- YouTube Video Search endpoint ------------------------------------------
// Used by the "Find a Video" button in Quiz Settings.
// Strategy:
//   1. Ask Gemini to generate 3 focused educational search queries (text only � Gemini is
//      good at creative query generation but BAD at knowing real current video IDs)
//   2. For each query, call YouTube Data API v3 (returns real, current results)
//   3. Validate each candidate via oEmbed before returning
// This guarantees a real, live, embeddable video every time.
exports.youtubeVideoSearch = onRequest(
  {
    secrets: [geminiApiKey, youtubeApiKey],
    cors: true,
    invoker: 'public',
    timeoutSeconds: 60,
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
    const ytKey  = youtubeApiKey.value();
    if (!apiKey) { res.status(503).json({ error: 'GEMINI_API_KEY not configured' }); return; }
    if (!ytKey)  { res.status(503).json({ error: 'YOUTUBE_API_KEY not configured' }); return; }

    const { educationLevel = 'P2', subject = null, maxDurationMin = 10, exclude = [],
            requireCaption = false } = req.body;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const callGemini = async (parts) => {
      const r = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 1024 },
        }),
      });
      const d = await r.json();
      return d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    };

    // Step 1: Ask Gemini to generate 3 search query strings.
    // Caption guidance is now subordinate — it suggests channel formats but NEVER overrides the topic.
    const captionGuidance = requireCaption
      ? `For caption availability, prefer channels known for captioned videos (e.g. TED-Ed, SciShow Kids, Kurzgesagt, National Geographic Kids, Khan Academy) — but ONLY if they have content matching the topic above. Do NOT pick a different topic just to use these channels.\n`
      : '';

    // Build the prompt — topic is the #1 constraint, stated first and reinforced last.
    const topicConstraint = subject
      ? `TOPIC (MANDATORY): Every single query MUST be about "${subject}". Do not generate queries about any other topic.\n`
      : '';
    const subjectNote = subject ? ` specifically about "${subject}"` : '';

    const queryPrompt =
      `You are an educational content curator for ${educationLevel} students.\n` +
      topicConstraint +
      `Generate 5 different YouTube search queries that would find great educational videos${subjectNote}.\n` +
      `Suitable for children. Keep queries varied (e.g. facts, documentary, for kids, explained, how it works).\n` +
      `${captionGuidance}` +
      `Each query should be 3-6 words, specific.${subject ? ` All queries must include or relate to "${subject}".` : ''}\n` +
      `Return ONLY valid JSON (no markdown):\n` +
      `{"queries": ["query one here", "query two here", "query three here", "query four here", "query five here"]}`;

    let queries = [];
    try {
      const raw = await callGemini([{ text: queryPrompt }]);
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        queries = (parsed.queries || []).filter(q => typeof q === 'string' && q.length > 2);
      }
    } catch (err) {
      console.warn('[ytVideoSearch] Query generation failed:', err.message);
    }

    // Fallback: keyword-aware if subject is set, generic otherwise
    if (!queries.length) {
      if (subject) {
        queries = [
          `${subject} for kids educational`,
          `${subject} explained children`,
          `${subject} documentary kids`,
          `learn about ${subject} children`,
          `${subject} facts science`,
        ];
      } else {
        queries = requireCaption
          ? [
              'TED-Ed science explained kids',
              'National Geographic Kids animals nature',
              'Kurzgesagt how things work',
            ]
          : [
              'educational science for kids',
              'nature animals documentary children',
              'how things work kids educational',
            ];
      }
    }
    console.log(`[ytVideoSearch] Search queries (requireCaption=${requireCaption}):`, queries);

    // Step 2: Search YouTube Data API and validate results
    let videoDuration = 'medium';
    if (maxDurationMin <= 4)    videoDuration = 'short';
    else if (maxDurationMin > 20) videoDuration = 'long';

    const excludeSet = new Set(exclude);
    // Use videoCaption=closedCaption to filter to only videos with closed captions.
    // Previously we used 'any' + watch-page scraping to verify, but YouTube blocks
    // Cloud Run IPs from scraping watch pages. The API filter is reliable and fast.
    const captionParam = requireCaption ? '&videoCaption=closedCaption' : '';

    for (const query of queries) {
      // Add a small delay between queries to avoid hitting rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const searchUrl =
          `https://www.googleapis.com/youtube/v3/search` +
          `?part=snippet&type=video&q=${encodeURIComponent(query)}` +
          `&videoDuration=${videoDuration}&videoEmbeddable=true` +
          `&safeSearch=strict&maxResults=15&key=${ytKey}${captionParam}`;

        const ytResp = await fetch(searchUrl);
        if (!ytResp.ok) {
          const body = await ytResp.text();
          console.warn('[ytVideoSearch] YouTube API error:', ytResp.status, body.slice(0, 200));
          continue;
        }
        const ytData = await ytResp.json();
        const items  = ytData.items || [];
        console.log(`[ytVideoSearch] Query "${query}" => ${items.length} results`);

        for (const item of items) {
          const videoId = item.id?.videoId;
          if (!videoId || videoId.length !== 11) continue;
          if (excludeSet.has(videoId)) continue;

          // oEmbed confirms the video is live and embeddable right now
          try {
            const oResp = await fetch(
              `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
            );
            if (!oResp.ok) {
              console.log(`[ytVideoSearch] oEmbed rejected ${videoId} (${oResp.status})`);
              continue;
            }
            const oData = await oResp.json();

            // When transcript is required, the YouTube API's videoCaption=closedCaption
            // filter already ensures the video has captions. No need to scrape the watch
            // page (which fails on Cloud Run due to YouTube's bot detection).
            if (requireCaption) {
              console.log(`[ytVideoSearch] ${videoId} — caption-filtered via YouTube API ✓`);
            }

            console.log(`[ytVideoSearch] FOUND ${videoId} -- "${oData.title}"`);
            res.status(200).json({
              videoId,
              title:       oData.title        || item.snippet?.title        || 'Educational Video',
              channelName: oData.author_name   || item.snippet?.channelTitle || '',
              description: item.snippet?.description?.slice(0, 200) || '',
              searchQuery: query,
              hasCaption:  requireCaption, // filtered via YouTube API closedCaption param
            });
            return;
          } catch { continue; }
        }
      } catch (err) {
        console.warn(`[ytVideoSearch] Query "${query}" failed:`, err.message);
      }
    }

    console.error('[ytVideoSearch] No embeddable video found after all queries');
    res.status(200).json({ error: 'no_video_found' });
  }
);

// ── YouTube Video Info endpoint ──────────────────────────────────────────────
// Returns metadata (duration, channel, description) for a given video ID.
// Uses the YouTube Data API v3 (works from Cloud Run, unlike watch page scraping).
// The local server.js version scrapes the watch page, but that's blocked from Cloud Run.
exports.youtubeVideoInfo = onRequest(
  {
    secrets: [youtubeApiKey],
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

    const videoId = req.query.v;
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      res.status(400).json({ error: 'Invalid video ID' });
      return;
    }

    const ytKey = youtubeApiKey.value();
    if (!ytKey) {
      res.status(503).json({ error: 'YOUTUBE_API_KEY not configured' });
      return;
    }

    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${ytKey}`;
      const apiResp = await fetch(apiUrl);
      if (!apiResp.ok) {
        const errText = await apiResp.text();
        console.error('[ytVideoInfo] YouTube API error:', apiResp.status, errText.slice(0, 200));
        res.status(502).json({ error: `YouTube API returned HTTP ${apiResp.status}` });
        return;
      }
      const apiData = await apiResp.json();
      const item = apiData?.items?.[0];
      if (!item) {
        res.status(404).json({ error: 'Video not found' });
        return;
      }

      // Parse ISO 8601 duration (PT#M#S) to seconds
      const durationIso = item.contentDetails?.duration || '';
      let durationSec = 0;
      const durMatch = durationIso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (durMatch) {
        durationSec = (parseInt(durMatch[1] || '0') * 3600) +
                      (parseInt(durMatch[2] || '0') * 60) +
                       parseInt(durMatch[3] || '0');
      }

      const snippet = item.snippet || {};
      const channelName = snippet.channelTitle || '';
      const title = snippet.title || '';
      const description = (snippet.description || '').slice(0, 300).trim();

      console.log(`[ytVideoInfo] ${videoId}: ${durationSec}s, channel="${channelName}"`);
      res.json({ videoId, durationSec, channelName, description, title });
    } catch (err) {
      console.error('[ytVideoInfo] Error:', err.message);
      res.status(502).json({ error: err.message });
    }
  }
);

// ── Spot the Character — Image Generation Cloud Function ─────────────────────
// Ported from server.js — generates scene images + locates hidden characters.
const spotCharFn = require('./spot-char-fn.js');
exports.spotCharGenerate = spotCharFn.spotCharGenerate;

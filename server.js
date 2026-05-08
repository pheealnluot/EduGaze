import express from 'express';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

// Auto-load .env for local development (file is gitignored, never committed)
try {
  const envPath = new URL('.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.trim().split('=');
    if (key && !key.startsWith('#') && val.length) {
      process.env[key] = val.join('=');  // .env always takes precedence
    }
  });
  console.log('✅ Loaded .env for local development');
} catch (_) { /* .env not present — using system env vars (production) */ }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8080;

// Enable gzip/brotli compression for all production response payloads
app.use(compression());

// Serve strictly static assets from the public directory
app.use(express.static(path.join(__dirname, 'public'), {
   maxAge: 0,
   etag: false,  // disable ETags so browser always fetches fresh JS/CSS
   lastModified: false,
}));

// Parse JSON request bodies (needed for the Gemini proxy + transcript injection)
app.use(express.json({ limit: '1mb' }));

// ── Gemini API proxy ─────────────────────────────────────────────────────────
// The Firebase API key has API_KEY_SERVICE_BLOCKED for generativelanguage API.
// Set GEMINI_API_KEY env var to a key from https://aistudio.google.com/apikey
// Example:  $env:GEMINI_API_KEY="AIza..."; node server.js
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('\n⚠️  GEMINI_API_KEY env var not set — AI quiz questions will be disabled.');
  console.warn('   Get a free key at https://aistudio.google.com/apikey and run:');
  console.warn('   $env:GEMINI_API_KEY="AIza..."; node server.js\n');
}
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

app.post('/api/quiz-generate', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY not configured on server' });
  }
  try {
    // Ensure reasonable token limits — quiz batches can be large
    const body = req.body;
    if (body.generationConfig) {
      // Cap maxOutputTokens to 16384 if not already set or set too low
      if (!body.generationConfig.maxOutputTokens || body.generationConfig.maxOutputTokens < 2048) {
        body.generationConfig.maxOutputTokens = 8192;
      }
      // Disable thinking budget for faster, deterministic quiz generation
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('[Gemini API error]', response.status, JSON.stringify(data).slice(0, 200));
    }
    res.status(response.ok ? 200 : response.status).json(data);
  } catch (err) {
    console.error('[Gemini proxy error]', err.message);
    res.status(502).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Comprehension Generate proxy ─────────────────────────────────────────────
// Forwards to the deployed Cloud Function so Comprehension Adventure works locally.
// CRITICAL FIX: The Cloud Function's transcript scraper fails on Cloud Run IPs
// (YouTube bot-detection blocks server-side fetches from Google Cloud).
// We fetch the transcript HERE on the local/dev server (where it works) and
// inject it into the request body so the Cloud Function uses it directly.
const COMPREHENSION_FUNCTION_URL = 'https://comprehensiongenerate-xclutmzc7a-uc.a.run.app';

/**
 * Fetch the full transcript text for a YouTube video.
 * Reuses extractTranscriptData() for caption track discovery,
 * then downloads and flattens the JSON3 caption segments.
 */
async function fetchYouTubeTranscriptLocal(videoId) {
  const MAX_RETRIES = 3;

  // Initial cooldown — the video search pipeline may have hit YouTube's watch
  // page recently, which can trigger rate limiting on subsequent requests.
  await new Promise(r => setTimeout(r, 3000));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (pageRes.status === 429) {
        const delay = attempt * 3000; // 3s, 6s, 9s
        console.log(`[local-transcript] YouTube rate limited (429) for ${videoId}, retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!pageRes.ok) {
        console.log(`[local-transcript] HTTP ${pageRes.status} for ${videoId}`);
        return null;
      }
      const html = await pageRes.text();
      const trackData = extractTranscriptData(html, videoId);
      if (!trackData) {
        console.log(`[local-transcript] No caption tracks found for ${videoId}`);
        return null;
      }

      // Fetch captions in JSON3 format (segments with timestamps)
      const captRes = await fetch(trackData.baseUrl + '&fmt=json3');
      if (captRes.status === 429 && attempt < MAX_RETRIES) {
        const delay = attempt * 3000;
        console.log(`[local-transcript] Caption URL rate limited (429), retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!captRes.ok) {
        console.log(`[local-transcript] Caption fetch failed: HTTP ${captRes.status}`);
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
        console.log(`[local-transcript] Transcript too short (${transcript.length} chars) for ${videoId}`);
        return null;
      }
      console.log(`[local-transcript] ✅ Fetched ${transcript.length} chars for ${videoId} (lang: ${trackData.langCode})`);
      return transcript;
    } catch (err) {
      console.warn(`[local-transcript] Attempt ${attempt} failed for ${videoId}:`, err.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, attempt * 3000));
      }
    }
  }
  console.warn(`[local-transcript] All ${MAX_RETRIES} retries failed for ${videoId}`);
  return null;
}

app.post('/api/comprehension-generate', async (req, res) => {
  try {
    const body = { ...req.body };

    // For video question generation: fetch transcript locally and generate questions
    // directly using the local Gemini API key — bypasses Cloud Run's YouTube blocking
    if (body.phase === 'questions' && body.medium === 'video' && body.mediaContent?.videoId && GEMINI_API_KEY) {
      const videoId = body.mediaContent.videoId;
      const { educationLevel = 'P2', numQuestions = 5, videoTimeLimitSec = null } = body;
      console.log(`[comprehension-local] Fetching transcript locally for ${videoId}...`);
      const rawTranscript = await fetchYouTubeTranscriptLocal(videoId);

      if (rawTranscript) {
        // Trim to watched portion if time limit is set
        let transcript = rawTranscript;
        if (videoTimeLimitSec && videoTimeLimitSec > 0) {
          const estimatedChars = Math.round(videoTimeLimitSec * 12.5);
          transcript = rawTranscript.slice(0, estimatedChars);
          console.log(`[comprehension-local] Trimmed transcript to ${transcript.length} chars for ${videoTimeLimitSec}s limit`);
        }

        // Build transcript-grounded prompt (mirrors the Cloud Function's PATH A prompt)
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

        console.log(`[comprehension-local] Generating questions from ${transcript.length} chars of transcript...`);
        const geminiResp = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(55000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: transcriptPrompt }] }],
            generationConfig: {
              thinkingConfig: { thinkingBudget: 0 },
              maxOutputTokens: 4096,
            },
          }),
        });

        const geminiData = await geminiResp.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          const qData = JSON.parse(jsonMatch[0]);
          if (qData?.questions?.length) {
            console.log(`[comprehension-local] ✅ Generated ${qData.questions.length} transcript-grounded questions for ${videoId}`);
            return res.status(200).json(qData);
          }
        }
        console.warn(`[comprehension-local] Gemini returned no valid questions — falling back to Cloud Function`);
      } else {
        // No transcript — handle metadata fallback locally instead of forwarding
        // to Cloud Function (which also can't fetch transcripts from Cloud Run IPs).
        console.log(`[comprehension-local] No transcript available for ${videoId}`);

        const allowMetadataFallback = body.allowMetadataFallback !== false;
        if (!allowMetadataFallback) {
          console.warn(`[comprehension-local] allowMetadataFallback=false — returning no_transcript error`);
          return res.status(200).json({
            error: 'no_transcript',
            videoId,
            message: 'This video does not have captions. Please try a different video that has captions enabled.',
          });
        }

        // Fetch metadata directly from YouTube (avoid self-referencing localhost)
        let metaTitle = '', metaChannel = '', metaDesc = '';
        try {
          // oEmbed for title/channel (lightweight, reliable)
          const oResp = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
          if (oResp.ok) {
            const oData = await oResp.json();
            metaTitle   = oData.title || '';
            metaChannel = oData.author_name || '';
          }
        } catch {}

        // Fetch full description from watch page
        try {
          const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          });
          if (pageRes.ok) {
            const html = await pageRes.text();
            // Extract description
            const descMatch = html.match(/"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (descMatch) {
              metaDesc = descMatch[1]
                .replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
                .slice(0, 500).trim();
            }
            // Fallback title from watch page if oEmbed failed
            if (!metaTitle) {
              const titleMatch = html.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
              if (titleMatch) metaTitle = titleMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
            if (!metaChannel) {
              const channelMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
              if (channelMatch) metaChannel = channelMatch[1];
            }
          }
        } catch (e) {
          console.warn(`[comprehension-local] Watch page metadata fetch failed:`, e.message);
        }

        if (!metaTitle) {
          console.warn(`[comprehension-local] Could not even fetch video metadata — returning error`);
          return res.status(200).json({
            error: 'no_transcript',
            videoId,
            message: 'Could not access video captions or metadata.',
          });
        }

        console.log(`[comprehension-local] Generating questions from metadata — title: "${metaTitle}", desc: ${metaDesc.length} chars`);

        // Build a metadata-grounded prompt that uses ALL available info (title + description + channel)
        // This is much better than the Cloud Function's fallback which only uses the title.
        const metadataPrompt =
          `You are an expert educational content creator for ${educationLevel} students.\n\n` +
          `A student just watched a YouTube video. Here is everything we know about it:\n` +
          `- Title: "${metaTitle}"\n` +
          (metaChannel ? `- Channel: "${metaChannel}"\n` : '') +
          (metaDesc ? `- Description: "${metaDesc}"\n` : '') +
          `\n` +
          (videoTimeLimitSec && videoTimeLimitSec > 0
            ? `The student watched only the first ${videoTimeLimitSec} seconds.\n\n`
            : '') +
          `Based on the video's title${metaDesc ? ' and description' : ''}, determine the SPECIFIC educational topic. ` +
          `Then generate exactly ${numQuestions} multiple-choice comprehension questions that:\n` +
          `- Test understanding of SPECIFIC facts, concepts, and details that would be covered in a video with this title and description\n` +
          `- Are phrased as "In the video, ..." or "According to the video, ..." to make clear they reference watched content\n` +
          `- Ask about concrete details (names, numbers, processes, cause-and-effect) rather than vague generalities\n\n` +
          `Strict rules:\n` +
          `1. Extract the educational topic from the title and description — do NOT generate generic questions\n` +
          `2. Questions must be specific enough that only someone who watched the video could confidently answer\n` +
          `3. Each question has exactly 4 answer options (A, B, C, D)\n` +
          `4. Only ONE answer is correct; distractors must be plausible but clearly wrong\n` +
          `5. The "explanation" must explain why the correct answer fits the video's topic\n` +
          `6. Language and cognitive complexity appropriate for: ${educationLevel}\n` +
          `7. Answer text must be in English only — no Chinese characters, no symbols\n` +
          `8. No meta-questions ("What is the title?") — ask about the CONTENT of the topic\n\n` +
          `Return ONLY valid JSON:\n` +
          `{ "questions": [{ "question": "?", "answers": [{"id":"a","text":""},{"id":"b","text":""},{"id":"c","text":""},{"id":"d","text":""}], "correctId": "a", "explanation": "" }] }`;

        const geminiResp = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(55000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: metadataPrompt }] }],
            generationConfig: {
              thinkingConfig: { thinkingBudget: 0 },
              maxOutputTokens: 4096,
            },
          }),
        });

        const geminiData = await geminiResp.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const qData = JSON.parse(jsonMatch[0]);
          if (qData?.questions?.length) {
            console.log(`[comprehension-local] ✅ Generated ${qData.questions.length} metadata-based questions for ${videoId}`);
            return res.status(200).json(qData);
          }
        }
        console.warn(`[comprehension-local] Metadata-based generation failed — returning error`);
        return res.status(200).json({
          error: 'generation_failed',
          videoId,
          message: 'Could not generate questions from video metadata.',
        });
      }
    }

    // Fallback: proxy to Cloud Function for non-video requests, image analysis, etc.
    const response = await fetch(COMPREHENSION_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[comprehension-generate proxy error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// ── YouTube Video Search (local implementation) ──────────────────────────────
// Full local implementation so it works without deploying Cloud Functions.
// Strategy:
//   1. Ask Gemini to generate search queries
//   2. Use YouTube's public search (no API key needed)
//   3. Verify transcript is fetchable for each candidate when requireCaption=true
//   4. Validate via oEmbed before returning

/**
 * Extract transcript from already-fetched YouTube watch page HTML.
 * Returns { transcript, tracks } or null.
 */
function extractTranscriptData(html, videoId) {
  let tracks = [];
  const startIdx = html.indexOf('"captionTracks":');
  if (startIdx !== -1) {
    const arrStart = html.indexOf('[', startIdx);
    if (arrStart !== -1) {
      let depth = 0, arrEnd = -1;
      for (let i = arrStart; i < html.length && i < arrStart + 50000; i++) {
        if (html[i] === '[') depth++;
        else if (html[i] === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
      }
      if (arrEnd !== -1) {
        try { tracks = JSON.parse(html.slice(arrStart, arrEnd)); } catch {}
      }
    }
  }
  if (!tracks.length) return null;

  // Prefer English (manual > auto), fall back to first
  const en = tracks.find(t => t.languageCode === 'en' && !t.kind) ||
             tracks.find(t => t.languageCode === 'en') ||
             tracks.find(t => t.languageCode?.startsWith('en')) ||
             tracks[0];
  if (!en?.baseUrl) return null;

  // Unescape the baseUrl
  const cleanUrl = en.baseUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  return { baseUrl: cleanUrl, langCode: en.languageCode, trackCount: tracks.length };
}

/**
 * Check if a YouTube video has caption tracks by fetching its watch page.
 * Does NOT download the actual caption text (that happens later during question generation).
 * This avoids the secondary request that triggers YouTube's rate limiter.
 * Returns { hasCaptions, langCode, trackCount } or null on error.
 */
async function checkVideoCaptions(videoId) {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!pageRes.ok) {
      console.log(`[captions] HTTP ${pageRes.status} for ${videoId}`);
      return null;
    }
    const html = await pageRes.text();

    const trackData = extractTranscriptData(html, videoId);
    if (!trackData) {
      console.log(`[captions] No caption tracks for ${videoId}`);
      return { hasCaptions: false };
    }

    // If we found caption tracks with an English track and a baseUrl, that's good enough.
    // The actual transcript will be fetched later by the comprehension-generate endpoint.
    console.log(`[captions] ${videoId}: ${trackData.trackCount} track(s), lang=${trackData.langCode} — captions confirmed ✓`);
    return { hasCaptions: true, langCode: trackData.langCode, trackCount: trackData.trackCount };
  } catch (err) {
    console.warn(`[captions] Error for ${videoId}:`, err.message);
    return null;
  }
}

/**
 * Search YouTube using the public search page (no API key needed).
 * Returns array of {videoId} objects.
 * @param {string} query - Search terms
 * @param {number} maxResults - Max number of video IDs to return
 * @param {number} maxDurationMin - Max video duration in minutes (used to pick duration filter bucket)
 */
async function searchYouTubePublic(query, maxResults = 10, maxDurationMin = 0) {
  try {
    // YouTube search page `sp` param encodes filters.
    // EgIQAQ== → type=video (base)
    // Duration buckets (combined with type=video):
    //   short (<4 min):  EgIYAQ== → combined with type=video: EgQQARgB
    //   medium (4-20):   EgIYAw== → combined: EgQQARgD
    //   long (>20):      EgIYAg== → combined: EgQQARgC
    let sp = 'EgIQAQ%3D%3D'; // default: type=video only
    if (maxDurationMin > 0 && maxDurationMin <= 4) {
      sp = 'EgQQARgB'; // type=video + short (<4 min)
    } else if (maxDurationMin > 4 && maxDurationMin <= 20) {
      sp = 'EgQQARgD'; // type=video + medium (4-20 min)
    }
    // For maxDurationMin > 20 or 0 (no limit), don't restrict duration bucket

    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${sp}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results = [];
    const videoIdPattern = /"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g;
    const seen = new Set();
    let match;
    while ((match = videoIdPattern.exec(html)) !== null && results.length < maxResults) {
      const vid = match[1];
      if (seen.has(vid)) continue;
      seen.add(vid);
      results.push({ videoId: vid });
    }
    return results;
  } catch (err) {
    console.warn(`[ytSearch] Public search failed for "${query}":`, err.message);
    return [];
  }
}

/**
 * Fetch the actual duration (in seconds) of a YouTube video from its watch page.
 * Returns the duration in seconds, or 0 if it could not be determined.
 */
async function fetchVideoDurationSec(videoId) {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!pageRes.ok) return 0;
    const html = await pageRes.text();
    const lenMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    return lenMatch ? parseInt(lenMatch[1]) : 0;
  } catch {
    return 0;
  }
}

app.post('/api/youtube-video-search', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });
  }

  const { educationLevel = 'P2', subject = null, maxDurationMin = 0,
          exclude = [], requireCaption = false } = req.body;

  const maxDurSec = maxDurationMin > 0 ? maxDurationMin * 60 : 0;
  console.log(`[ytVideoSearch] Starting (requireCaption=${requireCaption}, maxDurationMin=${maxDurationMin}, subject=${subject || 'any'})`);

  // Step 1: Ask Gemini for search queries
  const durationGuidance = maxDurationMin > 0
    ? `Videos should be ${maxDurationMin} minutes or shorter. Prefer short-form content.\n`
    : '';
  const captionGuidance = requireCaption
    ? `IMPORTANT: Bias queries toward channels that ALWAYS have captions:\n` +
      `TED-Ed, National Geographic Kids, BBC Earth, SciShow Kids, Kurzgesagt, Khan Academy, Crash Course Kids.\n` +
      `Include the channel name, e.g. "TED-Ed how volcanoes work".\n`
    : '';
  const subjectNote = subject ? ` about "${subject}"` : '';

  const queryPrompt =
    `You are an educational content curator for ${educationLevel} students.\n` +
    `Generate 5 different YouTube search queries for great educational videos${subjectNote}.\n` +
    `Suitable for children, interesting topics.\n` +
    `${durationGuidance}` +
    `${captionGuidance}` +
    `Each query: 3-6 words, specific.\n` +
    `Return ONLY valid JSON:\n{"queries":["q1","q2","q3","q4","q5"]}`;

  let queries = [];
  try {
    const gResp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: queryPrompt }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 512 },
      }),
    });
    const gData = await gResp.json();
    const raw = gData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      queries = (parsed.queries || []).filter(q => typeof q === 'string' && q.length > 2);
    }
  } catch (err) {
    console.warn('[ytVideoSearch] Gemini query gen failed:', err.message);
  }

  if (!queries.length) {
    queries = requireCaption
      ? ['TED-Ed science explained', 'National Geographic Kids animals', 'Kurzgesagt how things work',
         'SciShow Kids experiments', 'Crash Course Kids earth science']
      : ['educational science for kids', 'nature animals documentary children',
         'how things work kids educational', 'space planets for kids', 'history for children'];
  }
  console.log(`[ytVideoSearch] Queries:`, queries);

  const excludeSet = new Set(exclude);
  // CRITICAL: Only check 3 candidates per query to avoid YouTube rate limiting (429).
  // Increased from 2 to 3 to give duration filtering more chances to find a match.
  const MAX_CHECKS_PER_QUERY = 3;

  for (const query of queries) {
    const results = await searchYouTubePublic(query, 10, maxDurationMin);
    console.log(`[ytVideoSearch] "${query}" => ${results.length} results`);

    let checksThisQuery = 0;
    for (const item of results) {
      if (excludeSet.has(item.videoId)) continue;
      if (checksThisQuery >= MAX_CHECKS_PER_QUERY) break;

      // Validate via oEmbed first (lightweight, no rate limit)
      try {
        const oResp = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${item.videoId}&format=json`
        );
        if (!oResp.ok) continue;
        const oData = await oResp.json();

        // ── Duration enforcement ─────────────────────────────────────────
        // YouTube's coarse duration buckets (short/medium/long) are unreliable
        // — a "short" bucket can still return 3:59 when user wants ≤3:00.
        // Fetch the exact duration and reject if it exceeds the user's max.
        if (maxDurSec > 0) {
          checksThisQuery++;
          await new Promise(r => setTimeout(r, 800));
          const actualDur = await fetchVideoDurationSec(item.videoId);
          if (actualDur > 0 && actualDur > maxDurSec) {
            const durMin = Math.round(actualDur / 60 * 10) / 10;
            console.log(`[ytVideoSearch] ${item.videoId} too long (${durMin}min > ${maxDurationMin}min max) — skipping`);
            continue;
          }
          if (actualDur > 0) {
            console.log(`[ytVideoSearch] ${item.videoId} duration OK: ${Math.round(actualDur/60*10)/10}min ≤ ${maxDurationMin}min`);
          }
        }

        if (requireCaption) {
          checksThisQuery++;
          // Delay to be respectful to YouTube
          await new Promise(r => setTimeout(r, 1500));
          const captionCheck = await checkVideoCaptions(item.videoId);
          if (!captionCheck?.hasCaptions) {
            console.log(`[ytVideoSearch] ${item.videoId} — no captions, skipping`);
            continue;
          }
          console.log(`[ytVideoSearch] ✅ FOUND with captions: ${item.videoId} — "${oData.title}"`);
        } else {
          console.log(`[ytVideoSearch] ✅ FOUND: ${item.videoId} — "${oData.title}"`);
        }

        return res.status(200).json({
          videoId: item.videoId,
          title: oData.title || '',
          channelName: oData.author_name || '',
          description: '',
          searchQuery: query,
          hasCaption: requireCaption,
        });
      } catch { continue; }
    }
    // Delay between search queries to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }

  console.error('[ytVideoSearch] No suitable video found');
  res.status(200).json({ error: 'no_video_found' });
});
// ─────────────────────────────────────────────────────────────────────────────

// ── YouTube Video Info (duration, channel, description) ──────────────────
// Scrapes the YouTube watch page to extract accurate video metadata.
// Used by the preview card instead of relying on Gemini AI estimates.
app.get('/api/youtube-video-info', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!pageRes.ok) {
      return res.status(502).json({ error: `YouTube returned HTTP ${pageRes.status}` });
    }
    const html = await pageRes.text();

    // Extract duration from lengthSeconds in playerMicroformatRenderer or videoDetails
    let durationSec = 0;
    const lenMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    if (lenMatch) durationSec = parseInt(lenMatch[1]);

    // Extract channel name from videoDetails or microformat
    let channelName = '';
    const channelMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    if (channelMatch) channelName = channelMatch[1];
    if (!channelName) {
      const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/);
      if (authorMatch) channelName = authorMatch[1];
    }

    // Extract short description
    let description = '';
    const descMatch = html.match(/"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (descMatch) {
      description = descMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .slice(0, 300)
        .trim();
    }

    // Extract title
    let title = '';
    const titleMatch = html.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (titleMatch) {
      title = titleMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }

    console.log(`[ytVideoInfo] ${videoId}: ${durationSec}s, channel="${channelName}"`);
    res.json({ videoId, durationSec, channelName, description, title });
  } catch (err) {
    console.error('[ytVideoInfo] Error:', err.message);
    res.status(502).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Admin Action proxy ───────────────────────────────────────────────────────
// Forwards to the deployed Cloud Function so admin features work locally.
const ADMIN_FUNCTION_URL = 'https://adminaction-xclutmzc7a-uc.a.run.app';

app.post('/api/admin-action', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const response = await fetch(ADMIN_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[admin-action proxy error]', err.message);
    res.status(502).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Pixabay proxy ────────────────────────────────────────────────────────────
const PIXABAY_FUNCTION_URL = 'https://pixabaysearch-xclutmzc7a-uc.a.run.app';

app.get('/api/pixabay-search', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const response = await fetch(`${PIXABAY_FUNCTION_URL}?${qs}`);
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[pixabay proxy error]', err.message);
    res.status(502).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Unsplash proxy ───────────────────────────────────────────────────────────
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || '';
if (!UNSPLASH_ACCESS_KEY || UNSPLASH_ACCESS_KEY === 'YOUR_UNSPLASH_ACCESS_KEY_HERE') {
  console.warn('\n⚠️  UNSPLASH_ACCESS_KEY not set — Unsplash image source will be skipped.');
  console.warn('   Get a free key at https://unsplash.com/developers and add to .env:\n   UNSPLASH_ACCESS_KEY=your_key_here\n');
}

app.get('/api/unsplash-search', async (req, res) => {
  if (!UNSPLASH_ACCESS_KEY || UNSPLASH_ACCESS_KEY === 'YOUR_UNSPLASH_ACCESS_KEY_HERE') {
    return res.status(503).json({ error: 'UNSPLASH_ACCESS_KEY not configured' });
  }
  try {
    const q = req.query.q || '';
    const perPage = Math.min(parseInt(req.query.per_page) || 10, 30);
    const orientation = req.query.orientation || 'landscape';
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${perPage}&orientation=${orientation}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}` }
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('[unsplash error]', response.status, errText.slice(0, 200));
      return res.status(response.status).json({ error: errText });
    }
    const data = await response.json();
    // Normalize to a hits-style array matching Pixabay format for easy client-side handling
    const hits = (data.results || []).map(photo => ({
      webformatURL: photo.urls?.regular || photo.urls?.small,
      tags: photo.description || photo.alt_description || '',
      unsplashId: photo.id,
      credit: `Photo by ${photo.user?.name || 'Unknown'} on Unsplash`,
      creditUrl: `${photo.links?.html}?utm_source=EduGaze&utm_medium=referral`
    }));
    res.json({ hits });
  } catch (err) {
    console.error('[unsplash proxy error]', err.message);
    res.status(502).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Spot the Character — Image Generation + Bbox Locator ─────────────────────
// Uses gemini-2.0-flash-preview-image-generation to create the scene, then
// uses gemini-2.5-flash (vision) to locate the hidden character's bounding box.

// Image generation model URLs:
// FREE  — gemini-3.1-flash-image-preview 🍌 (Nano Banana, supports aspectRatio param)
// PAID  — imagen-4.0-generate-001 (highest quality, uses /predict endpoint)
const GEMINI_IMAGE_GEN_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_API_KEY}`;
const IMAGEN4_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${GEMINI_API_KEY}`;

app.post('/api/spot-char-generate', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });

  const { theme, scene, otherCount = 10, findCount = 1, usePaidTier = false } = req.body || {};
  if (!theme || !scene) return res.status(400).json({ error: 'theme and scene are required' });

  const bgCount   = Math.min(Math.max(parseInt(otherCount) || 10, 2), 50);
  const findN     = Math.min(Math.max(parseInt(findCount)  || 1,  1), 5);
  const isPaid    = usePaidTier === true || usePaidTier === 'true';

  console.log(`[SpotChar] Model tier: ${isPaid ? 'PAID (Imagen 3)' : 'FREE (Gemini Flash Image)'}`);

  // ── Step 1: Generate landscape scene ──────────────────────────────────────
  // IMPORTANT: The aspectRatio: '16:9' config param enforces the true landscape
  // output at the API level. The text prompt also reinforces this.
  const imagePrompt =
    `HORIZONTAL WIDESCREEN LANDSCAPE IMAGE ONLY — 16:9 aspect ratio like a cinema screen. ` +
    `DO NOT generate a portrait or square image under any circumstances. ` +
    `This is for a children's "Where's Waldo" / "Where's Wally" style hidden-picture game. ` +
    `Draw an original, richly detailed background scene inspired by the visual style and world of "${scene}". ` +
    `Fill this scene with ${bgCount} unique original characters whose visual design is inspired by the world of "${scene}" — ` +
    `each clearly different from one another, no two alike. ` +
    `CRITICALLY IMPORTANT: Scattered across DIFFERENT locations in the scene (left third, centre, and right third), ` +
    `draw exactly ${findN} CHARACTER(S) that are CLEARLY and OBVIOUSLY inspired by "${theme}". ` +
    `These "${theme}"-inspired characters MUST:\n` +
    `- Be clearly recognisable and visible to a 9-year-old child\n` +
    `- Be at least medium-sized (not tiny or partially hidden)\n` +
    `- Look NOTICEABLY different in colour, shape, or costume from the "${scene}" background characters\n` +
    `- NOT be obscured, blended into backgrounds, or hidden behind objects\n` +
    `- Be placed in the FOREGROUND or MID-GROUND of the scene, NOT far in the background\n` +
    `- Be ENTIRELY AND COMPLETELY INSIDE the image — NO character body parts cropped by the frame edge\n` +
    `- Be placed at least 15% away from ALL four edges of the image (top, bottom, left, right)\n` +
    `- NEVER be placed in a corner or along any image border\n` +
    `Keep the top-left 15% of the image free of any "${theme}"-inspired characters (reserved for UI). ` +
    `No text, no labels, no watermarks. High detail, colourful, crowded, joyful.`;

  console.log(`[SpotChar] Generating: ${findN}x "${theme}"-style in "${scene}"-style + ${bgCount} bg chars`);

  // ── Helper: human-readable PROHIBITED_CONTENT explanation ──────────────────
  const _buildProhibitedMsg = (rawReason) => {
    // Common reasons the content filter blocks image generation:
    const tips = [
      `“${theme}” or “${scene}” may reference a copyrighted character or brand name`,
      `The combination may depict real-world people, celebrities, or public figures`,
      `The prompt may contain content perceived as violent, sexual, or unsafe for children`,
      `Named franchises (Disney, Peppa Pig, etc.) are often blocked — try describing the visual style instead (e.g. “a pink cartoon pig in a dress” rather than “Peppa Pig”)`,
    ];
    return (
      `❌ Blocked by AI content filter for Theme: “${theme}” / Scene: “${scene}”.\n` +
      `Reason code: ${rawReason}.\n` +
      `Common causes:\n` +
      tips.map((t, i) => `  ${i+1}. ${t}`).join('\n')
    );
  };

  let imageBase64 = null, mimeType = 'image/png';
  try {
    if (isPaid) {
      // ── Paid: Imagen 4 — /predict endpoint ────────────────────────────────────
      const imgResp = await fetch(IMAGEN4_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          instances: [{ prompt: imagePrompt }],
          parameters: { sampleCount: 1, aspectRatio: '16:9' },
        }),
      });
      const imgData = await imgResp.json();
      if (!imgResp.ok) {
        const errMsg = imgData?.error?.message || 'Imagen 4 generation failed';
        const friendly = errMsg.includes('PROHIBITED_CONTENT') || errMsg.includes('prohibited')
          ? _buildProhibitedMsg(errMsg)
          : errMsg;
        return res.status(502).json({ error: friendly });
      }
      const prediction = imgData?.predictions?.[0];
      if (!prediction?.bytesBase64Encoded) {
        const rawReason = imgData?.error?.message || JSON.stringify(imgData).slice(0, 120);
        const reason = rawReason.includes('PROHIBITED_CONTENT') || rawReason.includes('prohibited')
          ? _buildProhibitedMsg(rawReason)
          : `Imagen 4 returned no image: ${rawReason}`;
        console.error('[SpotChar] Imagen 4: no image in response:', rawReason);
        return res.status(502).json({ error: reason });
      }
      imageBase64 = prediction.bytesBase64Encoded;
      mimeType    = prediction.mimeType || 'image/png';
      console.log(`[SpotChar] ✅ Imagen 4 image generated (${Math.round(imageBase64.length/1024)}KB)`);

    } else {
      // ── Free: Gemini 3.1 Flash Image 🍌 — /generateContent endpoint ──────────
      const imgResp = await fetch(GEMINI_IMAGE_GEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: imagePrompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE', 'TEXT'],
            // aspectRatio is the correct param for gemini-2.0-flash-preview-image-generation
            aspectRatio: '16:9',
          },
        }),
      });
      const imgData = await imgResp.json();
      if (!imgResp.ok) {
        const errMsg = imgData?.error?.message || 'Image generation failed';
        const friendly = errMsg.includes('PROHIBITED_CONTENT') || errMsg.includes('prohibited')
          ? _buildProhibitedMsg(errMsg)
          : errMsg;
        return res.status(502).json({ error: friendly });
      }
      const parts   = imgData?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imgPart) {
        const textPart     = parts.find(p => p.text);
        const finishReason = imgData?.candidates?.[0]?.finishReason || '';
        const rawReason    = textPart?.text || finishReason || 'No image returned';
        const isBlocked    = rawReason.includes('PROHIBITED_CONTENT') || rawReason.includes('prohibited')
                          || finishReason === 'SAFETY' || finishReason === 'OTHER';
        const reason = isBlocked ? _buildProhibitedMsg(rawReason) : rawReason;
        console.error('[SpotChar] No image in response. Reason:', rawReason, JSON.stringify(imgData).slice(0,300));
        return res.status(502).json({ error: isBlocked ? reason : `Image not generated: ${reason}. Try different theme/scene names.` });
      }
      imageBase64 = imgPart.inlineData.data;
      mimeType    = imgPart.inlineData.mimeType || 'image/png';
      console.log(`[SpotChar] ✅ Gemini 3.1 Flash Image 🍌 generated (${Math.round(imageBase64.length/1024)}KB)`);
    }
  } catch (err) {
    return res.status(502).json({ error: `Image generation failed: ${err.message}` });
  }

  // ── Step 2: Locate all findN theme characters via vision ──────────────────
  let bboxes = [];
  try {
    // Ask for CENTER x/y + width/height — Gemini vision is more accurate with
    // center-point coordinates than top-left corner estimates.
    const visionPrompt =
      `This "Spot the Character" game image contains exactly ${findN} character(s) inspired by "${theme}" ` +
      `hidden among "${scene}"-style background characters. ` +
      `Your job: find ALL ${findN} "${theme}"-inspired character(s) and report where each one is. ` +
      `For each character, give the CENTER of the character body (cx, cy) and the ` +
      `full WIDTH (w) and HEIGHT (h) of the character — all as fractions from 0.0 to 1.0. ` +
      `RULES:\n` +
      `- cx and cy are the CENTER of the character (not the top-left corner)\n` +
      `- w and h include the full character body with a small padding around it\n` +
      `- All values must be between 0.05 and 0.95 (no character should be at the very edge)\n` +
      `- Return ONLY valid JSON, no other text:\n` +
      `[{"cx":0.5,"cy":0.5,"w":0.1,"h":0.2},...]\n` +
      `Return exactly ${findN} entries. If a character is hard to find, give your best estimate for its center.`;

    const vResp = await fetch(GEMINI_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(35000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: visionPrompt },
        ]}],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 512 },
      }),
    });
    const vData  = await vResp.json();
    const rawText = vData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const arrMatch = rawText.match(/\[[\s\S]*?\]/);
    if (arrMatch) {
      const parsed = JSON.parse(arrMatch[0]);

      // Safe margins: character center must be within [0.12, 0.88] in both axes
      // so the character is fully visible and not near any edge.
      const MARGIN = 0.12;

      const raw = parsed.filter(b => typeof b.cx === 'number' && typeof b.cy === 'number');

      // Support both center-format {cx,cy,w,h} and legacy top-left format {x,y,w,h}
      const normalised = raw.map(b => {
        let cx, cy, w, h;
        if (typeof b.cx === 'number') {
          // Preferred center format
          cx = b.cx; cy = b.cy;
          w  = b.w || 0.08; h = b.h || 0.12;
        } else {
          // Legacy top-left format — convert to center
          w = b.w || 0.08; h = b.h || 0.12;
          cx = b.x + w / 2; cy = b.y + h / 2;
        }
        // Clamp center to safe zone
        cx = Math.max(MARGIN, Math.min(1 - MARGIN, cx));
        cy = Math.max(MARGIN, Math.min(1 - MARGIN, cy));
        // Clamp size
        w = Math.max(0.05, Math.min(0.45, w));
        h = Math.max(0.05, Math.min(0.45, h));
        // Compute top-left, ensuring bbox stays fully inside [0,1]
        const x = Math.max(0.01, Math.min(1 - w - 0.01, cx - w / 2));
        const y = Math.max(0.01, Math.min(1 - h - 0.01, cy - h / 2));
        return { x, y, w, h, cx, cy };
      });

      // Filter out any whose center ended up outside the safe zone after clamping
      bboxes = normalised
        .filter(b => b.cx >= MARGIN && b.cx <= 1 - MARGIN && b.cy >= MARGIN && b.cy <= 1 - MARGIN)
        .slice(0, findN)
        .map(({ x, y, w, h }) => ({ x, y, w, h }));

      console.log(`[SpotChar] ✅ Found ${bboxes.length} bbox(es):`, JSON.stringify(bboxes));
    }
  } catch (err) {
    console.warn('[SpotChar] Vision bbox failed (non-fatal):', err.message);
  }

  // Fallback: evenly spread bboxes if vision failed
  if (bboxes.length === 0) {
    const step = 1 / (findN + 1);
    bboxes = Array.from({ length: findN }, (_, i) => ({
      x: step * (i + 1) - 0.06, y: 0.35, w: 0.12, h: 0.25,
    }));
  }

  res.json({ imageData: imageBase64, mimeType, bboxes, theme, findCount: findN });
});
// ─────────────────────────────────────────────────────────────────────────────

// Route everything else directly to the SPA entry point
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.listen(port, () => {
   console.log(`Education App Production Server is actively bound and listening on port ${port}`);
   console.log(`Open http://localhost:${port} to verify deployments locally before hoisting to Cloud Run / Render / AWS!`);
});

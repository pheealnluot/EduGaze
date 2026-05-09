import express from 'express';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from 'fs';

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
app.use(express.json({ limit: '10mb' }));

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
    `Generate 5 different YouTube search queries for great educational videos${subjectNote}.\n` +
    `Suitable for children. Keep queries varied (e.g. life cycle, facts, documentary, for kids, explained).\n` +
    `${durationGuidance}` +
    `${captionGuidance}` +
    `Each query: 3-6 words, specific.${subject ? ` All queries must include or relate to "${subject}".` : ''}\n` +
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

  // Fallback: use keyword-aware generic queries if Gemini fails
  if (!queries.length) {
    if (subject) {
      // Keyword-aware fallbacks — always include the topic
      queries = [
        `${subject} for kids educational`,
        `${subject} explained children`,
        `${subject} documentary kids`,
        `learn about ${subject} children`,
        `${subject} facts science`,
      ];
    } else {
      queries = requireCaption
        ? ['TED-Ed science explained', 'National Geographic Kids animals', 'Kurzgesagt how things work',
           'SciShow Kids experiments', 'Crash Course Kids earth science']
        : ['educational science for kids', 'nature animals documentary children',
           'how things work kids educational', 'space planets for kids', 'history for children'];
    }
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

const GEMINI_IMAGE_GEN_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_API_KEY}`;

// Helper: Greedily select non-overlapping bboxes.
// Keeps the first bbox, then only adds subsequent ones if their IoU with all
// already-accepted bboxes is below the threshold (default 0.15).
function _removeOverlapping(boxes, maxCount, iouThreshold = 0.15) {
  if (boxes.length <= 1) return boxes.slice(0, maxCount);
  const accepted = [boxes[0]];
  for (let i = 1; i < boxes.length && accepted.length < maxCount; i++) {
    const b = boxes[i];
    let overlaps = false;
    for (const a of accepted) {
      // Compute intersection
      const x1 = Math.max(a.x, b.x);
      const y1 = Math.max(a.y, b.y);
      const x2 = Math.min(a.x + a.w, b.x + b.w);
      const y2 = Math.min(a.y + a.h, b.y + b.h);
      const interW = Math.max(0, x2 - x1);
      const interH = Math.max(0, y2 - y1);
      const interArea = interW * interH;
      const areaA = a.w * a.h;
      const areaB = b.w * b.h;
      const union = areaA + areaB - interArea;
      const iou = union > 0 ? interArea / union : 0;
      // Also check if centers are too close (< 20% image width apart)
      const cxA = a.x + a.w / 2, cyA = a.y + a.h / 2;
      const cxB = b.x + b.w / 2, cyB = b.y + b.h / 2;
      const dist = Math.sqrt((cxA - cxB) ** 2 + (cyA - cyB) ** 2);
      if (iou > iouThreshold || dist < 0.18) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) accepted.push(b);
  }
  if (accepted.length < boxes.length) {
    console.log(`[SpotChar] Overlap filter: kept ${accepted.length} of ${boxes.length} bbox(es)`);
  }
  return accepted;
}

// Helper to scan and generate gallery.json
function updateGalleryJson() {
  try {
    const assetsDir = path.join(__dirname, 'public', 'assets');
    const images = [];

    function walk(dir) {
      if (!statSync(dir, { throwIfNoEntry: false })) return;
      const files = readdirSync(dir);
      for (const f of files) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) {
          const folderName = path.basename(p).toLowerCase();
          // Skip known non-character folders
          if (folderName === 'wrong png' || folderName === 'raw_image' || folderName === 'archive' || folderName === 'backgrounds') continue;
          walk(p);
        } else if (p.toLowerCase().endsWith('.png') || p.toLowerCase().endsWith('.webp')) {
          const lowerF = f.toLowerCase();
          if (lowerF.includes('background') || lowerF.includes('skyline') || lowerF.includes('water')) continue;
          
          const relPath = p.substring(assetsDir.length + 1).replace(/\\/g, '/');
          
          let name = f.replace(/\.(png|webp)$/i, '')
                      .replace(/-removebg-preview/i, '')
                      .replace(/_[a-z0-9]+$/i, '')
                      .replace(/[-_]/g, ' ')
                      .trim();
                      
          const isGarbage = 
            /^[a-z0-9]{10,}$/i.test(name.replace(/\s/g, '')) || 
            /[0-9]{4,}/.test(name) || 
            name.toLowerCase().includes('screenshot') ||
            name.toLowerCase().startsWith('images') ||
            name.toLowerCase() === 'maxresdefault' ||
            name.toLowerCase().startsWith('download');
            
          if (isGarbage) {
            name = '';
          } else {
            name = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          }
          
          images.push({ url: 'assets/' + relPath, name });
        }
      }
    }
    
    walk(assetsDir);
    images.sort((a, b) => a.name.localeCompare(b.name));
    
    writeFileSync(path.join(assetsDir, 'gallery.json'), JSON.stringify({ images }, null, 2));
    console.log(`[SpotChar] Updated gallery.json with ${images.length} images`);
  } catch (err) {
    console.error('[SpotChar] Failed to update gallery.json:', err);
  }
}

// Generate it on server start
updateGalleryJson();

// We still keep a GET endpoint just in case, but it reads the file
app.get('/api/spot-char-gallery', (req, res) => {
  try {
    const data = readFileSync(path.join(__dirname, 'public', 'assets', 'gallery.json'), 'utf8');
    res.type('json').send(data);
  } catch (e) {
    res.status(404).json({ error: 'Gallery not found' });
  }
});

app.post('/api/spot-char-gallery/upload', (req, res) => {
  try {
    const { name, imageBase64 } = req.body;
    if (!name || !imageBase64) return res.status(400).json({ error: 'Missing name or imageBase64' });

    const uploadsDir = path.join(__dirname, 'public', 'assets', 'uploads');
    if (!statSync(uploadsDir, { throwIfNoEntry: false })) {
      mkdirSync(uploadsDir, { recursive: true });
    }

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Sanitize filename
    const safeName = name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const fileName = `${safeName}_${Date.now()}.png`;
    const filePath = path.join(uploadsDir, fileName);
    
    writeFileSync(filePath, buffer);
    console.log(`[SpotChar] Saved new gallery image: ${fileName}`);
    updateGalleryJson(); // Update static JSON
    res.json({ url: `assets/uploads/${fileName}`, name });
  } catch (err) {
    console.error('[SpotChar] Upload error:', err);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

app.post('/api/spot-char-gallery/delete', (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.startsWith('assets/')) return res.status(400).json({ error: 'Invalid URL' });
    
    const filePath = path.join(__dirname, 'public', url);
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(path.join(__dirname, 'public', 'assets'))) {
      return res.status(403).json({ error: 'Forbidden path' });
    }
    
    if (statSync(normalizedPath, { throwIfNoEntry: false })) {
      const archiveDir = path.join(__dirname, 'public', 'assets', 'archive');
      if (!statSync(archiveDir, { throwIfNoEntry: false })) {
        mkdirSync(archiveDir, { recursive: true });
      }
      const newPath = path.join(archiveDir, path.basename(normalizedPath));
      renameSync(normalizedPath, newPath);
      console.log(`[SpotChar] Archived gallery image: ${url}`);
      updateGalleryJson(); // Update static JSON
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    console.error('[SpotChar] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

app.post('/api/spot-char-generate', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not configured' });

  const { theme: rawTheme, scene: rawScene, otherCount = 10, findCount = 1, bgStyle = 'kids', describeVisually = false, describeSceneVisually = false, targetImageUrl } = req.body || {};
  if (!rawTheme || !rawScene) return res.status(400).json({ error: 'theme and scene are required' });

  let inlineTargetImage = null;
  if (targetImageUrl) {
    try {
      const fullPath = path.join(__dirname, 'public', targetImageUrl);
      const fileData = readFileSync(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      let mime = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.webp') mime = 'image/webp';
      inlineTargetImage = { inlineData: { mimeType: mime, data: fileData.toString('base64') } };
      console.log(`[SpotChar] Loaded target image from ${targetImageUrl}`);
    } catch (e) {
      console.warn(`[SpotChar] Failed to load target image ${targetImageUrl}:`, e.message);
    }
  }

  // ── Optional: translate franchise/world names → visual descriptions ────────
  // When enabled, this prevents the franchise's canonical art style from
  // overriding the user's selected art style.
  let theme = rawTheme;
  let scene = rawScene;

  // Helper: call Gemini to translate a name into a visual description
  const _translateVisual = async (name, type) => {
    const typePrompt = type === 'character'
      ? `Convert this franchise/character name into a VISUAL-ONLY description.\n` +
        `Describe ONLY what the character(s) LOOK like: body shape, clothing, colours, accessories, distinctive features.`
      : `Convert this world/location name into a VISUAL-ONLY environment description.\n` +
        `Describe ONLY what the place LOOKS like: architecture, landscape, colours, lighting, atmosphere, key visual elements.`;
    try {
      console.log(`[SpotChar] Translating ${type} → visual description: "${name}"`);
      const resp = await fetch(GEMINI_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text:
            `You are a visual description translator for an AI image generator.\n` +
            `${typePrompt}\n` +
            `DO NOT mention the franchise name, studio, or any copyrighted terms.\n` +
            `Keep it concise (1-2 sentences max).\n\n` +
            `Name: "${name}"\n\n` +
            `Visual description:`
          }] }],
          generationConfig: { maxOutputTokens: 150, temperature: 0.2 },
        }),
      });
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text && text.length > 10) {
        console.log(`[SpotChar] ✅ ${type} translated to: "${text}"`);
        return text;
      }
    } catch (e) {
      console.warn(`[SpotChar] ${type} translation failed (non-fatal): ${e.message}`);
    }
    return null; // fallback to original
  };

  // Run translations in parallel if both are enabled
  const [translatedTheme, translatedScene] = await Promise.all([
    describeVisually      ? _translateVisual(rawTheme, 'character') : Promise.resolve(null),
    describeSceneVisually ? _translateVisual(rawScene, 'scene')     : Promise.resolve(null),
  ]);
  if (translatedTheme) theme = translatedTheme;
  if (translatedScene) scene = translatedScene;

  const bgCount   = Math.min(Math.max(parseInt(otherCount) || 10, 2), 50);
  let findN     = Math.min(Math.max(parseInt(findCount)  || 1,  1), 5);


  // ── Background art style mapping ──────────────────────────────────────────
  const BG_STYLES = {
    wally: {
      prefix:  'CLASSIC "WHERE\'S WALLY / WHERE\'S WALDO" STYLE ILLUSTRATION — ',
      suffix:  'Art style: dense, meticulously detailed hand-drawn crowd illustration exactly like Martin Handford\'s Where\'s Wally books. ' +
               'Overhead or slightly elevated viewpoint over a massive, packed crowd scene. ' +
               'Hundreds of tiny characters fill every inch of the image with no empty space. ' +
               'Bold, flat colours with strong black outlines; cheerful, holiday-fair atmosphere; lots of props, stalls, tents, and activities. ' +
               'The target character(s) must blend into the busy crowd but still be findable. Flat 2-D graphic novel quality.',
    },
    realistic: {
      prefix:  'FULLY PHOTOREALISTIC — ',
      suffix:  'Art style: EVERYTHING in this image must be STRICTLY HYPER-REALISTIC — rendered as a high-resolution photograph or cinematic 3D render. ' +
               'This includes the background, environment, AND all characters (both background and target). ' +
               'Use cinematic lighting, volumetric fog, ray-traced global illumination, physical depth of field (bokeh), ' +
               'real-world textures (skin, fur, fabric, brick, glass, wood, leaves, water reflections), atmospheric perspective, and natural shadows. ' +
               'Characters must look like real animals, real people, or physically plausible 3D-rendered creatures — NOT cartoons, NOT illustrations, NOT anime. ' +
               'The entire scene should look like a high-end nature documentary, wildlife photography, or cinematic CGI film frame. ' +
               'NO cartoon outlines, NO flat colours, NO cel-shading, NO illustrated style anywhere in the image.',
    },
    stylistic: {
      prefix:  'BOLD STYLISTIC DIGITAL ILLUSTRATION — ',
      suffix:  'Art style: modern stylistic concept art with a strong graphic design sensibility. ' +
               'Vibrant, curated colour palette (teals, deep purples, warm golds); sweeping compositional shapes; ' +
               'semi-flat characters with expressive silhouettes and subtle gradients. ' +
               'Inspired by award-winning children\'s book covers and animated film concept art. ' +
               'Clean, intentional design language — every element feels hand-composed. Highly decorative and visually striking.',
    },
    comic: {
      prefix:  'BOLD AMERICAN COMIC BOOK STYLE — ',
      suffix:  'Art style: classic superhero comic-book panel art. ' +
               'Strong, dynamic ink outlines with Ben-Day dot shading and halftone textures. ' +
               'Bold primary colours: red, blue, yellow, green. ' +
               'Dramatic low-angle or dynamic perspective; action lines and energy bursts; chunky speech-bubble ready layout. ' +
               'Inspired by classic Marvel/DC golden-age comic books. High contrast; no gradients; print-style flat ink look.',
    },
    kids: {
      prefix:  'JOYFUL CHILDREN\'S PICTURE-BOOK ILLUSTRATION — ',
      suffix:  'Art style: warm, friendly children\'s picture-book style. ' +
               'Soft, rounded character designs with expressive faces and chunky proportions suitable for young children. ' +
               'Pastel-leaning palette with bright accent colours; gentle textures like coloured pencil or watercolour washes. ' +
               'Inspired by the illustration style of Pixar, Studio Ghibli children\'s films, and popular picture-books. ' +
               'Inviting, non-threatening, joyful atmosphere — every detail should make a child smile.',
    },
    scene: {
      prefix:  `ART STYLE OF "${scene}" — `,
      suffix:  `Art style: Replicate the EXACT visual art style, colour palette, line work, textures, and rendering technique of "${scene}". ` +
               `Study what "${scene}" looks like in its original media (animated film, TV show, book, game, etc.) and MATCH that style precisely. ` +
               `For example: if "${scene}" is a Studio Ghibli world, use Ghibli\'s signature watercolour backgrounds with soft edges and luminous skies. ` +
               `If "${scene}" is Minecraft, use blocky pixel-art voxel rendering. If it\'s a Tim Burton film, use gothic, dark, angular stylisation. ` +
               `The entire image — background, environment, AND all characters — must look like it belongs in the world of "${scene}". ` +
               `Match the original art direction as faithfully as possible.`,
    },
    character: {
      prefix:  `ART STYLE OF "${theme}" — `,
      suffix:  `Art style: Replicate the EXACT visual art style, colour palette, line work, textures, and rendering technique of "${theme}"\'s original media. ` +
               `Study what "${theme}" looks like in its source cartoon, anime, film, book, or game and MATCH that style precisely for the ENTIRE image. ` +
               `For example: if "${theme}" is Peppa Pig, use the simple flat 2D vector style with bold outlines and bright primary colours that Peppa Pig uses. ` +
               `If "${theme}" is Pokémon, use the anime cel-shaded style of the Pokémon animated series. ` +
               `If "${theme}" is from a Pixar film, use Pixar\'s 3D rendered CGI style with subsurface scattering and soft ambient occlusion. ` +
               `The entire image — background, environment, AND all characters — must look like it belongs in the world of "${theme}". ` +
               `Match the original art direction as faithfully as possible.`,
    },
  };
  const styleKey   = (typeof bgStyle === 'string' && BG_STYLES[bgStyle]) ? bgStyle : 'kids';
  const styleData  = BG_STYLES[styleKey];

  console.log(`[SpotChar] Model: FREE (Gemini Flash Image) | Style: ${styleKey}`);

    // ── Step 1: Generate landscape scene ──────────────────────────────────────
  // Style description comes FIRST (highest token weight) so the model commits
  // to the art style before reading any scene content.
  // A style-aware quality closer at the end prevents illustration language from
  // overriding photorealistic or other non-cartoon styles.
  const styleQuality = {
    realistic:  'CRITICAL: The ENTIRE image — background AND all characters — must be STRICTLY PHOTOREALISTIC. No cartoons, no illustrations, no anime. Everything must look like a real photograph or cinematic 3D render.',
    stylistic:  'Bold graphic design aesthetic throughout — intentional composition, curated colour palette, expressive silhouettes. No cartoons.',
    comic:      'Classic comic-book art throughout — bold ink outlines, halftone shading, flat primary colours. No photorealism, no soft gradients.',
    wally:      'Dense hand-drawn crowd illustration style throughout — hundreds of tiny characters, bold flat colours, packed with meticulous detail.',
    kids:       "Warm children's picture-book illustration throughout — soft rounded characters, pastel palette, colourful, crowded, joyful and inviting.",
    scene:      `The ENTIRE image must faithfully replicate the art style of "${scene}". Every element — background, characters, props — should look like it was drawn/rendered by the original artists of "${scene}".`,
    character:  `The ENTIRE image must faithfully replicate the art style of "${theme}"\'s original media. Every element — background, characters, props — should look like it was drawn/rendered by the original artists of "${theme}".`,
  }[styleKey] || 'High detail, colourful, crowded, joyful.';

  const imagePrompt =
    // ① Full style description FIRST so model commits to it immediately
    `${styleData.suffix}\n` +
    `${styleData.prefix}` +
    // ② Orientation
    `HORIZONTAL WIDESCREEN LANDSCAPE IMAGE ONLY — 16:9 aspect ratio like a cinema screen. ` +
    `DO NOT generate a portrait or square image under any circumstances. ` +
    // ③ Scene content
    `Draw an original, richly detailed background scene set in the world of "${scene}". ` +
    `Fill this scene with ${bgCount} unique original characters whose visual design fits the world of "${scene}" — ` +
    `each clearly different from one another, no two alike. ` +
    `ABSOLUTE RULE: NONE of these ${bgCount} background characters may look like, resemble, or be confused with "${theme}". ` +
    `Background characters must be COMPLETELY DIFFERENT species/types/shapes from "${theme}" — ` +
    `for example if "${theme}" is a butterfly, do NOT draw ANY other butterflies, moths, or winged insects anywhere in the scene. ` +
    `CRITICALLY IMPORTANT: draw EXACTLY ${findN} — and ABSOLUTELY NO MORE THAN ${findN} — CHARACTER(S) inspired by "${theme}". ` +
    `COUNT CAREFULLY: the total number of "${theme}"-like characters in the ENTIRE image must be PRECISELY ${findN}. ` +
    `If you draw even one extra, the image is WRONG. Do NOT sneak extra "${theme}" characters into the background, edges, or sky.\n` +
    // ④ Creative placement — spread apart but artistically varied
    `PLACEMENT — be CREATIVE and VARIED with where you place the "${theme}" characters:\n` +
    `- Spread them across DIFFERENT regions of the image (left/centre/right AND foreground/mid-ground/background)\n` +
    `- Use DIFFERENT DEPTHS: one could be small and far away, another large and close, another at mid-distance\n` +
    `- Use INTERESTING POSES: sitting, climbing, peeking from behind something, riding, hanging, looking out a window, on a rooftop, in a tree, on a vehicle, etc.\n` +
    `- INTEGRATE them into the scene naturally — they should be DOING something, not just standing stiffly\n` +
    `- Place them at VARIED heights: street level, elevated (balcony, roof, tree), or below (basement, water, hole)\n` +
    `- Make each one a mini visual discovery — a child should feel clever for spotting them\n` +
    `- Keep at least 20% of the image width between any two "${theme}" characters\n` +
    `- Keep the top-left corner (15%) free (reserved for UI)\n` +
    `KEY RULES for each "${theme}" character:\n` +
    `- Must be clearly recognisable to a 9-year-old child\n` +
    `- Must be ENTIRELY inside the image — no body parts cropped by the frame edge\n` +
    `- Must stand out from generic "${scene}" background characters in colour or shape\n` +
    `- Must NOT be fully hidden behind objects (partially peeking is fine)\n` +
    `No text, no labels, no watermarks.\n` +
    // ⑤ Request character positions as JSON
    `After generating the image, output a JSON array describing where you placed each "${theme}" character. ` +
    `Use the format: [{"box_2d":[ymin, xmin, ymax, xmax], "label":"${theme}"}] ` +
    `where each value is an integer from 0 to 1000 (0 = top/left edge, 1000 = bottom/right edge). ` +
    `The box should tightly enclose each character from head to feet.\n` +
    // ⑤ Style-aware quality closer repeated at end for reinforcement
    `${styleQuality}`;

  console.log(`[SpotChar] Generating: ${findN}x "${theme}"-style in "${scene}"-style + ${bgCount} bg chars (style: ${styleKey})`);

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

  let imageBase64 = null, mimeType = 'image/png', bboxes = [], aiSource = 'generation';
  try {
    {
      // ── Gemini 3.1 Flash Image 🍌 — /generateContent endpoint ──────────
      const imgResp = await fetch(GEMINI_IMAGE_GEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            ...(inlineTargetImage ? [inlineTargetImage] : []),
            { text: imagePrompt }
          ] }],
          generationConfig: {
            responseModalities: ['IMAGE', 'TEXT'],
            imageConfig: {
              aspectRatio: '16:9',
            },
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

      // ── Extract character bboxes from the generation model's text output ──
      // The generation model was asked to report positions as JSON alongside the image.
      // It KNOWS where it placed characters, so its positions are more reliable than
      // a separate vision model guessing. We just need to handle code fences properly.
      const genTextPart = parts.find(p => p.text);
      if (genTextPart?.text) {
        console.log(`[SpotChar] Generation text: ${genTextPart.text.slice(0, 400)}`);
        // Strip markdown code fences (```json ... ```)
        const cleanGenText = genTextPart.text.replace(/```(?:json)?\s*/gi, '').trim();
        const genArrMatch = cleanGenText.match(/\[[\s\S]*\]/);
        if (genArrMatch) {
          try {
            const genParsed = JSON.parse(genArrMatch[0]);
            console.log(`[SpotChar] Parsed ${genParsed.length} bbox(es) from generation text`);
            const MARGIN = 0.12;
            const genBboxes = genParsed
              .filter(b => Array.isArray(b.box_2d) && b.box_2d.length >= 4)
              .map(b => {
                const [ymin, xmin, ymax, xmax] = b.box_2d;
                console.log(`[SpotChar]   gen box_2d: [${ymin}, ${xmin}, ${ymax}, ${xmax}]`);
                const x = xmin / 1000, y = ymin / 1000;
                const w = Math.max(0.05, Math.min(0.45, (xmax - xmin) / 1000));
                const h = Math.max(0.05, Math.min(0.45, (ymax - ymin) / 1000));
                let cx = x + w / 2, cy = y + h / 2;
                cx = Math.max(MARGIN, Math.min(1 - MARGIN, cx));
                cy = Math.max(MARGIN, Math.min(1 - MARGIN, cy));
                const fx = Math.max(0.01, Math.min(1 - w - 0.01, cx - w / 2));
                const fy = Math.max(0.01, Math.min(1 - h - 0.01, cy - h / 2));
                return { x: fx, y: fy, w, h, confidence: 1.0 };
              })
              .slice(0, findN);
            if (genBboxes.length > 0) {
              bboxes = genBboxes;
              console.log(`[SpotChar] ✅ Using ${bboxes.length} bbox(es) from generation model:`, JSON.stringify(bboxes));
            }
          } catch (e) {
            console.warn(`[SpotChar] Failed to parse generation bbox JSON:`, e.message);
          }
        }
      }
    }
  } catch (err) {
    return res.status(502).json({ error: `Image generation failed: ${err.message}` });
  }

  // ── Step 2: Vision fallback — only if generation didn't provide bboxes ────
  if (bboxes.length > 0) {
    console.log(`[SpotChar] Skipping vision step — ${bboxes.length} bbox(es) from generation model`);
  } else {
    aiSource = 'vision';

  // Helper: run a single vision detection pass and return parsed bboxes
  async function _visionPass(prompt, passLabel) {
    const vResp = await fetch(GEMINI_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          ...(inlineTargetImage ? [
            { text: "CRITICAL INSTRUCTION: I have provided a reference image for the exact character you need to find. Study the reference image carefully. You must ONLY identify characters in the scene that physically look like the character in the reference image (matching colors, clothing, body shape, species)." },
            inlineTargetImage
          ] : []),
          { text: prompt },
        ]}],
        generationConfig: { thinkingConfig: { thinkingBudget: 2048 }, maxOutputTokens: 8192 },
      }),
    });
    const vData = await vResp.json();
    if (!vResp.ok) {
      console.warn(`[SpotChar] ${passLabel} API error: ${vResp.status}`);
      return [];
    }
    const allParts = vData?.candidates?.[0]?.content?.parts || [];
    const rawText = allParts.filter(p => p.text && !p.thought).map(p => p.text).join('');
    console.log(`[SpotChar] ${passLabel} raw (${rawText.length} chars): ${rawText.slice(0, 400)}`);
    let cleanText = rawText.replace(/```(?:json)?\s*/gi, '').trim();

    // Try to extract JSON array
    const arrMatch = cleanText.match(/\[[\s\S]*\]/);
    let jsonStr = arrMatch ? arrMatch[0] : null;

    // If no complete array found, try to repair truncated JSON
    // (e.g. `[{"box_2d":[1,2,3,4],"label":"x"},{"box_2d":[5,6,7` → close it)
    if (!jsonStr && cleanText.includes('[')) {
      let partial = cleanText.slice(cleanText.indexOf('['));
      // Remove the last incomplete object entry
      const lastComplete = partial.lastIndexOf('},');
      if (lastComplete > 0) {
        jsonStr = partial.slice(0, lastComplete + 1) + ']';
        console.log(`[SpotChar] ${passLabel}: repaired truncated JSON`);
      } else {
        const lastObj = partial.lastIndexOf('}');
        if (lastObj > 0) {
          jsonStr = partial.slice(0, lastObj + 1) + ']';
          console.log(`[SpotChar] ${passLabel}: repaired truncated JSON (single obj)`);
        }
      }
    }

    if (!jsonStr) { console.warn(`[SpotChar] ${passLabel}: no JSON array found`); return []; }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.warn(`[SpotChar] ${passLabel}: JSON parse failed after repair: ${e.message}`);
      return [];
    }

    const MARGIN = 0.12;
    const CONFIDENCE_MIN = 0.70;
    return parsed
      .filter(b => {
        if (!Array.isArray(b.box_2d) || b.box_2d.length < 4) return false;
        // Filter by confidence — reject uncertain detections
        if (typeof b.confidence === 'number' && b.confidence < CONFIDENCE_MIN) {
          console.log(`[SpotChar]   ${passLabel} REJECTED (conf=${b.confidence}): "${b.description || '?'}"`);
          return false;
        }
        return true;
      })
      .map(b => {
        const [ymin, xmin, ymax, xmax] = b.box_2d;
        console.log(`[SpotChar]   ${passLabel} box_2d: [${ymin}, ${xmin}, ${ymax}, ${xmax}] conf=${b.confidence} desc="${(b.description || '').slice(0, 60)}"`);
        let x = xmin/1000, y = ymin/1000;
        let w = Math.max(0.05, Math.min(0.45, (xmax-xmin)/1000));
        let h = Math.max(0.05, Math.min(0.45, (ymax-ymin)/1000));
        let cx = Math.max(MARGIN, Math.min(1-MARGIN, x + w/2));
        let cy = Math.max(MARGIN, Math.min(1-MARGIN, y + h/2));
        x = Math.max(0.01, Math.min(1-w-0.01, cx - w/2));
        y = Math.max(0.01, Math.min(1-h-0.01, cy - h/2));
        return { x, y, w, h, confidence: b.confidence };
      })
      .filter(b => {
        const cx = b.x + b.w/2, cy = b.y + b.h/2;
        return cx >= MARGIN && cx <= 1-MARGIN && cy >= MARGIN && cy <= 1-MARGIN;
      });
  }

  try {
    // ── Pass 1: Find characters WITHOUT a target count ──
    // Key insight: telling the model "find exactly N" causes it to hallucinate
    // to meet the quota. Instead, ask it to find ALL matching characters
    // and describe what it sees. Then we verify the descriptions.
    const visualHint = (theme !== rawTheme)
      ? `\nVISUAL DESCRIPTION of what these characters look like: "${theme}"\n` +
        `Use this description to identify the target characters.\n`
      : '';
    console.log(`[SpotChar] Vision Pass 1: locating "${rawTheme}"${visualHint ? ' (with visual hint)' : ''}…`);
    const pass1Prompt =
      `Look carefully at this image. It is a "Spot the Character" game scene.\n` +
      `Some characters in this image are inspired by "${rawTheme}".\n` +
      visualHint +
      (inlineTargetImage ? `\nA REFERENCE IMAGE is provided above. Find ONLY the characters in the scene that match the provided reference image. Do not guess.\n` : '') +
      `Find ONLY the characters that CLEARLY match "${rawTheme}". ` +
      `Do NOT guess or force matches — if you're not sure, leave it out.\n\n` +
      `For each match, return:\n` +
      `- "box_2d": [ymin, xmin, ymax, xmax] (integers 0–1000)\n` +
      `- "description": briefly describe what this character looks like (clothes, hair, features)\n` +
      `- "confidence": 0.0 to 1.0 — how confident you are this is a "${rawTheme}" character\n\n` +
      `Only include detections with confidence >= 0.7.\n` +
      `If you cannot find ANY matching characters, return an empty array: []\n\n` +
      `Return ONLY a JSON array, no markdown, no code fences:\n` +
      `[{"box_2d":[ymin,xmin,ymax,xmax],"label":"${rawTheme}","description":"...","confidence":0.9}]`;

    let pass1 = await _visionPass(pass1Prompt, 'Pass1');
    pass1 = _removeOverlapping(pass1, findN);
    console.log(`[SpotChar] Pass 1 found ${pass1.length}/${findN} bbox(es)`);

    if (pass1.length >= findN) {
      bboxes = pass1.slice(0, findN);
    } else {
      // ── Pass 2: Appearance-based retry ──
      // Find characters that look most similar to each other (same outfit/species)
      console.log(`[SpotChar] Vision Pass 2: appearance-based retry…`);
      const pass2Prompt =
        `This image is a "Spot the Character" game.\n\n` +
        `TASK: Find all characters that look like they DON'T BELONG in this scene — ` +
        `characters that are visually different from the crowd, possibly from a different franchise or world.\n` +
        `They may share similar outfits, colors, or species with each other but look different from everyone else.\n\n` +
        (visualHint ? `They are inspired by "${rawTheme}": ${theme}\n\n` : '') +
        (inlineTargetImage ? `\nA REFERENCE IMAGE is provided above. Find ONLY the characters in the scene that match the provided reference image. Do not guess.\n` : '') +
        `For each match, return:\n` +
        `- "box_2d": [ymin, xmin, ymax, xmax] (integers 0–1000)\n` +
        `- "description": briefly describe what this character looks like\n` +
        `- "confidence": 0.0 to 1.0\n\n` +
        `Only include detections with confidence >= 0.7.\n` +
        `If you find NOTHING that clearly stands out, return []\n\n` +
        `Return ONLY a JSON array, no markdown, no code fences:\n` +
        `[{"box_2d":[ymin,xmin,ymax,xmax],"label":"${rawTheme}","description":"...","confidence":0.9}]`;

      let pass2 = await _visionPass(pass2Prompt, 'Pass2');
      pass2 = _removeOverlapping(pass2, findN);
      console.log(`[SpotChar] Pass 2 found ${pass2.length}/${findN} bbox(es)`);

      // Use whichever pass found more (up to findN)
      const best = pass2.length > pass1.length ? pass2 : pass1;
      bboxes = best.slice(0, findN);
    }

    console.log(`[SpotChar] ✅ Final vision result: ${bboxes.length}/${findN} bbox(es):`, JSON.stringify(bboxes));
  } catch (err) {
    console.warn('[SpotChar] Vision bbox failed (non-fatal):', err.message);
  }
  } // end vision fallback else

  // Remove overlapping bboxes
  if (bboxes.length > 1) {
    bboxes = _removeOverlapping(bboxes, findN);
  }

  // Reduce findCount to actual detected count — no fake positions
  let aiHard = false;
  if (bboxes.length < findN) {
    if (bboxes.length === 0) {
      console.warn(`[SpotChar] ⚠️ No characters located by AI — game continues without hints`);
      aiHard = true;
    } else {
      console.log(`[SpotChar] ⚠️ Reducing findCount from ${findN} to ${bboxes.length}`);
    }
    findN = bboxes.length;
  }

  res.json({ imageData: imageBase64, mimeType, bboxes, theme: rawTheme, findCount: findN, aiHard, aiSource });
});

// ── YouTube Meta Endpoint for Video Previews ──────────────────────────────────
app.get('/api/youtube-meta', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const r = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

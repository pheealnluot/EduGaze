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

// Parse JSON request bodies (needed for the Gemini proxy)
app.use(express.json({ limit: '64kb' }));

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

// Route everything else directly to the SPA entry point
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
   console.log(`Education App Production Server is actively bound and listening on port ${port}`);
   console.log(`Open http://localhost:${port} to verify deployments locally before hoisting to Cloud Run / Render / AWS!`);
});

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
   maxAge: 0, // Disable caching for development
   etag: true
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
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('[Gemini proxy error]', err.message);
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

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const geminiApiKey  = defineSecret('GEMINI_API_KEY');
const pixabayApiKey = defineSecret('PIXABAY_API_KEY');

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

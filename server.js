import express from 'express';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Route everything else directly to the SPA entry point
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
   console.log(`Education App Production Server is actively bound and listening on port ${port}`);
   console.log(`Open http://localhost:${port} to verify deployments locally before hoisting to Cloud Run / Render / AWS!`);
});

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    const contentType = response.headers.get('content-type') || 'text/html';
    let body = await response.text();

    // Rewrite relative URLs to go through our proxy
    const baseUrl = new URL(targetUrl);
    const origin = baseUrl.origin;
    const dir = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

    // Rewrite href, src, action attributes
    body = body.replace(/href=["'](\/[^"']*)["']/g, (m, p1) => {
      return `href="/proxy?url=${encodeURIComponent(origin + p1)}"`;
    });
    body = body.replace(/href=["']([^"'\/:]+\/[^"']*)["']/g, (m, p1) => {
      return `href="/proxy?url=${encodeURIComponent(dir + p1)}"`;
    });
    body = body.replace(/href=["'](https?:\/\/[^"']*)["']/g, (m, p1) => {
      return `href="/proxy?url=${encodeURIComponent(p1)}"`;
    });

    body = body.replace(/src=["'](\/[^"']*)["']/g, (m, p1) => {
      return `src="/proxy?url=${encodeURIComponent(origin + p1)}"`;
    });
    body = body.replace(/src=["']([^"'\/:]+\/[^"']*)["']/g, (m, p1) => {
      return `src="/proxy?url=${encodeURIComponent(dir + p1)}"`;
    });
    body = body.replace(/src=["'](https?:\/\/[^"']*)["']/g, (m, p1) => {
      return `src="/proxy?url=${encodeURIComponent(p1)}"`;
    });

    body = body.replace(/action=["'](\/[^"']*)["']/g, (m, p1) => {
      return `action="/proxy?url=${encodeURIComponent(origin + p1)}"`;
    });
    body = body.replace(/action=["'](https?:\/\/[^"']*)["']/g, (m, p1) => {
      return `action="/proxy?url=${encodeURIComponent(p1)}"`;
    });

    // Inject a base tag to handle remaining relative URLs
    body = body.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}/">`);

    // Inject a style to make it look ok
    body = body.replace('</head>', '<style>body{background:#fff !important}</style></head>');

    res.setHeader('Content-Type', contentType);
    res.send(body);
  } catch (err) {
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`💎 Crystal proxy running at http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT}/planet-crystal.html`);
});

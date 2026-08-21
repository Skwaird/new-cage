const dns = require('dns').promises;
const net = require('net');

const REQUEST_TIMEOUT_MS = 8000; // keep well under Vercel's default function timeout

// ---------------------------------------------------------------------------
// SSRF protection
//
// The whole point of this proxy is "fetch whatever URL the client gives us",
// which means without checks a client could point it at internal services
// (localhost, other machines on the network, cloud metadata endpoints like
// 169.254.169.254, etc). We resolve the hostname and reject anything that
// lands on a private/reserved address, and only allow http/https.
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fe80:')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
    if (lower.startsWith('::ffff:')) {
      const embedded = lower.split(':').pop();
      if (net.isIPv4(embedded)) return isPrivateOrReservedIp(embedded);
    }
    return false;
  }
  return true; // unrecognized format - block to be safe
}

async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('Requests to this host are not allowed');
  }
  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new Error('Requests to private/internal addresses are not allowed');
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve host');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error('Requests to private/internal addresses are not allowed');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// URL / HTML / CSS rewriting helpers
// ---------------------------------------------------------------------------

function toProxyUrl(rawValue, base) {
  if (!rawValue) return rawValue;
  const trimmed = rawValue.trim();
  if (/^(javascript:|data:|mailto:|tel:|#)/i.test(trimmed)) return rawValue;
  try {
    const abs = new URL(trimmed, base).toString();
    return `/proxy?url=${encodeURIComponent(abs)}`;
  } catch {
    return rawValue;
  }
}

function rewriteCssUrls(css, base) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, value) => {
    if (!value || /^(data:|#)/i.test(value.trim())) return match;
    return `url(${quote}${toProxyUrl(value, base)}${quote})`;
  });
}

function rewriteHtml(html, base) {
  // href / src / action attributes
  html = html.replace(/\b(href|src|action)=(["'])(.*?)\2/gi, (match, attr, quote, value) => {
    return `${attr}=${quote}${toProxyUrl(value, base)}${quote}`;
  });

  // srcset (comma-separated "url descriptor" pairs)
  html = html.replace(/\bsrcset=(["'])(.*?)\1/gi, (match, quote, value) => {
    const rewritten = value
      .split(',')
      .map((part) => {
        const trimmedPart = part.trim();
        if (!trimmedPart) return '';
        const [url, descriptor] = trimmedPart.split(/\s+/, 2);
        return descriptor ? `${toProxyUrl(url, base)} ${descriptor}` : toProxyUrl(url, base);
      })
      .filter(Boolean)
      .join(', ');
    return `srcset=${quote}${rewritten}${quote}`;
  });

  // inline <style>...</style> blocks
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, css) => {
    return `<style${attrs}>${rewriteCssUrls(css, base)}</style>`;
  });

  const origin = new URL(base).origin;

  // Base tag so any remaining relative URL we didn't catch still resolves
  // sensibly, and a style reset to keep proxied pages readable.
  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${origin}/">`);
  html = html.replace(/<\/head>/i, '<style>body{background:#fff !important}</style></head>');

  return html;
}

// ---------------------------------------------------------------------------
// Request handler
//
// Written against the Express-compatible subset of req/res (req.query,
// req.method, req.headers, req.body, res.status().setHeader().send()) so the
// exact same function works unmodified as an Express route handler (server.js)
// and as a Vercel serverless function (api/proxy.js) - Vercel's Node runtime
// provides the same shape.
// ---------------------------------------------------------------------------

async function runProxy(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  let safeUrl;
  try {
    safeUrl = await assertSafeUrl(targetUrl);
  } catch (err) {
    return res.status(400).send(`Proxy error: ${err.message}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fetchOptions = {
      method: req.method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const reqContentType = req.headers['content-type'] || '';
      if (reqContentType.includes('application/json')) {
        fetchOptions.headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(req.body || {});
      } else if (reqContentType.includes('application/x-www-form-urlencoded')) {
        fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = new URLSearchParams(req.body || {}).toString();
      }
    }

    const response = await fetch(safeUrl.toString(), fetchOptions);
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const isHtml = contentType.includes('text/html');
    const isCss = contentType.includes('text/css');
    const isTextLike =
      isHtml ||
      isCss ||
      /^(text\/|application\/(json|javascript|x-javascript|ecmascript|xml|xhtml\+xml))/i.test(contentType) ||
      contentType.includes('svg');

    // Use the final URL after any redirects as the base for relative links.
    const base = response.url || safeUrl.toString();

    res.status(response.status);

    if (!isTextLike) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      return res.send(buffer);
    }

    let body = await response.text();
    if (isHtml) {
      body = rewriteHtml(body, base);
    } else if (isCss) {
      body = rewriteCssUrls(body, base);
    }

    res.setHeader('Content-Type', contentType);
    res.send(body);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).send('Proxy error: request timed out');
    }
    res.status(500).send(`Proxy error: ${err.message}`);
  }
}

module.exports = { runProxy, assertSafeUrl, rewriteHtml, rewriteCssUrls };
/**
 * Security headers on every response and CORS limited to the portal's address (PRO-194).
 *
 * Written by hand instead of helmet: the policy is short and fits this portal exactly.
 * - CSP: scripts only from the portal itself, plus the inline scripts of index.html, allowed by their
 *   hash (computed from the built file, so a rebuild needs no change here). Styles allow 'unsafe-inline'
 *   because Angular injects component styles at runtime; fonts come from Google Fonts.
 * - HSTS only when the portal is served over HTTPS (PUBLIC_URL), so localhost keeps working.
 */
const crypto = require('crypto');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

/**
 * sha256 of each inline <script> of the page, in CSP format. The browser's HTML parser turns CRLF
 * (and a lone CR) into LF before hashing, so the file is normalized the same way first.
 */
function inlineScriptHashes(html) {
  const text = String(html || '').replace(/\r\n?/g, '\n');
  return [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`
  );
}

function contentSecurityPolicy(indexFile) {
  const html = indexFile && fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // Guides and descriptions (Markdown) may show images hosted anywhere over HTTPS.
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Middleware that sets the security headers. `indexFile`: the built index.html, for the script hashes. */
/** @param {{ indexFile?: string, publicUrl?: string }} [options] */
function securityHeaders({ indexFile, publicUrl = PUBLIC_URL } = {}) {
  const csp = contentSecurityPolicy(indexFile);
  const https = publicUrl.startsWith('https://');
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/**
 * Origins allowed to call the API from a browser: the portal (PUBLIC_URL), the Angular dev server
 * outside production, and any extra ones in CORS_ORIGINS (comma-separated).
 */
function allowedOrigins({ publicUrl = PUBLIC_URL, extra = process.env.CORS_ORIGINS, production = process.env.NODE_ENV === 'production' } = {}) {
  const origins = new Set([new URL(publicUrl).origin]);
  if (!production) origins.add('http://localhost:4200');
  for (const o of String(extra || '').split(',').map((s) => s.trim()).filter(Boolean)) origins.add(new URL(o).origin);
  return origins;
}

/** Options for the `cors` package: same-origin calls (no Origin header) pass; other origins get no CORS headers. */
function corsOptions(origins = allowedOrigins()) {
  // X-Request-Id: the portal in development (another origin) can read it too (PRO-208).
  return { origin: (origin, cb) => cb(null, !origin || origins.has(origin)), exposedHeaders: ['X-Request-Id'] };
}

module.exports = { securityHeaders, contentSecurityPolicy, inlineScriptHashes, allowedOrigins, corsOptions };

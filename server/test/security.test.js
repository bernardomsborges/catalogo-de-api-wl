// Security headers and CORS (PRO-194).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { allowedOrigins, contentSecurityPolicy, inlineScriptHashes } = require('../src/security');
const { startServer } = require('./helpers');

const INDEX = path.join(__dirname, '..', '..', 'web', 'dist', 'web', 'browser', 'index.html');

describe('rules', () => {
  test('inline scripts are allowed by their exact hash', () => {
    const html = '<script>var a = 1;</script><script src="main.js" type="module"></script><script type="x">b()</script>';
    const hash = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
    assert.deepEqual(inlineScriptHashes(html), [hash('var a = 1;'), hash('b()')]);
  });

  test('a file saved with CRLF gets the hash the browser computes (with LF)', () => {
    const hash = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
    assert.deepEqual(inlineScriptHashes('<script>\r\n  a();\r\n</script>'), [hash('\n  a();\n')]);
  });

  test('without the built portal the CSP still blocks inline scripts', () => {
    const csp = contentSecurityPolicy(path.join(__dirname, 'nao-existe.html'));
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
  });

  test('allowed origins: the portal, the dev server outside production and CORS_ORIGINS', () => {
    assert.deepEqual([...allowedOrigins({ publicUrl: 'https://apis.exemplo.gov.br/', extra: '', production: true })], ['https://apis.exemplo.gov.br']);
    assert.deepEqual([...allowedOrigins({ publicUrl: 'http://localhost:3000', extra: 'https://a.gov.br/x, https://b.gov.br', production: false })], [
      'http://localhost:3000',
      'http://localhost:4200',
      'https://a.gov.br',
      'https://b.gov.br',
    ]);
  });
});

describe('HTTP', () => {
  let server;
  before(async () => {
    server = await startServer({ env: { PUBLIC_URL: 'https://apis.exemplo.gov.br', NODE_ENV: 'production', ADMIN_PASSWORD: 'senha-do-admin-123' } });
  });
  after(() => server?.stop());

  test('every response carries the security headers', async () => {
    for (const url of ['/api/apis', '/api/nao-existe']) {
      const { headers } = await server.call('GET', url);
      // Express's own 404 page sends an even stricter CSP ("default-src 'none'").
      assert.match(headers.get('content-security-policy'), /default-src '(self|none)'/, url);
      assert.equal(headers.get('x-content-type-options'), 'nosniff');
      assert.equal(headers.get('x-frame-options'), 'DENY');
      assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
      assert.equal(headers.get('x-powered-by'), null);
    }
  });

  test('CORS answers the portal and ignores other sites', async () => {
    const ok = await server.call('GET', '/api/apis', { headers: { origin: 'https://apis.exemplo.gov.br' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://apis.exemplo.gov.br');
    const other = await server.call('GET', '/api/apis', { headers: { origin: 'https://site-qualquer.com' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const dev = await server.call('GET', '/api/apis', { headers: { origin: 'http://localhost:4200' } });
    assert.equal(dev.headers.get('access-control-allow-origin'), null, 'em produção, o localhost:4200 não entra');
  });

  test('the CSP allows every inline script of the built portal', { skip: !fs.existsSync(INDEX) && 'rode o build do portal antes' }, async () => {
    const page = await server.call('GET', '/');
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    // Hashed the way the browser does: after its HTML parser turns CRLF into LF.
    const html = page.text.replace(/\r\n?/g, '\n');
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    assert.ok(scripts.length > 0);
    for (const s of scripts) {
      const hash = `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
      assert.ok(csp.includes(hash), `script sem hash na CSP: ${s.slice(0, 80)}`);
    }
    // The fonts the page asks for are allowed.
    if (page.text.includes('fonts.gstatic.com')) assert.match(csp, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
    // Every script and stylesheet of the page comes from the portal itself.
    for (const [, src] of page.text.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      if (/^https?:/.test(src)) assert.match(src, /^https:\/\/fonts\.(googleapis|gstatic)\.com/, src);
    }
  });
});

/**
 * Finds the OpenAPI document behind a documentation page (Swagger UI, Redoc, Scalar, Next.js
 * sites…), so the admin can paste the docs address instead of hunting for the .json.
 * Looks, in order: in the page itself (embedded JSON), in addresses the page or its config
 * scripts mention, and in the usual addresses (/openapi.json, /v3/api-docs…).
 * Fetching is up to the caller (`get`), which decides when the read credential goes along.
 */

const MAX_REQUESTS = 30;
const DEADLINE_MS = 60_000;

const stripBom = (t) => t.replace(/^﻿/, '');
const isHtml = (text, type = '') => /html/i.test(type) || /^\s*</.test(text);

/** A parsed object that is an OpenAPI 3 / Swagger 2 document. */
const isSpecObject = (o) =>
  !!o && typeof o === 'object' && !Array.isArray(o) && (typeof o.openapi === 'string' || typeof o.swagger === 'string') && !!o.paths && typeof o.paths === 'object';

/** The text is an OpenAPI/Swagger document (JSON or YAML). */
function looksLikeSpec(text) {
  const t = stripBom(String(text || '')).trim();
  if (!t || t.startsWith('<')) return false;
  if (t.startsWith('{')) {
    try {
      return isSpecObject(JSON.parse(t));
    } catch {
      return false;
    }
  }
  return /^["']?(openapi|swagger)["']?\s*:/m.test(t) && /^["']?paths["']?\s*:/m.test(t);
}

/** Every OpenAPI document inside a parsed value (e.g. Next.js page data or Redoc state). */
function specsIn(value, out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 14) return out;
  if (isSpecObject(value)) {
    out.push(value);
    return out;
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) specsIn(v, out, depth + 1);
  return out;
}

/** JSON values inside <script> tags: whole JSON scripts and `x = {...}` assignments. */
function scriptJson(html) {
  const values = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1].trim();
    if (!body || !/(openapi|swagger)/i.test(body)) continue;
    const tries = [];
    if (/^[[{]/.test(body)) tries.push(body);
    for (const a of body.matchAll(/=\s*(?=\{)/g)) {
      const start = a.index + a[0].length;
      const end = body.lastIndexOf('}');
      if (end > start) tries.push(body.slice(start, end + 1));
    }
    for (const t of tries) {
      try {
        values.push(JSON.parse(t));
        break;
      } catch {
        /* not plain JSON */
      }
    }
  }
  return values;
}

/** The document embedded in the page, if any (the one with the most routes). */
function embeddedSpec(html) {
  const specs = scriptJson(html).flatMap((v) => specsIn(v));
  if (!specs.length) return null;
  return specs.sort((a, b) => Object.keys(b.paths).length - Object.keys(a.paths).length)[0];
}

const ASSET = /\.(js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|html?)(\?|#|$)/i;

/** Addresses the page (or a config script) points to as the document. Most likely first. */
function linkedUrls(text, base) {
  const found = [];
  const add = (raw) => {
    const s = String(raw || '').trim().replace(/&amp;/g, '&');
    if (!s || s.startsWith('#') || /^(data|javascript|mailto):/i.test(s) || /\$\{|\{\{/.test(s)) return;
    try {
      const u = new URL(s, base);
      if (/^https?:$/.test(u.protocol) && !ASSET.test(u.pathname)) found.push(u.href);
    } catch {
      /* not an address */
    }
  };
  // <redoc spec-url>, Scalar data-url, <rapi-doc spec-url>, <elements-api apiDescriptionUrl>…
  for (const m of text.matchAll(/\b(?:spec-url|data-spec-url|data-url|apiDescriptionUrl|specurl)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  // Redoc.init('…'), SwaggerUIBundle({ url: '…' }), urls: [{ url: '…' }], configUrl
  for (const m of text.matchAll(/Redoc\.init\(\s*["'`]([^"'`]+)["'`]/g)) add(m[1]);
  for (const m of text.matchAll(/["']?\b(?:url|configUrl|specUrl|spec)["']?\s*:\s*["'`]([^"'`\s]+)["'`]/g)) add(m[1]);
  // Any quoted address that looks like a spec file.
  for (const m of text.matchAll(/["'`]([^"'`\s<>]*(?:openapi|swagger|api-docs|spec)[^"'`\s<>]*)["'`]/gi)) {
    if (/\.(json|ya?ml)(\?|$)/i.test(m[1]) || /api-docs/i.test(m[1])) add(m[1]);
  }
  // Full addresses in the middle of code (e.g. a list of hosts and their documents).
  for (const m of text.matchAll(/https?:\/\/[^\s"'`,;<>()]+/g)) {
    if (/(openapi|swagger|api-docs)/i.test(m[0]) && (/\.(json|ya?ml)(\?|$)/i.test(m[0]) || /api-docs/i.test(m[0]))) add(m[0]);
  }
  // The same site as the docs page first: that is usually the document it shows.
  const origin = new URL(base).origin;
  const unique = [...new Set(found)];
  return [...unique.filter((u) => new URL(u).origin === origin), ...unique.filter((u) => new URL(u).origin !== origin)];
}

/** Small config scripts that hold the document address (Swagger UI's swagger-initializer.js…). */
function configScripts(html, base) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    if (!/(initializer|swagger-config|config|init)[^/]*\.js(\?|$)/i.test(m[1])) continue;
    try {
      out.push(new URL(m[1], base).href);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(out)].slice(0, 3);
}

const COMMON = [
  'openapi.json', 'openapi.yaml', 'swagger.json', 'swagger.yaml', 'v3/api-docs', 'v2/api-docs', 'api-docs',
  'swagger/v1/swagger.json', 'swagger/doc.json', 'api/openapi.json', 'api/swagger.json', 'docs/openapi.json',
  'openapi', 'api-docs/swagger.json',
];

/** Usual addresses, next to the docs page first, then at the root of the site. */
function commonUrls(pageUrl) {
  const page = new URL(pageUrl);
  const dir = new URL(page.pathname.endsWith('/') ? page.pathname : page.pathname.replace(/[^/]*$/, ''), page.origin);
  const here = page.pathname.replace(/\/+$/, '') + '/';
  const urls = [];
  for (const p of COMMON) {
    urls.push(new URL(p, new URL(here, page.origin)).href, new URL(p, dir).href, new URL('/' + p, page.origin).href);
  }
  return [...new Set(urls)].filter((u) => u !== page.href);
}

/** springdoc / Swagger UI config JSON ({ url } or { urls: [{ url }] }): the addresses it names. */
function configJsonUrls(text, base) {
  try {
    const d = JSON.parse(stripBom(text));
    const list = [d?.url, ...(Array.isArray(d?.urls) ? d.urls.map((x) => x?.url) : [])].filter((x) => typeof x === 'string');
    return list.map((u) => new URL(u, base).href);
  } catch {
    return [];
  }
}

/**
 * `page`: { url, text, contentType } of the address the admin gave.
 * `get(url)`: resolves { ok, status, text, contentType, url } (rejects on network errors).
 * Returns { text, source, how: 'embedded' | 'linked' | 'common' } or { tried: [urls] }.
 */
async function discover(page, get) {
  const deadline = Date.now() + DEADLINE_MS;
  const tried = new Set([page.url]);
  let requests = 0;

  if (isHtml(page.text, page.contentType)) {
    const spec = embeddedSpec(page.text);
    if (spec) return { text: JSON.stringify(spec, null, 2), source: page.url, how: 'embedded' };
  }

  const queue = [];
  const push = (urls, how) => urls.forEach((u) => !tried.has(u) && !queue.some((q) => q.url === u) && queue.push({ url: u, how }));

  const linked = [...configJsonUrls(page.text, page.url), ...linkedUrls(page.text, page.url)];
  push(linked, 'linked');
  if (isHtml(page.text, page.contentType)) {
    for (const src of configScripts(page.text, page.url)) {
      if (requests >= MAX_REQUESTS || Date.now() > deadline) break;
      tried.add(src);
      requests++;
      const js = await get(src).catch(() => null);
      if (js?.ok) push(linkedUrls(js.text, src), 'linked');
    }
  }
  push(commonUrls(page.url), 'common');

  while (queue.length && requests < MAX_REQUESTS && Date.now() < deadline) {
    const { url, how } = queue.shift();
    tried.add(url);
    requests++;
    const r = await get(url).catch(() => null);
    if (!r?.ok) continue;
    if (looksLikeSpec(r.text)) return { text: r.text, source: r.url || url, how };
    // A config JSON or another docs page: follow what it points to (next to the front of the line).
    const next = configJsonUrls(r.text, url);
    if (isHtml(r.text, r.contentType)) {
      const spec = embeddedSpec(r.text);
      if (spec) return { text: JSON.stringify(spec, null, 2), source: url, how: 'embedded' };
      if (how === 'linked') next.push(...linkedUrls(r.text, url));
    }
    queue.unshift(...next.filter((u) => !tried.has(u)).map((u) => ({ url: u, how: 'linked' })));
  }
  return { tried: [...tried] };
}

module.exports = { discover, looksLikeSpec, isHtml };

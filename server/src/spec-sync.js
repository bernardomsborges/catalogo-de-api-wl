/**
 * Keeps each API's OpenAPI document in sync: fetches it from the configured URL (daily and on
 * demand) and stores the latest and the last applied versions. The admin page compares them and
 * applies the changes; this module only fetches and stores.
 *
 * The read credential stays on the server (database or file) and is never sent back to the browser.
 */
const path = require('path');
const crypto = require('crypto');
const auth = require('./outbound-auth');
const discovery = require('./spec-discovery');
const { docStore } = require('./db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const SYNC_FILE = process.env.SYNC_FILE || path.join(path.dirname(DATA_FILE), 'spec-sync.json');
const INTERVAL_HOURS = Number(process.env.SYNC_INTERVAL_HOURS) || 24;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 10 * 1024 * 1024;
/**
 * { [apiId]: { url, authType, headerName, paramName, username, tokenUrl, clientId, scope, secret,
 *   lastCheckedAt, lastError, latestHash, latestText, appliedHash, appliedText, appliedAt } }
 */
let entries = {};
const doc = docStore('spec-sync', SYNC_FILE, { mode: 0o600 });
const running = new Map();
const { authTypeOf, readAuth, bodyMessage, SECRET_LABEL } = auth;

async function init() {
  entries = await doc.load({});
}

function persist() {
  doc.save(entries);
}

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** What the browser may see: never the secret. */
function view(id, withTexts = false) {
  const e = entries[id];
  if (!e) return { configured: false, intervalHours: INTERVAL_HOURS };
  return {
    configured: true,
    intervalHours: INTERVAL_HOURS,
    url: e.url,
    ...auth.authView(e),
    lastCheckedAt: e.lastCheckedAt || null,
    lastError: e.lastError || '',
    latestHash: e.latestHash || null,
    appliedHash: e.appliedHash || null,
    appliedAt: e.appliedAt || null,
    pending: !!e.latestHash && e.latestHash !== e.appliedHash,
    ...(withTexts ? { latestText: e.latestText || null, appliedText: e.appliedText || null } : {}),
  };
}

/** Saves the URL and credential. An empty URL turns syncing off for the API. */
function configure(id, input = {}) {
  const url = String(input.url || '').trim();
  if (!url) {
    delete entries[id];
    persist();
    return { detail: view(id, true) };
  }
  if (!/^https?:\/\//i.test(url)) return { error: 'A URL da especificação deve começar com http:// ou https://.' };
  const prev = entries[id] || {};
  const next = { ...prev, url };
  const authError = auth.applyAuthSettings(prev, next, input);
  if (authError) return { error: authError };
  auth.forgetToken(id);
  if (prev.url !== url) {
    // Another document: forget the last fetch (the applied version stays as the merge base).
    delete next.latestText;
    delete next.latestHash;
    delete next.lastCheckedAt;
    next.lastError = '';
  }
  entries[id] = next;
  persist();
  return { detail: view(id, true) };
}

/**
 * One GET. With `withAuth`, the read credential goes along, and redirects are followed only on the
 * same origin, so the credential never reaches another host.
 */
async function request(id, e, rawUrl, withAuth, timeoutMs = TIMEOUT_MS) {
  const headers = { Accept: 'application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5' };
  const target = new URL(rawUrl);
  if (withAuth) await auth.authorize(id, e, headers, target);
  let url = target.href;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url);
      if (withAuth && next.origin !== new URL(url).origin) throw new Error(`A URL redirecionou para outro endereço (${next.origin}). Cadastre a URL final.`);
      url = next.href;
      continue;
    }
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('A especificação passa de 10 MB.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('A especificação passa de 10 MB.');
    return { ok: res.ok, status: res.status, text: buf.toString('utf8'), contentType: res.headers.get('content-type') || '', url };
  }
  throw new Error('Redirecionamentos demais.');
}

/**
 * The document at `e.url`. When the address is a documentation page (Swagger UI, Redoc, Next.js…),
 * looks for the document behind it. Returns { text, source, how }: `how` is 'direct', 'embedded',
 * 'linked' or 'common'.
 */
async function fetchSpec(id, e) {
  const start = new URL(e.url);
  start.hash = '';
  const res = await request(id, e, start.href, true);
  if (!res.ok) {
    const msg = bodyMessage(res.text);
    // A rejected OAuth token is fetched again on the next try.
    if (res.status === 401 && id) auth.forgetToken(id);
    const hint = res.status === 401 || res.status === 403 ? ' Confira a credencial de leitura.' : '';
    throw new Error(`A URL respondeu ${res.status}${msg ? `: ${msg}` : ''}.${hint}`);
  }
  const plain = !discovery.isHtml(res.text, res.contentType);
  if (discovery.looksLikeSpec(res.text) || (plain && /(openapi|swagger)/i.test(res.text.slice(0, 2000)) && /paths/.test(res.text))) {
    return { text: res.text, source: res.url, how: 'direct' };
  }
  // Same origin as the given address: with the credential. Elsewhere (a CDN, GitHub…): without it.
  const found = await discovery.discover(res, (u) => request(id, e, u, new URL(u).origin === start.origin, 10_000));
  if (found.text) return found;
  throw new Error(
    'Não encontrei uma especificação OpenAPI/Swagger neste endereço nem na página. ' +
      'Procurei no conteúdo da página, nos links que ela cita e nos endereços comuns (/openapi.json, /swagger.json, /v3/api-docs…). ' +
      'Abra a documentação com o F12, aba Rede, e procure um .json ou .yaml.'
  );
}

/** Fetches the document now. Concurrent calls for the same API share one request. */
function check(id) {
  if (!entries[id]) return Promise.resolve({ notConfigured: true });
  if (running.has(id)) return running.get(id);
  const job = (async () => {
    const e = entries[id];
    try {
      const { text } = await fetchSpec(id, e);
      if (!entries[id]) return { detail: view(id, true) };
      Object.assign(entries[id], { latestText: text, latestHash: hash(text), lastError: '' });
    } catch (err) {
      if (!entries[id]) return { detail: view(id, true) };
      const msg = err.name === 'TimeoutError' ? 'A URL demorou mais de 20 s para responder.' : err.cause?.code ? `Não foi possível conectar (${err.cause.code}).` : err.message;
      entries[id].lastError = msg;
    }
    entries[id].lastCheckedAt = new Date().toISOString();
    persist();
    return { detail: view(id, true) };
  })().finally(() => running.delete(id));
  running.set(id, job);
  return job;
}

/** Records that the admin applied the fetched version (it becomes the base of the next comparison). */
function markApplied(id, appliedHash) {
  const e = entries[id];
  if (!e) return { notConfigured: true };
  if (!e.latestHash || e.latestHash !== appliedHash) return { error: 'A especificação mudou desde que a página foi aberta. Sincronize de novo.' };
  Object.assign(e, { appliedText: e.latestText, appliedHash: e.latestHash, appliedAt: new Date().toISOString() });
  persist();
  return { detail: view(id, true) };
}

function remove(id) {
  auth.forgetToken(id);
  if (!entries[id]) return;
  delete entries[id];
  persist();
}

/** Short status of every configured API, for the admin list. */
function summary() {
  return Object.fromEntries(Object.keys(entries).map((id) => [id, view(id)]));
}

/** Checks the APIs whose last fetch is older than SYNC_INTERVAL_HOURS, one at a time. */
async function runDue() {
  const limit = Date.now() - INTERVAL_HOURS * 3600_000;
  for (const id of Object.keys(entries)) {
    const last = Date.parse(entries[id]?.lastCheckedAt || '') || 0;
    if (last < limit) await check(id);
  }
}

function start() {
  setTimeout(runDue, 30_000).unref();
  setInterval(runDue, 60 * 60_000).unref();
}

/**
 * One-off fetch for "Importar OpenAPI → Link" (nothing is saved). With `apiId`, an empty secret
 * falls back to the one stored for that API's sync, if the type and the host are the same.
 */
async function fetchOnce(input = {}, apiId) {
  const url = String(input.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { error: 'A URL da especificação deve começar com http:// ou https://.' };
  const settings = readAuth(input);
  if (settings.error) return { error: settings.error };
  let secret = typeof input.secret === 'string' ? input.secret.trim() : '';
  const stored = apiId && entries[apiId];
  if (!secret && stored?.secret && authTypeOf(stored) === settings.fields.authType && new URL(stored.url).origin === new URL(url).origin) {
    secret = stored.secret;
  }
  if (settings.fields.authType !== 'none' && !secret) return { error: `Informe ${SECRET_LABEL[settings.fields.authType]}.` };
  try {
    const { text, source, how } = await fetchSpec(null, { url, ...settings.fields, secret });
    return { text, source, how };
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'A URL demorou mais de 20 s para responder.' : err.cause?.code ? `Não foi possível conectar (${err.cause.code}).` : err.message };
  }
}

module.exports = { init, view, configure, check, markApplied, remove, summary, start, fetchOnce };

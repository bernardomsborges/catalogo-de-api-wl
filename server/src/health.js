/**
 * API health: calls each API's health route every HEALTH_INTERVAL_SECONDS (default 60) and keeps
 * the current status plus daily counters for the last 90 days.
 *
 * - up: answered 2xx/3xx in time.
 * - degraded ("instável"): slow (> HEALTH_SLOW_MS), answered 4xx (the check itself is rejected,
 *   e.g. wrong credential), or the first failure in a row.
 * - down: no answer or 5xx twice in a row.
 * APIs without a health route are "unmonitored", never "down".
 */
const path = require('path');
const auth = require('./outbound-auth');
const { docStore } = require('./db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const HEALTH_FILE = process.env.HEALTH_FILE || path.join(path.dirname(DATA_FILE), 'health.json');
const INTERVAL_S = Number(process.env.HEALTH_INTERVAL_SECONDS) || 60;
const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS) || 10_000;
const SLOW_MS = Number(process.env.HEALTH_SLOW_MS) || 3_000;
const KEEP_DAYS = 90;
const FAILURES_FOR_DOWN = 2;

/**
 * { [apiId]: { config: { baseUrl, path, ...auth settings, secret },
 *   current: { status, since, latencyMs, httpStatus, lastCheckedAt, lastError, failures },
 *   days: { 'YYYY-MM-DD': { checks, up, degraded, down, latencySum } },
 *   incidents: [{ start, end }] } }
 */
let state = {};
const doc = docStore('health', HEALTH_FILE, { pretty: false, mode: 0o600 });
const running = new Map();
/** Called on status changes: (apiId, previous, next). Set by the server (e-mail notices). */
/** @type {(apiId: string, previous: string, next: string, entry: any) => void} */
let onChange = () => {};

async function init() {
  state = await doc.load({});
}

let saveTimer = null;
/** Checks run every minute: write at most once per second. */
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    doc.save(state);
  }, 1000);
  saveTimer.unref?.();
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function prune(entry) {
  const limit = dayKey(new Date(Date.now() - KEEP_DAYS * 86400_000));
  for (const k of Object.keys(entry.days || {})) if (k < limit) delete entry.days[k];
  entry.incidents = (entry.incidents || []).filter((i) => !i.end || i.end.slice(0, 10) >= limit);
}

/** Saves the health route and credential. An empty path turns monitoring off (history is dropped). */
function configure(apiId, input = {}) {
  const routePath = String(input.path || '').trim();
  if (!routePath) {
    delete state[apiId];
    auth.forgetToken(`health:${apiId}`);
    persist();
    return { detail: adminView(apiId) };
  }
  if (!routePath.startsWith('/')) return { error: 'A rota de saúde deve começar com "/" (ex.: /health).' };
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) return { error: 'Escolha o ambiente (URL base) a verificar.' };
  const entry = state[apiId] || { days: {}, incidents: [] };
  const prev = entry.config || {};
  const next = { ...prev, baseUrl, path: routePath };
  const authError = auth.applyAuthSettings(prev, next, input);
  if (authError) return { error: authError };
  auth.forgetToken(`health:${apiId}`);
  entry.config = next;
  state[apiId] = entry;
  persist();
  return { detail: adminView(apiId) };
}

/** One call to the health route: { status, latencyMs, httpStatus, error }. */
async function probe(apiId, cfg) {
  const url = new URL(cfg.baseUrl + cfg.path);
  const headers = { Accept: 'application/json, */*' };
  const started = Date.now();
  try {
    await auth.authorize(`health:${apiId}`, cfg, headers, url);
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Date.now() - started;
    const text = res.status >= 400 ? await res.text().catch(() => '') : (await res.body?.cancel(), '');
    if (res.status >= 500) return { failed: true, latencyMs, httpStatus: res.status, error: `Respondeu ${res.status}${msgOf(text)}.` };
    if (res.status >= 400) {
      if (res.status === 401) auth.forgetToken(`health:${apiId}`);
      const hint = res.status === 401 || res.status === 403 ? ' Confira a credencial da verificação.' : '';
      return { status: 'degraded', latencyMs, httpStatus: res.status, error: `Respondeu ${res.status}${msgOf(text)}.${hint}` };
    }
    if (latencyMs > SLOW_MS) return { status: 'degraded', latencyMs, httpStatus: res.status, error: `Lenta: ${latencyMs} ms.` };
    return { status: 'up', latencyMs, httpStatus: res.status, error: '' };
  } catch (err) {
    const error =
      err.name === 'TimeoutError'
        ? `Sem resposta em ${Math.round(TIMEOUT_MS / 1000)} s.`
        : err.cause?.code
          ? `Não foi possível conectar (${err.cause.code}).`
          : err.message;
    return { failed: true, latencyMs: null, httpStatus: null, error };
  }
}

const msgOf = (text) => {
  const m = auth.bodyMessage(text);
  return m ? `: ${m.slice(0, 160)}` : '';
};

/** Runs the check now. Concurrent calls for the same API share one request. */
function check(apiId) {
  const entry = state[apiId];
  if (!entry?.config) return Promise.resolve(null);
  if (running.has(apiId)) return running.get(apiId);
  const job = (async () => {
    const r = await probe(apiId, entry.config);
    if (state[apiId] !== entry) return null; // turned off meanwhile
    const cur = entry.current || { failures: 0 };
    const failures = r.failed ? (cur.failures || 0) + 1 : 0;
    const status = r.failed ? (failures >= FAILURES_FOR_DOWN ? 'down' : 'degraded') : r.status;
    const now = new Date().toISOString();
    const previous = cur.status;
    entry.current = {
      status,
      since: previous === status ? cur.since : now,
      latencyMs: r.latencyMs,
      httpStatus: r.httpStatus,
      lastCheckedAt: now,
      lastError: r.error,
      failures,
    };
    const day = (entry.days[dayKey()] ||= { checks: 0, up: 0, degraded: 0, down: 0, latencySum: 0, latencyCount: 0 });
    day.checks++;
    day[status]++;
    if (r.latencyMs != null) {
      day.latencySum += r.latencyMs;
      day.latencyCount = (day.latencyCount || 0) + 1;
    }
    if (status === 'down' && previous !== 'down') entry.incidents.push({ start: now, end: null, error: r.error });
    if (previous === 'down' && status !== 'down') {
      const open = entry.incidents.at(-1);
      if (open && !open.end) open.end = now;
    }
    prune(entry);
    persist();
    if (previous && previous !== status) {
      try {
        onChange(apiId, previous, status, entry);
      } catch (err) {
        console.error('[saúde]', err.message);
      }
    }
    return entry.current;
  })().finally(() => running.delete(apiId));
  running.set(apiId, job);
  return job;
}

function remove(apiId) {
  if (!state[apiId]) return;
  delete state[apiId];
  auth.forgetToken(`health:${apiId}`);
  persist();
}

/** Last 90 days, oldest first: { date, uptime (0–100 or null), checks, avgMs }. */
function history(entry) {
  const out = [];
  for (let i = KEEP_DAYS - 1; i >= 0; i--) {
    const date = dayKey(new Date(Date.now() - i * 86400_000));
    const d = entry?.days?.[date];
    out.push(
      d && d.checks
        ? { date, uptime: Math.round(((d.checks - d.down) / d.checks) * 10000) / 100, checks: d.checks, avgMs: d.latencyCount ? Math.round(d.latencySum / d.latencyCount) : null }
        : { date, uptime: null, checks: 0, avgMs: null }
    );
  }
  return out;
}

function uptime(entry) {
  let checks = 0;
  let down = 0;
  for (const d of Object.values(entry?.days || {})) {
    checks += d.checks;
    down += d.down;
  }
  return checks ? Math.round(((checks - down) / checks) * 10000) / 100 : null;
}

/** Public status of one API (no route, URL or credential). */
function publicView(apiId, withHistory = false) {
  const entry = state[apiId];
  if (!entry?.config) return { monitored: false };
  const c = entry.current || {};
  return {
    monitored: true,
    status: c.status || 'pending',
    since: c.since || null,
    latencyMs: c.latencyMs ?? null,
    lastCheckedAt: c.lastCheckedAt || null,
    uptime90: uptime(entry),
    ...(withHistory ? { days: history(entry), incidents: (entry.incidents || []).slice(-20).map(({ start, end }) => ({ start, end })) } : {}),
  };
}

/** Settings and last result for the admin (no secret). */
function adminView(apiId) {
  const entry = state[apiId];
  if (!entry?.config) return { monitored: false, intervalSeconds: INTERVAL_S };
  const { secret: _s, ...cfg } = entry.config;
  return {
    monitored: true,
    intervalSeconds: INTERVAL_S,
    baseUrl: cfg.baseUrl,
    path: cfg.path,
    ...auth.authView(entry.config),
    current: entry.current || null,
  };
}

async function runAll() {
  await Promise.all(Object.keys(state).map((id) => check(id).catch((err) => console.error('[saúde]', err.message))));
}

function start(changeHandler) {
  if (changeHandler) onChange = changeHandler;
  setTimeout(runAll, 5_000).unref();
  setInterval(runAll, INTERVAL_S * 1000).unref();
}

module.exports = { init, configure, check, remove, publicView, adminView, start, INTERVAL_S };

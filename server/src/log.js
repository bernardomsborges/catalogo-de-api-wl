/**
 * Server logs (PRO-208): one line per event with time, level, message and the id of the request that
 * caused it, so an error can be tied to the call that triggered it.
 *
 * - LOG_FORMAT=json (default with NODE_ENV=production, e.g. the Docker image): one JSON object per line.
 * - LOG_FORMAT=text (default otherwise): readable lines for development.
 * - LOG_LEVEL=debug|info|warn|error (default info).
 *
 * The existing console.log/warn/error calls go through here (install()), so every module gets the
 * format and the request id without changing. "[contas] texto" becomes { scope: "contas", msg: "texto" }.
 */
const crypto = require('crypto');
const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const context = new AsyncLocalStorage();
const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

const settings = () => ({
  json: (process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json',
  min: LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info,
});
let cfg = settings();

/** The request being handled (its id), when there is one. */
const requestId = () => context.getStore()?.reqId;

function write(level, args, extra = {}) {
  if (LEVELS[level] < cfg.min) return;
  let parts = args;
  let scope;
  if (typeof parts[0] === 'string') {
    const m = /^\[([^\]]+)\]\s*/.exec(parts[0]);
    if (m) {
      scope = m[1];
      parts = [parts[0].slice(m[0].length), ...parts.slice(1)].filter((p, i) => i > 0 || p !== '');
    }
  }
  const errors = parts.filter((p) => p instanceof Error);
  const msg = parts.map((p) => (p instanceof Error ? p.message : typeof p === 'string' ? p : util.inspect(p, { depth: 4, breakLength: Infinity }))).join(' ');
  const reqId = extra.reqId ?? requestId();
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (cfg.json) {
    /** @type {Record<string, any>} */
    const line = { time: new Date().toISOString(), level, ...(scope ? { scope } : {}), msg, ...(reqId ? { reqId } : {}), ...extra };
    if (errors[0]?.stack) line.stack = errors[0].stack;
    out.write(`${JSON.stringify(line)}\n`);
  } else {
    const fields = Object.entries(extra).filter(([k]) => k !== 'reqId').map(([k, v]) => `${k}=${v}`).join(' ');
    out.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ''}${msg}${fields ? ` ${fields}` : ''}${reqId ? ` (req ${reqId})` : ''}\n`);
    if (errors[0]?.stack && level === 'error') out.write(`${errors[0].stack}\n`);
  }
}

const log = {
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  /** With structured fields: log.with('info', 'texto', { campo: 1 }). */
  with: (level, msg, fields) => write(level, [msg], fields),
};

/** Sends console.* through the logger. */
function install() {
  cfg = settings();
  console.log = log.info;
  console.info = log.info;
  console.warn = log.warn;
  console.error = log.error;
  console.debug = log.debug;
}

function uninstall() {
  Object.assign(console, original);
}

/** Path for the log: no query string, long random-looking segments and e-mails masked. */
function safePath(p) {
  return String(p)
    .split('?')[0]
    .split('/')
    .map((s) => (/@/.test(decodeURIComponentSafe(s)) ? ':email' : /^(?=.*\d)[A-Za-z0-9_-]{24,}$/.test(s) ? ':token' : s))
    .join('/');
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** An id coming from the proxy in front is kept when it looks like one; otherwise a new one. */
const GOOD_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Express middleware: gives each request an id (header X-Request-Id, also in the response) and logs,
 * when it ends, method, route, status and time. Never the query string, body, headers or cookies.
 * `quiet(req)`: requests logged at debug level only (e.g. the health check every 30s).
 */
/** @param {{ quiet?: (req: import('express').Request) => boolean }} [options] */
function requests({ quiet = () => false } = {}) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const reqId = incoming && GOOD_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.id = reqId;
    res.set('X-Request-Id', reqId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
      const route = req.route?.path && typeof req.route.path === 'string' ? (req.baseUrl || '') + req.route.path : safePath(req.originalUrl);
      const level = res.statusCode >= 500 ? 'error' : quiet(req) ? 'debug' : 'info';
      write(level, ['[http] requisição'], { reqId, method: req.method, route, status: res.statusCode, ms });
    });
    context.run({ reqId }, next);
  };
}

module.exports = { log, install, uninstall, requests, requestId, safePath };

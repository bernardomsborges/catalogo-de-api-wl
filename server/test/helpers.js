// Starts the real server (src/index.js) on a free port, with its data in a temporary folder.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/** Variables from the developer's shell that would point the test server at real data or services. */
const OUTSIDE = /(_FILE|_DIR|_URL)$|^LLM_|^SMTP|^ADMIN_|^SESSION_|^TRUST_PROXY$|^CORS_ORIGINS$|^OIDC_|^PASSWORD_LOGIN$|^NODE_ENV$|^LOG_|^PORTAL_|^ORG_NAME$|^CATALOG_IMPORT$/;

/** Port a server listening on TCP got. */
const portOf = (server) => /** @type {import('node:net').AddressInfo} */ (server.address()).port;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = portOf(s);
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(check, message, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(message());
}

/**
 * `files`: { 'apis.json': [...], ... } written to the data folder first. `env`: extra variables.
 * `ready`: log line to wait for (null: don't wait). Returns { base, dir, call, stop, log(), exited() }.
 */
async function startServer({ files = {}, env = {}, ready = /rodando em/ } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-test-'));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (OUTSIDE.test(k)) delete childEnv[k];
  Object.assign(childEnv, {
    PORT: String(port),
    DATA_FILE: path.join(dir, 'apis.json'),
    HEALTH_INTERVAL_SECONDS: '3600',
    SYNC_INTERVAL_HOURS: '1000',
    ...env,
  });
  let log = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  let exited = false;
  child.on('exit', () => (exited = true));
  if (ready) {
    await waitFor(() => ready.test(log) || exited, () => `o servidor não subiu:\n${log}`);
    if (exited) throw new Error(`o servidor parou ao subir:\n${log}`);
  }

  /** fetch with JSON in and out. */
/** @param {string} method @param {string} url @param {{ token?: string, body?: any, headers?: Record<string, string>, redirect?: RequestRedirect }} [options] */
  const call = async (method, url, { token, body, headers = {}, redirect = 'follow' } = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, json, text };
  };

  return {
    base,
    dir,
    call,
    log: () => log,
    exited: () => exited,
    /** Stops the server; resolves once the process is gone. */
    stop() {
      const gone = exited ? Promise.resolve() : new Promise((r) => child.once('exit', r));
      child.kill();
      return gone.finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    },
  };
}

module.exports = { startServer, freePort, waitFor, portOf };

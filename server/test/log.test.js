// JSON logs with the id of each request (PRO-208).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { safePath } = require('../src/log');
const { startServer } = require('./helpers');

describe('paths in the log', () => {
  test('no query string, tokens or e-mails', () => {
    assert.equal(safePath('/api/subscriptions/unsubscribe?token=abc'), '/api/subscriptions/unsubscribe');
    assert.equal(safePath('/x/9f8e7d6c5b4a39281706f5e4d3c2b1a0'), '/x/:token');
    assert.equal(safePath('/x/maria%40orgao.gov.br'), '/x/:email');
    assert.equal(safePath('/apis/workflows/referencia'), '/apis/workflows/referencia');
  });
});

describe('HTTP', () => {
  let server;
  before(async () => {
    server = await startServer({ env: { LOG_FORMAT: 'json', ADMIN_EMAIL: 'admin@exemplo.gov.br', ADMIN_PASSWORD: 'senha-do-admin-123' } });
  });
  after(() => server?.stop());

  const lines = () =>
    server
      .log()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { notJson: l };
        }
      });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  test('every line is JSON with time, level and message', async () => {
    const all = lines();
    assert.ok(all.length > 3);
    for (const l of all) {
      assert.equal(l.notJson, undefined, `linha fora do JSON: ${l.notJson}`);
      assert.ok(l.time && l.level && typeof l.msg === 'string', JSON.stringify(l));
    }
    assert.ok(all.some((l) => l.scope === 'contas'), 'the "[contas]" prefix becomes the scope');
  });

  test('each request gets an id, sent back in a header and logged with method, route, status and time', async () => {
    const r = await server.call('GET', '/api/apis/workflows?token=segredo-123');
    const id = r.headers.get('x-request-id');
    assert.match(id, /^[0-9a-f-]{36}$/);
    await settle();
    const line = lines().find((l) => l.reqId === id && l.msg === 'requisição');
    assert.deepEqual({ method: line.method, route: line.route, status: line.status }, { method: 'GET', route: '/api/apis/:idOrSlug', status: 200 });
    assert.equal(typeof line.ms, 'number');
    assert.doesNotMatch(server.log(), /segredo-123/);
  });

  test('an id from the proxy in front is kept; a strange one is replaced', async () => {
    const kept = await server.call('GET', '/api/auth/options', { headers: { 'x-request-id': 'proxy-abc-12345' } });
    assert.equal(kept.headers.get('x-request-id'), 'proxy-abc-12345');
    const replaced = await server.call('GET', '/api/auth/options', { headers: { 'x-request-id': 'x y<script>' } });
    assert.notEqual(replaced.headers.get('x-request-id'), 'x y<script>');
  });

  test('what a module logs during a request carries its id, and no password or e-mail goes in the request line', async () => {
    const login = await server.call('POST', '/api/auth/login', { body: { email: 'admin@exemplo.gov.br', password: 'senha-do-admin-123' } });
    const r = await server.call('POST', '/api/auth/logout-all', { token: login.json.token });
    const id = r.headers.get('x-request-id');
    await settle();
    const mine = lines().filter((l) => l.reqId === id);
    assert.ok(mine.some((l) => l.scope === 'contas' && /encerrou/.test(l.msg)), JSON.stringify(mine));
    const requestLines = lines().filter((l) => l.msg === 'requisição');
    assert.doesNotMatch(JSON.stringify(requestLines), /senha-do-admin|admin@exemplo|authorization|Bearer/i);
  });

  test('the health check stays out of the info level', async () => {
    const r = await server.call('GET', '/healthz');
    await settle();
    assert.equal(lines().filter((l) => l.reqId === r.headers.get('x-request-id')).length, 0);
  });
});

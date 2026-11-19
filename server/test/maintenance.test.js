// Call limits that forget idle IPs (PRO-204) and the light health route (PRO-201).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../src/rate-limit');
const { startServer } = require('./helpers');

describe('call limits', () => {
  test('blocks after `max` calls inside the window and lets through once it passes', () => {
    const l = createLimiter(2, 1000);
    assert.equal(l.hit('a', 0), false);
    assert.equal(l.hit('a', 100), false);
    assert.equal(l.hit('a', 200), true);
    assert.equal(l.hit('b', 200), false, 'each IP has its own count');
    assert.equal(l.hit('a', 1050), false, 'the first call left the window');
  });

  test('the sweep removes only IPs with no call inside the window', () => {
    const l = createLimiter(5, 1000);
    l.hit('velho', 0);
    l.hit('recente', 0);
    l.hit('recente', 900);
    assert.equal(l.sweep(1500), 1);
    assert.equal(l.size(), 1);
    assert.equal(l.hit('recente', 1500), false, 'the remaining IP keeps its count');
    assert.equal(l.sweep(5000), 1);
    assert.equal(l.size(), 0);
  });
});

describe('/healthz', () => {
  let server;
  before(async () => {
    server = await startServer({ env: { ADMIN_PASSWORD: 'senha-do-admin-123' } });
  });
  after(() => server?.stop());

  test('answers ok without caching, naming the storage', async () => {
    const res = await fetch(`${server.base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { status: 'ok', database: 'arquivo' });
  });
});

// Needs a database: set TEST_DATABASE_URL (the CI does). Without it, skipped.
const dbUrl = process.env.TEST_DATABASE_URL;
test('/healthz checks PostgreSQL', { skip: !dbUrl && 'defina TEST_DATABASE_URL para rodar' }, async () => {
  const server = await startServer({ env: { DATABASE_URL: dbUrl, ADMIN_PASSWORD: 'senha-do-admin-123', INSTANCE_LOCK_RETRY_MS: '200' } });
  try {
    const res = await fetch(`${server.base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', database: 'PostgreSQL' });
  } finally {
    await server.stop();
  }
});

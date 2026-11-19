// One instance only (PRO-197): with PostgreSQL, a second copy waits until the first one stops.
// Needs a database: set TEST_DATABASE_URL (the CI does, with a PostgreSQL service). Without it, skipped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor } = require('./helpers');

const url = process.env.TEST_DATABASE_URL;

test('a second copy waits for the first one and takes over when it stops', { skip: !url && 'defina TEST_DATABASE_URL para rodar' }, async () => {
  const env = { DATABASE_URL: url, ADMIN_PASSWORD: 'senha-do-admin-123', INSTANCE_LOCK_RETRY_MS: '200' };
  const first = await startServer({ env });
  let second;
  try {
    assert.match(first.log(), /\[instância\] esta é a única cópia rodando/);

    second = await startServer({ env, ready: /Esperando ela parar/ });
    // Waiting: it hasn't loaded the data nor opened its port.
    await new Promise((r) => setTimeout(r, 600));
    assert.doesNotMatch(second.log(), /rodando em/);
    await assert.rejects(fetch(`${second.base}/api/apis`));

    await first.stop();
    await waitFor(() => /rodando em/.test(second.log()) || second.exited(), () => `a segunda cópia não assumiu:\n${second.log()}`);
    assert.match(second.log(), /a outra cópia parou; esta assumiu/);
    const r = await second.call('GET', '/api/apis');
    assert.equal(r.status, 200);
  } finally {
    await first.stop();
    await second?.stop();
  }
});

// Passwords: hashing doesn't block the other requests, and hashes saved before keep working.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-senhas-'));
process.env.DATA_FILE = path.join(DIR, 'apis.json');
delete process.env.ACCOUNTS_FILE;
delete process.env.DATABASE_URL;

/** Hash in the format saved by the older, synchronous code. */
function oldHash(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(password, salt, 64).toString('base64')}`;
}

let accounts;

before(async () => {
  const user = { id: 'antiga', email: 'antiga@teste.gov.br', name: 'Conta antiga', passwordHash: oldHash('senha-de-antes-1'), role: 'consumer', groups: [], tokenVersion: 0, createdAt: '2026-01-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(DIR, 'accounts.json'), JSON.stringify({ secret: 'segredo-de-teste', users: [user], groups: [], requests: [] }));
  accounts = require('../src/accounts');
  await accounts.init();
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('a password saved by the older code still logs in', async () => {
  assert.ok(await accounts.login('antiga@teste.gov.br', 'senha-de-antes-1'));
  assert.equal(await accounts.login('antiga@teste.gov.br', 'outra-senha-123'), null);
});

test('register, change and log in with the new code', async () => {
  const { user, error } = await accounts.register({ email: 'nova@teste.gov.br', name: 'Nova', password: 'senha-nova-123' });
  assert.equal(error, undefined);
  assert.match(user.passwordHash, /^scrypt\$/);
  assert.ok(await accounts.login('nova@teste.gov.br', 'senha-nova-123'));
  assert.deepEqual(await accounts.changePassword(user, 'errada-123', 'outra-senha-456'), { error: 'A senha atual está incorreta.' });
  assert.ok((await accounts.changePassword(user, 'senha-nova-123', 'outra-senha-456')).token);
  assert.ok(await accounts.login('nova@teste.gov.br', 'outra-senha-456'));
});

test('two sign-ups with the same e-mail at the same time create one account', async () => {
  const input = { email: 'dupla@teste.gov.br', name: 'Dupla', password: 'senha-dupla-123' };
  const results = await Promise.all([accounts.register(input), accounts.register(input)]);
  assert.equal(results.filter((r) => r.user).length, 1);
  assert.equal(accounts.listUsers().filter((u) => u.email === 'dupla@teste.gov.br').length, 1);
});

test('hashing passwords does not block the event loop', async () => {
  // A timer that should keep ticking while 8 logins are checked. With scryptSync, it would stop.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const started = Date.now();
  await Promise.all(Array.from({ length: 8 }, () => accounts.login('antiga@teste.gov.br', 'senha-de-antes-1')));
  const elapsed = Date.now() - started;
  clearInterval(timer);
  assert.ok(ticks >= Math.min(5, elapsed / 4), `o relógio parou: ${ticks} batidas em ${elapsed} ms`);
});

test('an admin password error changes nothing else', async () => {
  const user = accounts.listUsers().find((u) => u.email === 'antiga@teste.gov.br');
  const r = await accounts.updateUser(user.id, { name: 'Nome novo', password: 'curta' }, null);
  assert.match(r.error, /pelo menos 8/);
  assert.equal(accounts.listUsers().find((u) => u.id === user.id).name, 'Conta antiga');
});

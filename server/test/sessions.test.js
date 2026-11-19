// "Sair de todos os dispositivos" and ending someone's sessions from Pessoas (PRO-203).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let server;
before(async () => {
  server = await startServer({ env: { ADMIN_EMAIL: 'admin@exemplo.gov.br', ADMIN_PASSWORD: 'senha-do-admin-123' } });
});
after(() => server?.stop());

const login = async (email, password) => {
  const r = await server.call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(r.status, 200, `login de ${email}: ${r.text}`);
  return r.json.token;
};
const me = (token) => server.call('GET', '/api/auth/me', { token }).then((r) => r.status);

test('a person ends every one of their sessions, the current one included', async () => {
  const r = await server.call('POST', '/api/auth/register', { body: { email: 'maria@exemplo.gov.br', name: 'Maria', password: 'senha-da-maria-1' } });
  assert.equal(r.status, 201);
  const other = await login('maria@exemplo.gov.br', 'senha-da-maria-1');
  assert.equal((await server.call('POST', '/api/auth/logout-all', { token: r.json.token })).status, 204);
  assert.equal(await me(r.json.token), 401);
  assert.equal(await me(other), 401);
  assert.equal(await me(await login('maria@exemplo.gov.br', 'senha-da-maria-1')), 200, 'entering again still works');
});

test('logout-all needs a session', async () => {
  assert.equal((await server.call('POST', '/api/auth/logout-all')).status, 401);
});

test('the admin ends the sessions of someone else; others cannot', async () => {
  const admin = await login('admin@exemplo.gov.br', 'senha-do-admin-123');
  const joao = (await server.call('POST', '/api/auth/register', { body: { email: 'joao@exemplo.gov.br', name: 'João', password: 'senha-do-joao-1' } })).json;
  const maria = await login('maria@exemplo.gov.br', 'senha-da-maria-1');

  assert.equal((await server.call('POST', `/api/admin/users/${joao.user.id}/logout-all`, { token: maria })).status, 403);
  assert.equal(await me(joao.token), 200);

  assert.equal((await server.call('POST', `/api/admin/users/${joao.user.id}/logout-all`, { token: admin })).status, 200);
  assert.equal(await me(joao.token), 401);
  assert.equal(await me(admin), 200, "the admin's own session stays");
  assert.equal(await me(maria), 200, "other people's sessions stay");
  assert.equal((await server.call('POST', '/api/admin/users/nao-existe/logout-all', { token: admin })).status, 404);
});

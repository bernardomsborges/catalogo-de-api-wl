// Questions the assistant couldn't answer, grouped and marked as resolved (PRO-198).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const at = (day) => `2026-11-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const GAPS = [
  { question: 'Como emitir a certidão?', api: 'sei', at: at(1) },
  { question: 'como EMITIR a certidao', api: null, at: at(3) },
  { question: 'Qual o limite de chamadas?', api: 'sei', at: at(2) },
  { question: 'Como emitir a certidão??', api: 'protocolo', at: at(4) },
];

let server;
let admin;
before(async () => {
  server = await startServer({ files: { 'ai-gaps.json': GAPS }, env: { ADMIN_EMAIL: 'admin@exemplo.gov.br', ADMIN_PASSWORD: 'senha-do-admin-123' } });
  admin = (await server.call('POST', '/api/auth/login', { body: { email: 'admin@exemplo.gov.br', password: 'senha-do-admin-123' } })).json.token;
});
after(() => server?.stop());

const groups = async () => (await server.call('GET', '/api/ai/gaps', { token: admin })).json;

test('the same question typed differently is one group, most recent first', async () => {
  const list = await groups();
  assert.equal(list.length, 2);
  const [certidao, limite] = list;
  assert.equal(certidao.key, 'como emitir a certidao');
  assert.equal(certidao.question, 'Como emitir a certidão??', 'the most recent wording');
  assert.equal(certidao.count, 3);
  assert.equal(certidao.firstAt, at(1));
  assert.equal(certidao.lastAt, at(4));
  assert.deepEqual(certidao.apis, ['sei', 'protocolo']);
  assert.equal(limite.count, 1);
});

test('marking as resolved, then a new occurrence opens it again', async () => {
  const r = await server.call('POST', '/api/ai/gaps/resolve', { token: admin, body: { key: 'como emitir a certidao' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.resolved, true);
  assert.equal(r.json.resolvedBy, 'admin@exemplo.gov.br');

  const back = await server.call('POST', '/api/ai/gaps/resolve', { token: admin, body: { key: 'como emitir a certidao', resolved: false } });
  assert.equal(back.json.resolved, false);
  assert.equal(back.json.open, 3);

  assert.equal((await server.call('POST', '/api/ai/gaps/resolve', { token: admin, body: { key: 'nao existe' } })).status, 404);
});

test('only staff see and change the list', async () => {
  const r = await server.call('POST', '/api/auth/register', { body: { email: 'maria@exemplo.gov.br', name: 'Maria', password: 'senha-da-maria-1' } });
  assert.equal((await server.call('GET', '/api/ai/gaps', { token: r.json.token })).status, 403);
  assert.equal((await server.call('POST', '/api/ai/gaps/resolve', { token: r.json.token, body: { key: 'qual o limite de chamadas' } })).status, 403);
  assert.equal((await server.call('GET', '/api/ai/gaps')).status, 401);
});

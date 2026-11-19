// Consumer systems: who uses each API (PRO-166).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const api = (slug, extra = {}) => ({
  id: `id-${slug}`,
  slug,
  name: `API ${slug}`,
  summary: 'Resumo.',
  description: '',
  category: 'Teste',
  tags: [],
  status: 'estavel',
  visibility: 'public',
  groups: [],
  baseUrl: 'https://api.exemplo.gov.br',
  endpoints: [
    { id: 'e1', method: 'GET', path: '/processos', summary: 'Listar', parameters: [], responses: [] },
    { id: 'e2', method: 'POST', path: '/processos', summary: 'Abrir', parameters: [], responses: [] },
  ],
  ...extra,
});

let server;
let admin;
let maria;
before(async () => {
  server = await startServer({
    files: {
      'apis.json': [api('sei'), api('privada', { visibility: 'private', groups: ['g'] })],
      'accounts.json': {
        users: [{ id: 'u-joao', email: 'joao@exemplo.gov.br', name: 'João', passwordHash: '', role: 'consumer', groups: [], tokenVersion: 0, createdAt: '2026-10-01T00:00:00Z' }],
        groups: [],
        // An approved request: João asked for the SEI for his system.
        requests: [{ id: 'r1', userId: 'u-joao', apiId: 'id-sei', apiName: 'API sei', groupId: null, message: 'Integração do Sistema de Protocolo', status: 'approved', createdAt: '2026-11-01T00:00:00Z', decidedAt: '2026-11-02T00:00:00Z' }],
      },
    },
    env: { ADMIN_EMAIL: 'admin@exemplo.gov.br', ADMIN_PASSWORD: 'senha-do-admin-123' },
  });
  admin = (await server.call('POST', '/api/auth/login', { body: { email: 'admin@exemplo.gov.br', password: 'senha-do-admin-123' } })).json.token;
  maria = (await server.call('POST', '/api/auth/register', { body: { email: 'maria@exemplo.gov.br', name: 'Maria', password: 'senha-da-maria-1' } })).json.token;
});
after(() => server?.stop());

const create = (body, token = admin) => server.call('POST', '/api/admin/systems', { token, body });

test('a system is registered with the APIs and routes it uses; unknown ones are dropped', async () => {
  const r = await create({
    name: 'Sistema de Protocolo',
    owner: 'Time de Protocolo',
    contactEmail: 'Protocolo@Exemplo.gov.br',
    uses: [
      { apiId: 'id-sei', routes: ['POST /processos', 'DELETE /nao-existe'] },
      { apiId: 'id-sei', routes: [] },
      { apiId: 'nao-existe' },
    ],
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.contactEmail, 'protocolo@exemplo.gov.br');
  assert.deepEqual(r.json.uses, [{ apiId: 'id-sei', routes: ['POST /processos'] }]);
});

test('name, e-mail and at least one API are checked; names are unique', async () => {
  assert.match((await create({ name: '', uses: [{ apiId: 'id-sei' }] })).json.message, /nome/);
  assert.match((await create({ name: 'X', contactEmail: 'invalido', uses: [{ apiId: 'id-sei' }] })).json.message, /e-mail/);
  assert.match((await create({ name: 'X', uses: [] })).json.message, /ao menos uma API/);
  assert.match((await create({ name: 'sistema de protocolo', uses: [{ apiId: 'id-sei' }] })).json.message, /Já existe/);
});

test('the API page shows who uses it to logged-in people who can see the API', async () => {
  await create({ name: 'Painel interno', uses: [{ apiId: 'id-sei' }, { apiId: 'id-privada' }] });
  const r = await server.call('GET', '/api/apis/sei/consumers', { token: maria });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((s) => `${s.name}: ${s.routes.join(',') || 'API inteira'}`), ['Painel interno: API inteira', 'Sistema de Protocolo: POST /processos']);
  assert.equal(r.json[1].contactEmail, 'protocolo@exemplo.gov.br');
  assert.equal((await server.call('GET', '/api/apis/sei/consumers')).status, 401, 'contacts are internal');
  assert.equal((await server.call('GET', '/api/apis/privada/consumers', { token: maria })).status, 404, 'a private API without access');
});

test('only the team manages the systems', async () => {
  assert.equal((await create({ name: 'Y', uses: [{ apiId: 'id-sei' }] }, maria)).status, 403);
  assert.equal((await server.call('GET', '/api/admin/systems', { token: maria })).status, 403);
});

test('approved access requests become suggestions until the person and API are linked', async () => {
  const suggestions = async () => (await server.call('GET', '/api/admin/systems/suggestions', { token: admin })).json;
  const [s] = await suggestions();
  assert.equal(s.person.email, 'joao@exemplo.gov.br');
  assert.deepEqual(s.apis, [{ id: 'id-sei', name: 'API sei' }]);
  assert.equal(s.message, 'Integração do Sistema de Protocolo');
  await create({ name: 'Protocolo do João', contactEmail: 'joao@exemplo.gov.br', uses: [{ apiId: 'id-sei' }] });
  assert.deepEqual(await suggestions(), []);
});

test('deleting an API removes it from the systems', async () => {
  const list = async () => (await server.call('GET', '/api/admin/systems', { token: admin })).json;
  const painel = (await list()).find((s) => s.name === 'Painel interno');
  assert.equal(painel.uses.length, 2);
  assert.equal((await server.call('DELETE', '/api/apis/id-privada', { token: admin })).status, 204);
  assert.deepEqual((await list()).find((s) => s.name === 'Painel interno').uses.map((u) => u.apiId), ['id-sei']);
});

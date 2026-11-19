// Switch-off day and replacement of deprecated APIs (PRO-205).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, waitFor } = require('./helpers');

const api = (slug, extra = {}) => ({
  id: `id-${slug}`,
  slug,
  name: `API ${slug}`,
  summary: 'Resumo.',
  description: '',
  category: 'Teste',
  tags: [],
  status: 'estavel',
  version: '1.0.0',
  visibility: 'public',
  groups: [],
  baseUrl: 'https://api.exemplo.gov.br',
  endpoints: [],
  revision: 1,
  ...extra,
});

let server;
let admin;
before(async () => {
  server = await startServer({
    files: {
      'apis.json': [api('antiga'), api('nova'), api('privada', { visibility: 'private', groups: ['g'] })],
      'subscriptions.json': [{ id: 's1', apiId: 'id-antiga', email: 'quem@usa.gov.br', token: 't1', status: 'active', createdAt: '2026-01-01T00:00:00Z' }],
    },
    env: { ADMIN_EMAIL: 'admin@exemplo.gov.br', ADMIN_PASSWORD: 'senha-do-admin-123', PUBLIC_URL: 'https://apis.exemplo.gov.br' },
  });
  admin = (await server.call('POST', '/api/auth/login', { body: { email: 'admin@exemplo.gov.br', password: 'senha-do-admin-123' } })).json.token;
});
after(() => server?.stop());

const get = async (slug, token) => (await server.call('GET', `/api/apis/${slug}`, { token })).json;
const save = async (slug, changes) => {
  const current = await get(slug, admin);
  return server.call('PUT', `/api/apis/${current.id}`, { token: admin, body: { ...current, ...changes } });
};
const mails = () => {
  const dir = path.join(server.dir, 'outbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
};

test('a deprecated API keeps the switch-off day and the replacement, and the followers hear about it', async () => {
  const r = await save('antiga', { status: 'depreciada', sunsetDate: '2027-03-31', replacedBy: 'id-nova' });
  assert.equal(r.status, 200, r.text);
  const a = await get('antiga');
  assert.equal(a.sunsetDate, '2027-03-31');
  assert.equal(a.replacedBy, 'id-nova');

  await waitFor(() => mails().length === 1, () => `e-mails: ${mails().length}`);
  const mail = mails()[0];
  assert.match(mail, /foi depreciada/);
  assert.match(mail, /31\/03\/2027/);
  assert.match(mail, /API nova/);
});

test('moving the switch-off day sends a new notice', async () => {
  await save('antiga', { sunsetDate: '2027-06-30' });
  await waitFor(() => mails().length === 2, () => `e-mails: ${mails().length}`);
  assert.match(mails()[1], /desligada em 30\/06\/2027/);
});

test('invalid day is refused; itself or an unknown API is not a replacement', async () => {
  assert.equal((await save('antiga', { sunsetDate: '2027-02-30' })).status, 400);
  await save('antiga', { replacedBy: 'id-antiga' });
  assert.equal((await get('antiga')).replacedBy, '');
  await save('antiga', { replacedBy: 'nao-existe' });
  assert.equal((await get('antiga')).replacedBy, '');
});

test('the fields go away when the API is no longer deprecated', async () => {
  await save('antiga', { status: 'estavel', sunsetDate: '2027-06-30', replacedBy: 'id-nova' });
  const a = await get('antiga');
  assert.equal(a.sunsetDate, undefined);
  assert.equal(a.replacedBy, undefined);
});

test('a private API shows its switch-off day to people without access', async () => {
  await save('privada', { status: 'depreciada', sunsetDate: '2027-01-15', replacedBy: 'id-nova' });
  const locked = await get('privada');
  assert.equal(locked.locked, true);
  assert.equal(locked.sunsetDate, '2027-01-15');
  assert.equal(locked.replacedBy, 'id-nova');
});

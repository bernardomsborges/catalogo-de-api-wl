// Private APIs: who sees what, straight from the rules and through the HTTP routes (portal,
// console, ReceAPItos and the assistant). The server runs on a temporary data folder.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-test-'));
process.env.DATA_FILE = path.join(DIR, 'apis.json');
const accounts = require('../src/accounts');
const { startServer } = require('./helpers');

const ADMIN = { email: 'admin@teste.gov.br', password: 'senha-do-admin-123' };
const SECRET_WORD = 'Zarabatana'; // only appears in the private API

function api(over) {
  return {
    summary: '',
    description: '',
    category: 'Testes',
    tags: [],
    status: 'estavel',
    version: '1.0.0',
    owner: 'Time de testes',
    contactEmail: 'time@teste.gov.br',
    baseUrl: 'http://127.0.0.1:9',
    environments: [],
    auth: { type: 'apiKey', headerName: 'X-API-Key', tokenUrl: '', scopes: '', instructions: 'Peça ao time.', schemes: [], mode: 'all' },
    rateLimit: '',
    sla: '',
    guides: [],
    changelog: [],
    visibility: 'public',
    groups: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const endpoint = (path, summary) => ({ method: 'GET', path, summary, description: summary, parameters: [], requestBody: '', responses: [{ status: 200, description: 'OK', body: '{"ok":true}' }] });

const PUBLIC = api({ id: 'pub', slug: 'publica', name: 'API Pública', summary: 'Consulta de feriados', endpoints: [endpoint('/feriados', 'Lista os feriados')] });
const PRIVATE = api({
  id: 'priv',
  slug: 'privada',
  name: 'API Privada',
  summary: 'Dados internos',
  description: `Descrição interna com a palavra ${SECRET_WORD}.`,
  baseUrl: 'https://interna.exemplo.gov.br',
  visibility: 'private',
  groups: ['g-time'],
  endpoints: [endpoint('/segredos', `Lista ${SECRET_WORD}s`)],
});

const step = (a, ep) => ({ apiId: a.id, apiSlug: a.slug, method: 'GET', path: ep, title: 'Passo', params: [], body: '', outputs: [] });
const RECIPES = [
  { id: 'r-pub', slug: 'so-publica', title: 'Só a pública', goal: '', intro: '', tags: [], inputs: [], steps: [step(PUBLIC, '/feriados')], createdAt: '', updatedAt: '' },
  { id: 'r-priv', slug: 'usa-privada', title: 'Usa a privada', goal: '', intro: '', tags: [], inputs: [], steps: [step(PUBLIC, '/feriados'), step(PRIVATE, '/segredos')], createdAt: '', updatedAt: '' },
];

describe('canSee / viewApi', () => {
  const consumer = { role: 'consumer', groups: [] };
  const member = { role: 'consumer', groups: ['g-time'] };

  test('public API: everybody, even without login', () => {
    assert.equal(accounts.canSee(undefined, PUBLIC), true);
    assert.equal(accounts.canSee(consumer, PUBLIC), true);
  });

  test('private API: staff and group members only', () => {
    assert.equal(accounts.canSee(undefined, PRIVATE), false);
    assert.equal(accounts.canSee(consumer, PRIVATE), false);
    assert.equal(accounts.canSee({ role: 'consumer', groups: ['outro'] }, PRIVATE), false);
    assert.equal(accounts.canSee(member, PRIVATE), true);
    assert.equal(accounts.canSee({ role: 'editor', groups: [] }, PRIVATE), true);
    assert.equal(accounts.canSee({ role: 'admin', groups: [] }, PRIVATE), true);
  });

  test('a disabled account loses access, even as admin', () => {
    assert.equal(accounts.canSee({ ...member, disabled: true }, PRIVATE), false);
    assert.equal(accounts.canSee({ role: 'admin', groups: [], disabled: true }, PRIVATE), false);
  });

  test('without access, only the summary is left', () => {
    const v = accounts.viewApi(consumer, PRIVATE);
    assert.equal(v.locked, true);
    assert.equal(v.name, PRIVATE.name);
    assert.equal(v.summary, PRIVATE.summary);
    assert.deepEqual(v.endpoints, []);
    assert.equal(v.baseUrl, '');
    assert.equal(v.description, '');
    assert.equal(v.auth.instructions, '');
    assert.deepEqual(v.groups, []);
    assert.ok(!JSON.stringify(v).includes(SECRET_WORD));
  });

  test('with access, the API comes whole', () => {
    assert.equal(accounts.viewApi(member, PRIVATE), PRIVATE);
  });
});

describe('HTTP routes for someone without access', () => {
  let server;
  const call = (...args) => server.call(...args);

  const login = async (email, password) => {
    const r = await call('POST', '/api/auth/login', { body: { email, password } });
    assert.equal(r.status, 200, `login de ${email}: ${r.text}`);
    return r.json.token;
  };

  let consumer;
  let admin;

  before(async () => {
    server = await startServer({
      files: { 'apis.json': [PUBLIC, PRIVATE], 'recipes.json': RECIPES },
      env: { ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password },
    });
    const reg = await call('POST', '/api/auth/register', { body: { email: 'pessoa@teste.gov.br', name: 'Pessoa', password: 'senha-da-pessoa-1' } });
    assert.ok(reg.status < 300, `cadastro: ${reg.text}`);
    consumer = reg.json.token;
    admin = await login(ADMIN.email, ADMIN.password);
  });

  after(() => {
    server?.stop();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  for (const who of ['anonymous', 'consumer']) {
    const token = () => (who === 'consumer' ? consumer : undefined);

    test(`${who}: GET /api/apis/:id brings only the summary`, async () => {
      const r = await call('GET', '/api/apis/privada', { token: token() });
      assert.equal(r.status, 200);
      assert.equal(r.json.locked, true);
      assert.deepEqual(r.json.endpoints, []);
      assert.ok(!r.text.includes(SECRET_WORD));
      assert.ok(!r.text.includes('interna.exemplo.gov.br'));
    });

    test(`${who}: GET /api/apis lists the private one locked`, async () => {
      const r = await call('GET', '/api/apis', { token: token() });
      assert.equal(r.status, 200);
      const priv = r.json.find((a) => a.id === 'priv');
      assert.equal(priv.locked, true);
      assert.equal(r.json.find((a) => a.id === 'pub').locked, undefined);
      assert.ok(!r.text.includes(SECRET_WORD));
    });

    test(`${who}: POST /api/console/send is refused`, async () => {
      const r = await call('POST', '/api/console/send', { token: token(), body: { apiId: 'priv', method: 'GET', url: 'https://interna.exemplo.gov.br/segredos' } });
      assert.equal(r.status, 403);
    });

    test(`${who}: ReceAPItos that use the private API are hidden`, async () => {
      const list = await call('GET', '/api/recipes', { token: token() });
      assert.deepEqual(list.json.map((x) => x.id), ['r-pub']);
      assert.equal((await call('GET', '/api/recipes/usa-privada', { token: token() })).status, 404);
      assert.equal((await call('GET', '/api/recipes/so-publica', { token: token() })).status, 200);
    });

    test(`${who}: the assistant doesn't reveal the private API`, async () => {
      const r = await call('POST', '/api/ai/ask', { token: token(), body: { question: `Como listar ${SECRET_WORD}s?` } });
      assert.equal(r.status, 200, r.text);
      assert.ok(!r.text.includes(SECRET_WORD), r.text);
      assert.ok(!r.text.includes('/segredos'), r.text);
    });
  }

  test('admin: sees the private API whole and its ReceAPItos', async () => {
    const r = await call('GET', '/api/apis/privada', { token: admin });
    assert.equal(r.json.locked, undefined);
    assert.equal(r.json.endpoints.length, 1);
    const list = await call('GET', '/api/recipes', { token: admin });
    assert.deepEqual(list.json.map((x) => x.id).sort(), ['r-priv', 'r-pub']);
  });

  test('admin: the assistant can find the private API', async () => {
    const r = await call('POST', '/api/ai/ask', { token: admin, body: { question: `Como listar ${SECRET_WORD}s?` } });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.includes('/segredos'), r.text);
  });
});


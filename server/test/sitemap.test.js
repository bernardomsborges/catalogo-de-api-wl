// /sitemap.xml and /robots.txt with the public pages only (PRO-207).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const api = (slug, extra = {}) => ({
  id: `id-${slug}`,
  slug,
  name: `API ${slug}`,
  summary: '',
  description: '',
  category: 'Teste',
  tags: [],
  status: 'estavel',
  visibility: 'public',
  groups: [],
  updatedAt: '2026-11-10T08:00:00.000Z',
  endpoints: [{ id: `ep-${slug}`, method: 'GET', path: '/x', summary: 'x', parameters: [], responses: [] }],
  ...extra,
});
const recipe = (slug, apiId, updatedAt) => ({
  id: `r-${slug}`,
  slug,
  title: slug,
  goal: '',
  intro: '',
  tags: [],
  inputs: {},
  steps: [{ id: 's1', title: 'Passo', description: '', apiId, method: 'GET', path: '/x', params: [], body: '', outputs: [] }],
  createdAt: updatedAt,
  updatedAt,
});

let server;
before(async () => {
  server = await startServer({
    files: {
      'apis.json': [api('aberta'), api('fechada', { visibility: 'private', groups: ['g'], updatedAt: '2026-11-15T08:00:00.000Z' })],
      'recipes.json': [recipe('publico', 'id-aberta', '2026-11-12T08:00:00.000Z'), recipe('privado', 'id-fechada', '2026-11-18T08:00:00.000Z')],
    },
    env: { ADMIN_PASSWORD: 'senha-do-admin-123', PUBLIC_URL: 'https://apis.exemplo.gov.br/' },
  });
});
after(() => server?.stop());

test('the sitemap lists the catalog and the public pages, with their dates', async () => {
  const r = await server.call('GET', '/sitemap.xml');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/xml/);
  const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [
    'https://apis.exemplo.gov.br/',
    'https://apis.exemplo.gov.br/apis',
    'https://apis.exemplo.gov.br/receapitos',
    'https://apis.exemplo.gov.br/status',
    'https://apis.exemplo.gov.br/apis/aberta',
    'https://apis.exemplo.gov.br/receapitos/publico',
  ]);
  assert.match(r.text, /<loc>https:\/\/apis.exemplo.gov.br\/apis\/aberta<\/loc><lastmod>2026-11-10<\/lastmod>/);
  assert.match(r.text, /<loc>https:\/\/apis.exemplo.gov.br\/<\/loc><lastmod>2026-11-12<\/lastmod>/, 'the home page has the newest public date');
  assert.doesNotMatch(r.text, /fechada|privado|2026-11-15|2026-11-18/);
});

test('robots.txt points to the sitemap and keeps crawlers out of the admin', async () => {
  const r = await server.call('GET', '/robots.txt');
  assert.match(r.text, /^Sitemap: https:\/\/apis.exemplo.gov.br\/sitemap.xml$/m);
  assert.match(r.text, /^Disallow: \/admin$/m);
  assert.match(r.text, /^Disallow: \/api\/$/m);
});

// Usage metrics: anonymous counters of views, searches and console calls (PRO-165).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { searchTerm } = require('../src/metrics');
const { startServer, waitFor, portOf } = require('./helpers');

describe('search terms', () => {
  test('normalized, and never a secret or an e-mail', () => {
    assert.equal(searchTerm('  Emitir   CERTIDÃO '), 'emitir certidão');
    assert.equal(searchTerm('a'), '');
    assert.equal(searchTerm('joao@orgao.exemplo.gov.br'), '');
    assert.equal(searchTerm('Bearer abcdefghijklmnop'), '');
    assert.equal(searchTerm('x'.repeat(300)).length, 80);
  });
});

describe('HTTP', () => {
  let server;
  let upstream;
  let admin;
  let person;
  const API_ID = 'api-metricas';

  before(async () => {
    // The API the console calls: /ok answers 200, /falha answers 500.
    upstream = http.createServer((req, res) => {
      res.writeHead(req.url.startsWith('/ok') ? 200 : 500, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${portOf(upstream)}`;
    const api = {
      id: API_ID,
      slug: 'metricas',
      name: 'API de métricas',
      summary: 'Para o teste.',
      description: '',
      category: 'Teste',
      tags: [],
      status: 'estavel',
      visibility: 'public',
      groups: [],
      baseUrl,
      endpoints: [
        { id: 'ep-ok', method: 'GET', path: '/ok', summary: 'Ok', parameters: [], responses: [] },
        { id: 'ep-falha', method: 'POST', path: '/falha', summary: 'Falha', parameters: [], responses: [] },
      ],
    };
    server = await startServer({
      files: { 'apis.json': [api] },
      env: { ADMIN_EMAIL: 'admin@exemplo.gov.br', ADMIN_PASSWORD: 'senha-do-admin-123', METRICS_SAVE_DELAY_MS: '200' },
    });
    admin = (await server.call('POST', '/api/auth/login', { body: { email: 'admin@exemplo.gov.br', password: 'senha-do-admin-123' } })).json.token;
    person = (await server.call('POST', '/api/auth/register', { body: { email: 'maria@exemplo.gov.br', name: 'Maria', password: 'senha-da-maria-1' } })).json.token;
  });
  after(async () => {
    await server?.stop();
    upstream?.close();
  });

  const send = (body, token) => server.call('POST', '/api/metrics', { body, token });
  const consoleCall = (endpointId, method, p, token) => server.call('POST', '/api/console/send', { token, body: { apiId: API_ID, endpointId, method, url: `${server.base.replace(/:\d+$/, '')}:${portOf(upstream)}${p}` } });
  const report = async (query = '') => (await server.call('GET', `/api/admin/metrics${query}`, { token: admin })).json;

  test('views, searches and console calls of visitors are counted', async () => {
    assert.equal((await send({ type: 'view', api: API_ID })).status, 204);
    assert.equal((await send({ type: 'view', api: 'metricas' }, person)).status, 204, 'by slug too');
    await send({ type: 'view', api: API_ID, guide: 'inicio-rapido' });
    await send({ type: 'view', api: API_ID, endpoint: 'ep-ok' });
    await send({ type: 'search', q: 'certidão', results: 0 });
    await send({ type: 'search', q: 'Certidão ', results: 0 });
    await send({ type: 'search', q: 'métricas', results: 1 });
    assert.equal((await consoleCall('ep-ok', 'GET', '/ok')).json.status, 200);
    assert.equal((await consoleCall('ep-falha', 'POST', '/falha', person)).json.status, 500);
    await consoleCall('ep-falha', 'POST', '/falha');

    const r = await report();
    assert.deepEqual(r.totals, { apiViews: 2, guideViews: 1, routeViews: 1, searches: 3, emptySearches: 2, consoleCalls: 3, consoleErrors: 2, unanswered: 0 });
    assert.deepEqual(r.apis.map((a) => [a.apiName, a.views]), [['API de métricas', 2]]);
    assert.deepEqual(r.guides.map((g) => g.guideId), ['inicio-rapido']);
    assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path} ${x.views}`), ['GET /ok 1']);
    assert.deepEqual(r.console.map((c) => `${c.method} ${c.path} ${c.calls}/${c.errors}`), ['POST /falha 2/2', 'GET /ok 1/0']);
    assert.deepEqual(r.emptySearches, [{ term: 'certidão', count: 2 }]);
    assert.equal(r.daily.length, 30);
  });

  test("the team's own visits are not counted", async () => {
    const before = (await report()).totals;
    await send({ type: 'view', api: API_ID }, admin);
    await send({ type: 'search', q: 'algo', results: 0 }, admin);
    await consoleCall('ep-ok', 'GET', '/ok', admin);
    assert.deepEqual((await report()).totals, before);
  });

  test('filter by API and period', async () => {
    const r = await report(`?api=${API_ID}&days=7`);
    assert.equal(r.days, 7);
    assert.equal(r.totals.apiViews, 2);
    assert.equal(r.totals.searches, 0, 'searches belong to the whole catalog');
    assert.equal((await report('?api=outra')).totals.apiViews, 0);
  });

  test('invalid records are refused', async () => {
    assert.equal((await send({ type: 'view', api: 'nao-existe' })).status, 400);
    assert.equal((await send({ type: 'outro' })).status, 400);
  });

  test('only staff see the numbers', async () => {
    assert.equal((await server.call('GET', '/api/admin/metrics', { token: person })).status, 403);
    assert.equal((await server.call('GET', '/api/admin/metrics')).status, 401);
  });

  test('what is saved has no IP, account or e-mail', async () => {
    const file = path.join(server.dir, 'metrics.json');
    await waitFor(() => fs.existsSync(file), () => 'metrics.json não foi gravado');
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /127\.0\.0\.1|maria|admin@|@exemplo/);
    assert.match(text, /certidão/);
  });
});

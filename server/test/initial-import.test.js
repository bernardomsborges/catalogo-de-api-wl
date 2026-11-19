// Initial catalog from CATALOG_IMPORT, on the first start only.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { parseSources, toInput } = require('../src/initial-import');
const { startServer, portOf } = require('./helpers');

const IMPORTER = path.join(__dirname, '..', 'generated', 'openapi-import.cjs');
const skip = !fs.existsSync(IMPORTER) && 'rode "npm run build" antes (gera o conversor de OpenAPI)';

const spec = (title, paths, servers = [{ url: 'https://api.exemplo.gov.br/v1' }]) =>
  JSON.stringify({ openapi: '3.0.3', info: { title, version: '1.2.0', description: `API ${title}.` }, servers, paths });
const PROTOCOLO = spec('Protocolo', {
  '/processos': { get: { summary: 'Listar processos', responses: { 200: { description: 'ok' } } }, post: { summary: 'Abrir processo', responses: { 201: { description: 'criado' } } } },
});
const AGENDA = spec('Agenda', { '/eventos': { get: { summary: 'Listar eventos', responses: { 200: { description: 'ok' } } } } });

function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-import-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

describe('CATALOG_IMPORT', () => {
  test('links and files separated by commas or line breaks; relative files from the project root', () => {
    const list = parseSources('https://a.gov.br/openapi.json, specs/b.yaml\nhttps://c.gov.br/docs', '/srv');
    assert.deepEqual(list.map((e) => e.source), ['https://a.gov.br/openapi.json', path.resolve('/srv', 'specs/b.yaml'), 'https://c.gov.br/docs']);
    assert.deepEqual(parseSources('  '), []);
    assert.deepEqual(parseSources('catalogo-inicial/x.yaml'), [{ source: path.join(__dirname, '..', '..', 'catalogo-inicial', 'x.yaml') }]);
  });

  test('a manifest sets each API; its paths are relative to it', () => {
    const dir = folder({ 'conf/catalogo.json': JSON.stringify([{ source: '../specs/a.json', category: 'Documentos' }, 'https://b.gov.br/openapi.json']) });
    const list = parseSources('conf/catalogo.json', dir);
    assert.deepEqual(list, [
      { source: path.join(dir, 'specs', 'a.json'), category: 'Documentos' },
      { source: 'https://b.gov.br/openapi.json' },
    ]);
    assert.deepEqual(parseSources(path.join(dir, 'conf/catalogo.json')).length, 2, 'absolute path too');
  });

  test('an OpenAPI document in JSON is a source, not a manifest; a bad manifest is explained', () => {
    const dir = folder({ 'protocolo.json': PROTOCOLO, 'ruim.json': '{"lista": []}', 'quebrado.json': '[{"category": "x"}]' });
    assert.deepEqual(parseSources('protocolo.json', dir), [{ source: path.join(dir, 'protocolo.json') }]);
    assert.throws(() => parseSources('ruim.json', dir), /deve ser uma lista/);
    assert.throws(() => parseSources('quebrado.json', dir), /item 1: falta "source"/);
  });
});

describe('converting a document', { skip }, () => {
  const bare = (servers) => JSON.stringify({ openapi: '3.0.0', info: { title: 'Pet', version: '1' }, ...(servers ? { servers } : {}), paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } } });

  test('a document without description gets a summary', () => {
    assert.equal(toInput(bare([{ url: 'https://a.gov.br' }]), { source: 'x' }).summary, 'Documentação da API Pet.');
  });

  test('relative "servers" are resolved from where the document came from', () => {
    const input = toInput(bare([{ url: '/api/v3' }]), { source: 'x' }, 'https://docs.exemplo.gov.br/api/v3/openapi.json');
    assert.equal(input.baseUrl, 'https://docs.exemplo.gov.br/api/v3');
    assert.equal(input.environments[0].url, 'https://docs.exemplo.gov.br/api/v3');
  });

  test('without "servers": the address of the link, the baseUrl of the manifest, or a clear error', () => {
    assert.equal(toInput(bare(), { source: 'x' }, 'https://docs.exemplo.gov.br/openapi.json').baseUrl, 'https://docs.exemplo.gov.br');
    assert.equal(toInput(bare(), { source: 'x', baseUrl: 'https://api.exemplo.gov.br/v2' }).baseUrl, 'https://api.exemplo.gov.br/v2');
    assert.throws(() => toInput(bare(), { source: 'x' }), /informe "baseUrl"/);
  });
});

describe('first start', { skip }, () => {
  let upstream;
  let specs;
  let dataDir;
  const envFor = (value) => ({ CATALOG_IMPORT: value, DATA_FILE: path.join(dataDir, 'apis.json'), ADMIN_EMAIL: 'admin@exemplo.gov.br', ADMIN_PASSWORD: 'senha-do-admin-123' });

  before(async () => {
    // A documentation server: the spec lives at /v3/api-docs; the link given is the page.
    upstream = http.createServer((req, res) => {
      if (req.url === '/v3/api-docs') return res.writeHead(200, { 'content-type': 'application/json' }).end(AGENDA);
      res.writeHead(404).end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    specs = folder({
      'specs/protocolo.json': PROTOCOLO,
      'catalogo.json': JSON.stringify([
        { source: 'specs/protocolo.json', category: 'Documentos', owner: 'Time do Protocolo', tags: ['processos'], visibility: 'private', groups: ['servidores'] },
        { source: `http://127.0.0.1:${portOf(upstream)}/v3/api-docs`, category: 'Agenda' },
        'specs/nao-existe.yaml',
      ]),
    });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-dados-'));
  });
  after(() => upstream?.close());

  const login = async (server) => (await server.call('POST', '/api/auth/login', { body: { email: 'admin@exemplo.gov.br', password: 'senha-do-admin-123' } })).json.token;

  test('imports the sources in place of the sample APIs, with what the manifest sets', async () => {
    const server = await startServer({ env: envFor(path.join(specs, 'catalogo.json')), ready: /importação inicial\] 2 de 3/ });
    try {
      const admin = await login(server);
      const apis = (await server.call('GET', '/api/apis', { token: admin })).json;
      assert.deepEqual(apis.map((a) => a.name).sort(), ['Agenda', 'Protocolo'], 'no sample APIs');
      const protocolo = apis.find((a) => a.name === 'Protocolo');
      assert.equal(protocolo.category, 'Documentos');
      assert.equal(protocolo.owner, 'Time do Protocolo');
      assert.equal(protocolo.visibility, 'private');
      assert.deepEqual(protocolo.groups, ['servidores']);
      assert.ok(protocolo.tags.includes('processos'));
      assert.equal(protocolo.endpoints.length, 2);
      assert.match(server.log(), /nao-existe\.yaml: Arquivo não encontrado/);

      // From a link: the OpenAPI sync is on, with the imported document as the applied version.
      const agenda = apis.find((a) => a.name === 'Agenda');
      const sync = (await server.call('GET', `/api/apis/${agenda.id}/sync`, { token: admin })).json;
      assert.equal(sync.configured, true);
      assert.match(sync.url, /\/v3\/api-docs$/);
      assert.equal(sync.pending, false);
      const history = (await server.call('GET', `/api/apis/${agenda.id}/versions`, { token: admin })).json;
      assert.match(history[0].note, /Importada de http/);

      // An API deleted afterwards does not come back.
      assert.equal((await server.call('DELETE', `/api/apis/${agenda.id}`, { token: admin })).status, 204);
    } finally {
      await server.stop();
    }
  });

  test('only on the first start', async () => {
    const server = await startServer({ env: envFor(path.join(specs, 'catalogo.json')) });
    try {
      await new Promise((r) => setTimeout(r, 500));
      assert.doesNotMatch(server.log(), /importação inicial/);
      const admin = await login(server);
      assert.deepEqual((await server.call('GET', '/api/apis', { token: admin })).json.map((a) => a.name), ['Protocolo']);
    } finally {
      await server.stop();
    }
  });

  test('when every source fails, it tries again on the next start', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogo-dados-'));
    const env = { ...envFor('http://127.0.0.1:1/openapi.json'), DATA_FILE: path.join(empty, 'apis.json') };
    let server = await startServer({ env, ready: /tento de novo/ });
    await server.stop();
    server = await startServer({ env: { ...env, CATALOG_IMPORT: path.join(specs, 'specs', 'protocolo.json') }, ready: /1 de 1 API/ });
    try {
      // Imported straight from the file (no manifest): public, like an API created in the admin.
      assert.deepEqual((await server.call('GET', '/api/apis')).json.map((a) => a.name), ['Protocolo']);
    } finally {
      await server.stop();
    }
  });
});

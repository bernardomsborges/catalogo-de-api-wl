// Import of OpenAPI 3 / Swagger 2 documents into the catalog, and export back to OpenAPI.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exportOpenApi, importOpenApi } from '../src/app/core/openapi';
import { catalogApi, SPEC } from './fixtures';

describe('importOpenApi', () => {
  const api = importOpenApi(SPEC);
  const ep = (route: string) => api.endpoints.find((e) => `${e.method} ${e.path}` === route)!;

  test('reads the info block and the servers', () => {
    assert.equal(api.name, 'API de Processos');
    assert.equal(api.version, '2.3.1');
    assert.equal(api.owner, 'Time de Processos');
    assert.equal(api.contactEmail, 'processos@exemplo.gov.br');
    assert.equal(api.baseUrl, 'https://api.exemplo.gov.br');
    assert.deepEqual(api.environments.map((e) => e.name), ['Produção', 'Homologação']);
  });

  test('keeps every credential, used together', () => {
    assert.deepEqual(api.auth.schemes!.map((s) => [s.key, s.type, s.name]), [
      ['ClientId', 'apiKey', 'X-Client-Id'],
      ['Sessao', 'bearer', ''],
    ]);
    assert.equal(api.auth.mode, 'all');
    assert.equal(api.auth.defaults, undefined);
  });

  test('finds the routes that open and close the session', () => {
    const bearer = api.auth.schemes!.find((s) => s.type === 'bearer')!;
    assert.equal(bearer.tokenEndpoint, 'POST /v1/sessoes');
    assert.equal(bearer.logoutEndpoint, 'DELETE /v1/sessoes/atual');
  });

  test('stores only the routes with their own credential rule', () => {
    assert.deepEqual(ep('POST /v1/sessoes').security, ['ClientId']);
    assert.deepEqual(ep('GET /v1/status').security, []);
    assert.equal(ep('GET /v1/processos/{id}').security, undefined);
  });

  test('leaves out header parameters that repeat a credential', () => {
    assert.deepEqual(ep('GET /v1/processos/{id}').parameters.map((p) => `${p.in}:${p.name}`), ['path:id', 'query:campos']);
  });

  test('builds examples from the schemas, following $ref', () => {
    assert.deepEqual(JSON.parse(ep('POST /v1/sessoes').requestBody), { usuario: 'maria', senha: 'segredo' });
    const ok = ep('GET /v1/processos/{id}').responses.find((r) => r.status === 200)!;
    assert.deepEqual(JSON.parse(ok.body), { id: 42, numero: '0001.2026', assunto: 'string' });
    assert.deepEqual(ep('GET /v1/processos/{id}').responses.map((r) => r.status), [200, 404]);
  });

  test('groups the routes by their first tag', () => {
    assert.equal(ep('POST /v1/sessoes').tag, 'Sessões');
    assert.equal(ep('GET /v1/status').tag, undefined);
  });

  test('Swagger 2: base URL from host and basePath, body parameter as the request body', () => {
    const swagger = importOpenApi(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'Antiga', version: '1' },
        host: 'legado.exemplo.gov.br',
        basePath: '/api',
        schemes: ['https'],
        securityDefinitions: { Basic: { type: 'basic' } },
        security: [{ Basic: [] }],
        paths: {
          '/itens': {
            post: {
              parameters: [{ in: 'body', name: 'body', schema: { type: 'object', properties: { nome: { type: 'string', example: 'Cadeira' } } } }],
              responses: { '201': { description: 'Criado', schema: { type: 'object', properties: { id: { type: 'integer' } } } } },
            },
          },
        },
      })
    );
    assert.equal(swagger.baseUrl, 'https://legado.exemplo.gov.br/api');
    assert.equal(swagger.auth.schemes![0].type, 'basic');
    assert.deepEqual(JSON.parse(swagger.endpoints[0].requestBody), { nome: 'Cadeira' });
    assert.deepEqual(JSON.parse(swagger.endpoints[0].responses[0].body), { id: 0 });
  });

  const twoKeys = (extraSchemas: object) =>
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Duas chaves', version: '1' },
      components: {
        securitySchemes: { A: { type: 'apiKey', in: 'header', name: 'X-A' }, B: { type: 'apiKey', in: 'header', name: 'X-B' } },
        schemas: extraSchemas,
      },
      paths: { '/x': { get: { security: [{ A: [] }, { B: [] }], responses: { '200': { description: 'OK' } } } } },
    });

  test('FastAPI: separate security items mean all of them, not one of them', () => {
    const fastApi = importOpenApi(twoKeys({ HTTPValidationError: {}, ValidationError: {} }));
    assert.equal(fastApi.auth.mode, 'all');
    assert.deepEqual(fastApi.auth.schemes!.map((s) => s.key), ['A', 'B']);
  });

  test('the same document without the FastAPI markers means one of them', () => {
    assert.equal(importOpenApi(twoKeys({})).auth.mode, 'any');
  });

  test('refuses something that is not a specification', () => {
    assert.throws(() => importOpenApi('{"openapi": "3.0.0"}'), /paths/);
    assert.throws(() => importOpenApi('isto não é um documento'), /paths/);
  });
});

describe('exportOpenApi', () => {
  test('exports a document that imports back the same', () => {
    const api = catalogApi();
    const doc = exportOpenApi(api);
    assert.equal(doc['openapi'], '3.0.3');
    const again = importOpenApi(JSON.stringify(doc));
    assert.deepEqual(
      again.endpoints.map((e) => [e.method, e.path, e.tag, e.security]),
      api.endpoints.map((e) => [e.method, e.path, e.tag, e.security])
    );
    assert.deepEqual(
      again.auth.schemes!.map((s) => [s.key, s.type, s.name, s.in]),
      api.auth.schemes!.map((s) => [s.key, s.type, s.name, s.in])
    );
    assert.equal(again.auth.mode, api.auth.mode);
    assert.deepEqual(again.environments, api.environments);
    const ok = (a: { endpoints: { responses: { body: string }[] }[] }) => JSON.parse(a.endpoints[3].responses[0].body);
    assert.deepEqual(ok(again), ok(api));
  });

  test('one-of credentials become one security option each', () => {
    const api = catalogApi();
    api.auth.mode = 'any';
    assert.deepEqual(exportOpenApi(api)['security'], [{ ClientId: [] }, { Sessao: [] }]);
  });
});

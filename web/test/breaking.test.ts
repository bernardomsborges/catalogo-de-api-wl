// Changes that break whoever already uses an API, from OpenAPI documents and from catalog entries.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dump, load } from 'js-yaml';
import { bumpVersion, changelogNotes, compareModels, modelFromApi, modelFromSpecText } from '../src/app/core/breaking';
import { catalogApi, SPEC } from './fixtures';

/** Compares the fixture document with a copy changed by `edit`. */
function report(edit: (spec: any) => void) {
  const spec = load(SPEC) as any;
  edit(spec);
  return compareModels(modelFromSpecText(SPEC), modelFromSpecText(dump(spec)));
}

const texts = (list: { route: string; text: string }[]) => list.map((c) => `${c.route} | ${c.text}`);

describe('compareModels with OpenAPI documents', () => {
  test('the same document has no changes', () => {
    const r = report(() => {});
    assert.deepEqual([r.breaking, r.compatible], [[], []]);
    assert.equal(r.precise, true);
  });

  test('a removed route breaks', () => {
    const r = report((s) => delete s.paths['/v1/status']);
    assert.deepEqual(texts(r.breaking), ['GET /v1/status | Rota removida']);
  });

  test('a new route is compatible', () => {
    const r = report((s) => (s.paths['/v1/novo'] = { get: { responses: { '200': { description: 'OK' } } } }));
    assert.deepEqual(r.breaking, []);
    assert.deepEqual(texts(r.compatible), ['GET /v1/novo | Rota nova']);
  });

  test('a parameter that becomes required breaks; a new optional one does not', () => {
    const r = report((s) => {
      const params = s.paths['/v1/processos/{id}'].get.parameters;
      params.find((p: any) => p.name === 'campos').required = true;
      params.push({ name: 'pagina', in: 'query', schema: { type: 'integer' } });
    });
    assert.deepEqual(texts(r.breaking), ['GET /v1/processos/{id} | parâmetro `campos` (query) passou a ser obrigatório']);
    assert.deepEqual(texts(r.compatible), ['GET /v1/processos/{id} | novo parâmetro opcional `pagina` (query)']);
  });

  test('a parameter that changes type breaks', () => {
    const r = report((s) => (s.paths['/v1/processos/{id}'].get.parameters[0].schema.type = 'string'));
    assert.deepEqual(texts(r.breaking), ['GET /v1/processos/{id} | parâmetro `id` (path) mudou de tipo (number → string)']);
  });

  test('a new required body field breaks; a new optional one does not', () => {
    const r = report((s) => {
      const schema = s.paths['/v1/sessoes'].post.requestBody.content['application/json'].schema;
      schema.properties.otp = { type: 'string' };
      schema.required.push('otp');
      schema.properties.lembrar = { type: 'boolean' };
    });
    assert.deepEqual(texts(r.breaking), ['POST /v1/sessoes | corpo: novo campo obrigatório `otp`']);
    assert.deepEqual(texts(r.compatible), ['POST /v1/sessoes | corpo: novo campo opcional `lembrar`']);
  });

  test('response fields: removed, retyped or no longer guaranteed break; new ones do not', () => {
    const r = report((s) => {
      const p = s.components.schemas.Processo;
      delete p.properties.assunto;
      p.properties.id.type = 'string';
      p.required = ['id'];
      p.properties.criadoEm = { type: 'string' };
    });
    assert.deepEqual(texts(r.breaking).sort(), [
      'GET /v1/processos/{id} | resposta 200: campo `assunto` removido',
      'GET /v1/processos/{id} | resposta 200: campo `id` mudou de tipo (number → string)',
      'GET /v1/processos/{id} | resposta 200: campo `numero` pode deixar de vir',
    ]);
    assert.deepEqual(texts(r.compatible), ['GET /v1/processos/{id} | resposta 200: novo campo `criadoEm`']);
  });

  test('a removed success status breaks; a removed error status does not', () => {
    const r = report((s) => {
      const res = s.paths['/v1/processos/{id}'].get.responses;
      delete res['404'];
      res['201'] = res['200'];
      delete res['200'];
    });
    assert.deepEqual(texts(r.breaking), ['GET /v1/processos/{id} | resposta 200 removida']);
    assert.deepEqual(texts(r.compatible), ['GET /v1/processos/{id} | nova resposta 201']);
  });

  test('a route that starts asking for credentials breaks; one that stops asking does not', () => {
    const r = report((s) => {
      delete s.paths['/v1/status'].get.security;
      s.paths['/v1/sessoes'].post.security = [];
    });
    assert.deepEqual(texts(r.breaking), ['GET /v1/status | passa a exigir a credencial `ClientId` + `Sessao`']);
    assert.deepEqual(texts(r.compatible), ['POST /v1/sessoes | deixou de exigir credencial']);
  });

  test('a credential redefined under the same name breaks', () => {
    const r = report((s) => (s.components.securitySchemes.ClientId.name = 'X-Sistema'));
    assert.deepEqual(texts(r.breaking), [' | Credencial `ClientId` trocada: apiKey X-Client-Id (header) → apiKey X-Sistema (header)']);
  });
});

describe('compareModels with catalog entries', () => {
  test('a field removed from the response example breaks', () => {
    const after = catalogApi();
    after.endpoints[3].responses[0].body = JSON.stringify({ id: 42, numero: '0001.2026' });
    const r = compareModels(modelFromApi(catalogApi()), modelFromApi(after));
    assert.equal(r.precise, false);
    assert.deepEqual(texts(r.breaking), ['GET /v1/processos/{id} | resposta 200: campo `assunto` removido']);
  });

  test('without "required" in the examples, a new body field is only compatible', () => {
    const after = catalogApi();
    after.endpoints[0].requestBody = JSON.stringify({ usuario: 'maria', senha: 'segredo', otp: '123' });
    const r = compareModels(modelFromApi(catalogApi()), modelFromApi(after));
    assert.deepEqual(r.breaking, []);
    assert.deepEqual(texts(r.compatible), ['POST /v1/sessoes | corpo: novo campo opcional `otp`']);
  });

  test('one-of credentials: dropping an option breaks the routes that accepted it', () => {
    const before = catalogApi({ auth: { ...catalogApi().auth, mode: 'any' } });
    const after = catalogApi({ auth: { ...before.auth, schemes: before.auth.schemes!.filter((s) => s.key === 'Sessao') } });
    const r = compareModels(modelFromApi(before), modelFromApi(after));
    // Whoever sent only X-Client-Id now has to send the session token.
    assert.deepEqual(texts(r.breaking), [
      'DELETE /v1/sessoes/atual | passa a exigir a credencial `Sessao`',
      'GET /v1/processos/{id} | passa a exigir a credencial `Sessao`',
    ]);
  });
});

describe('version and changelog suggestion', () => {
  test('bumpVersion: major when it breaks, minor otherwise', () => {
    assert.equal(bumpVersion('2.3.1', true), '3.0.0');
    assert.equal(bumpVersion('2.3.1', false), '2.4.0');
    assert.equal(bumpVersion('v1', false), 'v1.1.0');
    assert.equal(bumpVersion('', true), '2.0.0');
  });

  test('changelogNotes: one block per kind, with a limit', () => {
    const r = report((s) => {
      delete s.paths['/v1/status'];
      s.paths['/v1/novo'] = { get: { responses: { '200': { description: 'OK' } } } };
    });
    assert.equal(changelogNotes(r), '**Quebra integrações**\n- `GET /v1/status`: Rota removida\n\n**Compatível**\n- `GET /v1/novo`: Rota nova');
    const many = { breaking: [], compatible: Array.from({ length: 4 }, (_, i) => ({ breaking: false, route: '', text: `m${i}` })), precise: true };
    assert.equal(changelogNotes(many, 2), '**Compatível**\n- m0\n- m1\n- … e mais 2');
  });
});

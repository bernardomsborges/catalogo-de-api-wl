// Documentation quality score (0–100) and the gaps "Melhorar com IA" fills.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { aiGaps, COMPLETE_SCORE, docQuality, findGaps, isPlaceholderBody, looksEnglish, missingResponses, recipesUsing } from '../../shared/doc-quality';
import { catalogApi } from './fixtures';

const DESCRIPTION =
  'Abre, consulta e acompanha processos administrativos do Estado. Use para integrar sistemas que precisam criar processos e ler o andamento deles.';

/** The fixture with everything the score asks for filled in. */
function complete() {
  const api = catalogApi({ description: DESCRIPTION });
  api.auth.instructions = 'Peça o identificador ao time pelo e-mail de contato.';
  api.auth.schemes!.forEach((s) => (s.description ||= 'Credencial da API.'));
  api.guides = [{ title: 'Primeiros passos', content: 'Entre e consulte.' }];
  for (const ep of api.endpoints) {
    ep.summary = ep.summary === 'Status' ? 'Ver se a API está no ar' : ep.summary;
    ep.description = `Descrição de ${ep.method} ${ep.path} para quem integra.`;
    ep.parameters.forEach((p) => {
      p.description = `Parâmetro ${p.name} da consulta.`;
      p.example ||= 'numero,assunto';
    });
    ep.responses.forEach((r) => {
      if (r.status === 200 && !r.body) r.body = '{"situacao": "no ar"}';
    });
    if (!ep.responses.some((r) => r.status >= 400)) ep.responses.push({ status: 500, description: 'Erro interno da API.', body: '' });
  }
  const ok = api.endpoints[3].responses[0];
  ok.body = JSON.stringify({ id: 42, numero: '0001.2026', assunto: 'Compra de cadeiras' });
  return api;
}

describe('docQuality', () => {
  test('a complete documentation scores 100 with nothing pending', () => {
    const q = docQuality(complete());
    const pending = q.items.flatMap((i) => i.pending.map((p) => p.label));
    assert.deepEqual(pending, []);
    assert.equal(q.score, 100);
  });

  test('an empty API scores low and says what to do first', () => {
    const q = docQuality({});
    assert.ok(q.score < 30, `nota ${q.score}`);
    assert.ok(q.items.find((i) => i.key === 'titulos')!.pending.some((p) => p.target === 'endpoints'));
  });

  test('anything pending keeps the score below 100', () => {
    const api = complete();
    api.endpoints[0].parameters.push({ name: 'x', in: 'query', type: 'string', required: false, description: 'Filtro x da busca.', example: '' });
    const q = docQuality(api);
    assert.equal(q.pendingCount, 1);
    assert.equal(q.score, 98); // parameters weigh 10: 4 of 5 checks → 8

    // Even when the rounding would give 100, the score stops at 99.
    const almost = complete();
    for (let i = 0; i < 300; i++) almost.endpoints[3].parameters.push({ name: `p${i}`, in: 'query', type: 'string', required: false, description: 'Filtro da busca.', example: 'x' });
    almost.endpoints[3].parameters[0].example = '';
    assert.equal(docQuality(almost).score, 99);
  });

  test('each item weighs its share; a missing contact costs its 10 points', () => {
    const api = complete();
    api.owner = '';
    api.contactEmail = 'sem-email';
    const q = docQuality(api);
    assert.equal(q.items.find((i) => i.key === 'contato')!.points, 0);
    assert.equal(q.score, 90);
    assert.ok(q.score >= COMPLETE_SCORE);
  });

  test('a ReceAPIto counts as a guide', () => {
    const api = complete();
    api.guides = [];
    assert.equal(docQuality(api).items.find((i) => i.key === 'guias')!.pending.length, 1);
    assert.equal(docQuality(api, { recipes: 1 }).score, 100);
  });

  test('an API without credentials gets the credential points', () => {
    const api = complete();
    api.auth = { type: 'none', headerName: '', tokenUrl: '', scopes: '', instructions: '', schemes: [], mode: 'all' };
    const item = docQuality(api).items.find((i) => i.key === 'credenciais')!;
    assert.equal(item.notApplicable, true);
    assert.equal(item.points, item.weight);
  });

  test('a generated response example ("string", 0) does not count', () => {
    const api = complete();
    api.endpoints[3].responses[0].body = JSON.stringify({ id: 0, numero: 'string', assunto: 'string' });
    const pending = docQuality(api).items.find((i) => i.key === 'sucesso')!.pending;
    assert.deepEqual(pending.map((p) => p.target), ['endpoints[3].responses[0].body']);
    assert.match(pending[0].label, /genérico/);
  });

  test('titles and texts in English must be translated', () => {
    const api = complete();
    api.endpoints[2].summary = 'Get Health Status';
    api.endpoints[2].responses[0].description = 'Successful Response';
    const labels = docQuality(api).items.flatMap((i) => i.pending.map((p) => p.label));
    assert.ok(labels.includes('GET /v1/status: título em inglês ("Get Health Status")'), labels.join('\n'));
    assert.ok(labels.some((l) => l.includes('resposta 200 com texto genérico ou em inglês')), labels.join('\n'));
  });
});

describe('gaps and helpers', () => {
  test('looksEnglish: FastAPI titles yes, Portuguese titles no', () => {
    for (const t of ['List Units', 'Get Process By Id', 'Dashboard']) assert.equal(looksEnglish(t), true, t);
    for (const t of ['Listar unidades', 'Consultar processo', 'Ranking de órgãos', 'Dados do usuário']) assert.equal(looksEnglish(t), false, t);
  });

  test('isPlaceholderBody: schema-generated examples vs. real ones', () => {
    assert.equal(isPlaceholderBody('{"id": 0, "nome": "string", "email": "user@example.com"}'), true);
    assert.equal(isPlaceholderBody('{"id": 42, "nome": "Maria", "email": "maria@exemplo.gov.br"}'), false);
    assert.equal(isPlaceholderBody('não é JSON'), false);
  });

  test('findGaps limited to some routes skips the API texts', () => {
    const gaps = findGaps(catalogApi(), [3]);
    assert.ok(gaps.length > 0);
    assert.ok(gaps.every((g) => g.target.startsWith('endpoints[3]')), gaps.map((g) => g.target).join('\n'));
  });

  test('aiGaps adds examples and credential texts, never for a 204', () => {
    const api = catalogApi();
    api.auth.schemes![0].description = '';
    const targets = aiGaps(api).map((g) => g.target);
    assert.ok(targets.includes('auth.instructions'));
    assert.ok(targets.includes('auth.schemes[0].description'));
    assert.ok(!targets.includes('auth.schemes[1].description')); // the import already says where the token comes from
    assert.ok(targets.includes('endpoints[3].parameters[1].example'));
    assert.ok(targets.includes('endpoints[2].responses[0].body'));
    assert.ok(!targets.includes('endpoints[1].responses[0].body'));
  });

  test('missingResponses proposes the usual errors for routes without any', () => {
    const proposals = missingResponses(catalogApi());
    const status = (route: number) => proposals.find((p) => p.endpoint === route)?.add.map((r) => r.status);
    assert.deepEqual(status(0), [400, 401, 500]); // body + credentials
    assert.deepEqual(status(2), [500]); // public, no data sent
    assert.equal(status(3), undefined); // already has 200 and 404
  });

  test('recipesUsing counts by id or by slug', () => {
    const recipes = [{ steps: [{ apiId: 'api-processos' }] }, { steps: [{ apiId: 'outra', apiSlug: 'processos' }] }, { steps: [{ apiId: 'outra' }] }];
    assert.equal(recipesUsing({ id: 'api-processos', slug: 'processos' }, recipes), 2);
  });
});

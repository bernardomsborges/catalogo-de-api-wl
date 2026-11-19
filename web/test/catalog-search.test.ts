// Catalog search also by routes and descriptions (PRO-206).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointAnchor, matchApi } from '../src/app/core/catalog-search';
import { Api } from '../src/app/core/models';

const ep = (method: string, path: string, summary: string, description = '', tag?: string) => ({ id: path, method, path, summary, description, tag, parameters: [], requestBody: '', responses: [] });
const sei = {
  id: 'sei',
  name: 'SEI',
  summary: 'Processos eletrônicos.',
  description: 'Integra sistemas ao **Sistema Eletrônico de Informações**.',
  category: 'Documentos',
  owner: 'Time do SEI',
  tags: ['protocolo'],
  endpoints: [
    ep('POST', '/processos/{id}/documentos', 'Anexar documento', 'Inclui um PDF no processo.', 'Documentos'),
    ep('GET', '/processos/{id}', 'Consultar processo'),
    ep('POST', '/processos', 'Abrir processo', 'Cria o processo e devolve o número.'),
  ],
} as unknown as Api;
const routes = (q: string) => matchApi(sei, q)?.routes.map((r) => r.summary) ?? null;

describe('catalog search', () => {
  test("the API's own texts, description included, match without pointing to a route", () => {
    assert.deepEqual(routes('sei'), []);
    assert.deepEqual(routes('informacoes'), [], 'without accents, from the description');
    assert.deepEqual(routes('protocolo'), []);
  });

  test('a route matches by its title, path or description, and is pointed out', () => {
    assert.deepEqual(routes('anexar documento'), ['Anexar documento']);
    assert.deepEqual(routes('/documentos'), ['Anexar documento']);
    assert.deepEqual(routes('pdf'), ['Anexar documento']);
    assert.deepEqual(routes('numero'), ['Abrir processo']);
    assert.deepEqual(routes('processo'), [], 'in the summary of the API: no route needed');
  });

  test("words can mix the API's texts and a route", () => {
    assert.deepEqual(routes('sei anexar'), ['Anexar documento']);
    assert.deepEqual(routes('consultar'), ['Consultar processo']);
  });

  test('nothing matches', () => {
    assert.equal(routes('boleto'), null);
    assert.equal(routes('anexar boleto'), null);
  });

  test('an API the person cannot open has no routes or description to match', () => {
    const locked = { ...sei, description: '', endpoints: [], locked: true } as Api;
    assert.equal(matchApi(locked, 'anexar'), null);
    assert.equal(matchApi(locked, 'informacoes'), null);
    assert.deepEqual(matchApi(locked, 'sei')?.routes, []);
  });

  test('the anchor of a route on the reference page', () => {
    assert.equal(endpointAnchor({ method: 'POST', path: '/processos/{id}/documentos' }), 'ep-post-processos-id-documentos');
  });
});

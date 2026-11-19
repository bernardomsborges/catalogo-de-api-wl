// Title, description and preview tags when a link is shared (PRO-199).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewFor, renderIndex } = require('../src/link-preview');
const { startServer } = require('./helpers');

const APIS = { sei: { name: 'SEI', summary: 'Processos   eletrônicos\n do Estado.' } };
const RECIPES = { 'abrir-processo': { title: 'Abrir um processo', goal: 'Criar um processo e anexar um documento.' } };
const lookups = { findApi: (s) => APIS[s], findRecipe: (s) => RECIPES[s] };

describe('rules', () => {
  test('an API, also on its tabs, with the summary in one line', () => {
    for (const p of ['/apis/sei', '/apis/sei/endpoints']) {
      const r = previewFor(p, lookups);
      assert.match(r.title, /^SEI · /);
      assert.equal(r.description, 'Processos eletrônicos do Estado.');
    }
  });

  test('a ReceAPIto, by the new and the old address', () => {
    for (const p of ['/receapitos/abrir-processo', '/receitas/abrir-processo']) {
      assert.equal(previewFor(p, lookups).description, 'Criar um processo e anexar um documento.');
    }
  });

  test('unknown or hidden pages get the site preview, not an error', () => {
    for (const p of ['/apis/nao-existe', '/receapitos/privado', '/admin/editar/1', '/apis/%E0%A4%A']) {
      assert.equal(previewFor(p, lookups).title, 'Catálogo de APIs · Automatiza.MG');
    }
  });

  test('long summaries are cut', () => {
    const r = previewFor('/apis/x', { findApi: () => ({ name: 'X', summary: 'a'.repeat(500) }), findRecipe: () => null });
    assert.equal(r.description.length, 200);
    assert.ok(r.description.endsWith('…'));
  });

  test('the tags escape what people typed', () => {
    const html = '<html><head><title>x</title><meta name="description" content="y"></head><body></body></html>';
    const out = renderIndex(html, { title: '<script>"a"</script>', description: "d'x", type: 'article' }, { url: 'https://c.gov.br/apis/a', origin: 'https://c.gov.br' });
    assert.doesNotMatch(out, /<script>"a"/);
    assert.match(out, /<title>&lt;script&gt;&quot;a&quot;&lt;\/script&gt;<\/title>/);
    assert.match(out, /<meta name="description" content="d&#39;x">/);
    assert.match(out, /<meta property="og:image" content="https:\/\/c.gov.br\/icon-512.png">/);
    assert.equal(out.match(/<title>/g).length, 1);
  });
});

const INDEX = path.join(__dirname, '..', '..', 'web', 'dist', 'web', 'browser', 'index.html');

describe('HTTP', { skip: !fs.existsSync(INDEX) && 'rode o build do portal antes' }, () => {
  const api = (slug, extra = {}) => ({
    id: `id-${slug}`,
    slug,
    name: `API ${slug}`,
    summary: `Resumo da ${slug}.`,
    description: `Descrição interna da ${slug}.`,
    category: 'Teste',
    tags: [],
    status: 'estavel',
    endpoints: [],
    visibility: 'public',
    groups: [],
    ...extra,
  });
  let server;
  before(async () => {
    server = await startServer({
      files: { 'apis.json': [api('aberta'), api('fechada', { visibility: 'private', groups: ['g-time'] })] },
      env: { ADMIN_PASSWORD: 'senha-do-admin-123', PUBLIC_URL: 'https://apis.exemplo.gov.br/' },
    });
  });
  after(() => server?.stop());

  const page = async (url) => (await server.call('GET', url)).text;

  test('the home page and an API page go out with their own tags', async () => {
    assert.match(await page('/'), /<meta property="og:title" content="Catálogo de APIs · Automatiza.MG">/);
    const html = await page('/apis/aberta');
    assert.match(html, /<title>API aberta · /);
    assert.match(html, /<meta property="og:description" content="Resumo da aberta.">/);
    assert.match(html, /<meta property="og:url" content="https:\/\/apis.exemplo.gov.br\/apis\/aberta">/);
  });

  test('a private API shows only its name and summary', async () => {
    const html = await page('/apis/fechada');
    assert.match(html, /<meta property="og:title" content="API fechada · /);
    assert.doesNotMatch(html, /Descrição interna/);
  });

  test('the page still loads the portal', async () => {
    assert.match(await page('/apis/aberta'), /<app-root><\/app-root>/);
  });
});

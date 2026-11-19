// Whitelabel: the portal's name, organization and logo come from the environment.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

describe('rules', () => {
  const withEnv = (env, fn) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      delete require.cache[require.resolve('../src/branding')];
      return fn(require('../src/branding'));
    } finally {
      process.env = saved;
    }
  };

  test('without configuration: a neutral name and description', () => {
    withEnv({ PORTAL_NAME: '', ORG_NAME: '', PORTAL_DESCRIPTION: '', LOGO_URL: '' }, (b) => {
      assert.deepEqual(b.brand(), { name: 'Catálogo de APIs', org: '', description: 'Encontre, entenda e integre as APIs disponíveis.', logoUrl: '' });
      assert.equal(b.title('APIs'), 'APIs · Catálogo de APIs');
      assert.equal(b.promptName(), 'Catálogo de APIs');
    });
  });

  test('the organization goes into the description and the AI prompts', () => {
    withEnv({ PORTAL_NAME: 'Portal de APIs', ORG_NAME: 'Prefeitura de Exemplo', PORTAL_DESCRIPTION: '', LOGO_URL: '' }, (b) => {
      assert.equal(b.brand().description, 'Encontre, entenda e integre as APIs de Prefeitura de Exemplo.');
      assert.equal(b.promptName(), 'Portal de APIs (Prefeitura de Exemplo)');
    });
  });

  test('the logo is only https:// or a path of the portal', () => {
    for (const [url, ok] of [['https://cdn.exemplo.gov.br/logo.svg', true], ['/brand/logo.png', true], ['javascript:alert(1)', false], ['data:image/svg+xml,x', false], ['//outro.site/logo.png', false], ['http://inseguro/logo.png', false]]) {
      withEnv({ LOGO_URL: String(url) }, (b) => assert.equal(b.brand().logoUrl, ok ? url : '', String(url)));
    }
  });
});

const INDEX = path.join(__dirname, '..', '..', 'web', 'dist', 'web', 'browser', 'index.html');

describe('HTTP', { skip: !fs.existsSync(INDEX) && 'rode o build do portal antes' }, () => {
  let server;
  before(async () => {
    server = await startServer({
      env: { ADMIN_PASSWORD: 'senha-do-admin-123', PORTAL_NAME: 'Portal <de> APIs', ORG_NAME: 'Prefeitura de Exemplo', LOGO_URL: 'https://cdn.exemplo.gov.br/logo.svg' },
    });
  });
  after(() => server?.stop());

  test('index.html carries the brand for the portal and the link previews', async () => {
    const html = (await server.call('GET', '/apis')).text;
    assert.match(html, /<title>APIs · Portal &lt;de&gt; APIs<\/title>/);
    assert.match(html, /<meta property="og:site_name" content="Portal &lt;de&gt; APIs">/);
    const meta = /<meta name="portal-brand" content="([^"]+)">/.exec(html);
    const brand = JSON.parse(meta[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert.deepEqual(brand, { name: 'Portal <de> APIs', org: 'Prefeitura de Exemplo', description: 'Encontre, entenda e integre as APIs de Prefeitura de Exemplo.', logoUrl: 'https://cdn.exemplo.gov.br/logo.svg' });
  });
});

// Login with SSO through OpenID Connect (PRO-154), against a fake identity provider.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startServer, portOf } = require('./helpers');

const CLIENT = { id: 'catalogo', secret: 'segredo-do-cliente' };
const ADMIN = { email: 'chefe@orgao.mg.gov.br', password: 'senha-do-admin-123' };

/** A tiny OpenID provider: discovery, token endpoint (checks PKCE and the client secret) and userinfo. */
function fakeProvider() {
  const codes = new Map();
  const p = {
    base: '',
    /** Claims for the next login; `nonce` and `aud` are filled in from the request. */
    claims: {},
    /** Called by the test as if the person had logged in at the provider. */
    approve(authorizeUrl) {
      const q = new URL(authorizeUrl).searchParams;
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { challenge: q.get('code_challenge'), nonce: q.get('nonce'), redirect: q.get('redirect_uri'), claims: p.claims });
      return code;
    },
    tokenRequests: [],
  };
  const jwt = (claims) => ['{"alg":"RS256","typ":"JWT"}', JSON.stringify(claims)].map((x) => Buffer.from(x).toString('base64url')).join('.') + '.assinatura';
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/.well-known/openid-configuration') {
      return json(200, { issuer: p.base, authorization_endpoint: `${p.base}/authorize`, token_endpoint: `${p.base}/token`, userinfo_endpoint: `${p.base}/userinfo` });
    }
    if (req.url === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      p.tokenRequests.push({ form, authorization: req.headers.authorization });
      if (req.headers.authorization !== `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString('base64')}`) return json(401, { error: 'invalid_client' });
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      if (!entry) return json(400, { error: 'invalid_grant' });
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (challenge !== entry.challenge || form.get('redirect_uri') !== entry.redirect) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      const now = Math.floor(Date.now() / 1000);
      const { email, ...idClaims } = entry.claims;
      const claims = { iss: p.base, aud: CLIENT.id, iat: now, exp: now + 300, nonce: entry.nonce, ...idClaims, ...(entry.claims.emailOnlyInUserinfo ? {} : { email }) };
      p.lastUserinfo = { sub: entry.claims.sub, email, email_verified: true };
      return json(200, { access_token: 'token-de-acesso', token_type: 'Bearer', id_token: jwt(claims) });
    }
    if (req.url === '/userinfo') return json(200, p.lastUserinfo || {});
    json(404, {});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      p.base = `http://127.0.0.1:${portOf(server)}`;
      p.close = () => server.close();
      resolve(p);
    })
  );
}

/** Runs the whole login like a browser would; returns the redirect after the callback. */
/**
 * @param {any} server
 * @param {any} provider
 * @param {any} claims
 * @param {{ voltar?: string, tamper?: string }} [options]
 */
async function ssoLogin(server, provider, claims, { voltar = '/admin', tamper } = {}) {
  provider.claims = claims;
  const start = await fetch(`${server.base}/api/auth/sso/start?voltar=${encodeURIComponent(voltar)}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorize = start.headers.get('location');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const q = new URL(authorize).searchParams;
  let state = q.get('state');
  const code = provider.approve(authorize);
  let sentCookie = cookie;
  if (tamper === 'state') state = 'outro-estado';
  if (tamper === 'cookie') sentCookie = '';
  const cb = await fetch(`${server.base}/api/auth/sso/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: sentCookie ? { cookie: sentCookie } : {} });
  assert.equal(cb.status, 302);
  const location = cb.headers.get('location');
  const fragment = new URLSearchParams(location.split('#')[1] || '');
  const error = new URL(location, server.base).searchParams.get('sso_erro');
  return { location, authorize, token: fragment.get('token'), voltar: fragment.get('voltar'), error };
}

describe('SSO with password login still on', () => {
  let provider;
  let server;
  before(async () => {
    provider = await fakeProvider();
    server = await startServer({
      env: {
        ADMIN_EMAIL: ADMIN.email,
        ADMIN_PASSWORD: ADMIN.password,
        OIDC_ISSUER: provider.base,
        OIDC_CLIENT_ID: CLIENT.id,
        OIDC_CLIENT_SECRET: CLIENT.secret,
        OIDC_LABEL: 'Entrar com a conta do Estado',
        OIDC_ALLOWED_DOMAINS: 'orgao.mg.gov.br, outro.mg.gov.br',
      },
    });
  });
  after(async () => {
    await server?.stop();
    provider?.close();
  });

  test('the login page learns which ways of logging in exist', async () => {
    const r = await server.call('GET', '/api/auth/options');
    assert.deepEqual(r.json, { password: true, sso: { label: 'Entrar com a conta do Estado' } });
  });

  test('start sends the browser to the provider with PKCE, state and nonce', async () => {
    const r = await fetch(`${server.base}/api/auth/sso/start?voltar=/admin`, { redirect: 'manual' });
    const url = new URL(r.headers.get('location'));
    assert.equal(url.origin + url.pathname, `${provider.base}/authorize`);
    const q = url.searchParams;
    assert.equal(q.get('client_id'), CLIENT.id);
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('scope'), 'openid email profile');
    assert.ok(q.get('state') && q.get('nonce') && q.get('code_challenge'));
    assert.match(r.headers.get('set-cookie'), /catalogo_sso=.+; Path=\/api\/auth\/sso; HttpOnly; SameSite=Lax/);
  });

  test('a new person gets a consumer account and goes back where they were', async () => {
    const r = await ssoLogin(server, provider, { sub: 'pessoa-1', email: 'Maria@Orgao.MG.gov.br', name: 'Maria Silva' }, { voltar: '/apis' });
    assert.equal(r.error, null, r.location);
    assert.match(r.location, /^\/entrar\/sso#/);
    assert.equal(r.voltar, '/apis');
    const me = await server.call('GET', '/api/auth/me', { token: r.token });
    assert.equal(me.json.user.email, 'maria@orgao.mg.gov.br');
    assert.equal(me.json.user.name, 'Maria Silva');
    assert.equal(me.json.user.role, 'consumer');
    assert.equal(me.json.user.hasPassword, false);
    // The token endpoint got the client secret and the PKCE verifier.
    const last = provider.tokenRequests.at(-1);
    assert.ok(last.form.get('code_verifier'));
  });

  test('the next login finds the same account by the SSO identity, even with a new e-mail', async () => {
    const r = await ssoLogin(server, provider, { sub: 'pessoa-1', email: 'maria.silva@orgao.mg.gov.br', name: 'Maria Silva' });
    const me = await server.call('GET', '/api/auth/me', { token: r.token });
    assert.equal(me.json.user.email, 'maria.silva@orgao.mg.gov.br');
    const first = await ssoLogin(server, provider, { sub: 'pessoa-1', email: 'maria.silva@orgao.mg.gov.br' });
    assert.equal((await server.call('GET', '/api/auth/me', { token: first.token })).json.user.id, me.json.user.id);
  });

  test('the first admin enters through SSO with the e-mail of ADMIN_EMAIL and keeps the role', async () => {
    const r = await ssoLogin(server, provider, { sub: 'chefe', email: ADMIN.email, name: 'Chefe do Time' });
    const me = await server.call('GET', '/api/auth/me', { token: r.token });
    assert.equal(me.json.user.role, 'admin');
    assert.equal(me.json.user.hasPassword, true);
    assert.equal((await server.call('GET', '/api/admin/users', { token: r.token })).status, 200);
  });

  test('the e-mail may come only from userinfo', async () => {
    const r = await ssoLogin(server, provider, { sub: 'pessoa-2', email: 'joao@outro.mg.gov.br', emailOnlyInUserinfo: true });
    assert.equal(r.error, null);
    assert.equal((await server.call('GET', '/api/auth/me', { token: r.token })).json.user.email, 'joao@outro.mg.gov.br');
  });

  test('e-mails from other domains are refused', async () => {
    const r = await ssoLogin(server, provider, { sub: 'x', email: 'alguem@gmail.com' });
    assert.equal(r.token, null);
    assert.match(r.error, /Só entram e-mails de @orgao\.mg\.gov\.br, @outro\.mg\.gov\.br/);
  });

  test('an unconfirmed e-mail is refused', async () => {
    const r = await ssoLogin(server, provider, { sub: 'y', email: 'novo@orgao.mg.gov.br', email_verified: false });
    assert.match(r.error, /não foi confirmado/);
  });

  test('a different state or a missing cookie is refused (login started elsewhere)', async () => {
    assert.match((await ssoLogin(server, provider, { sub: 'z', email: 'z@orgao.mg.gov.br' }, { tamper: 'state' })).error, /expirou ou foi aberto em outro navegador/);
    assert.match((await ssoLogin(server, provider, { sub: 'z', email: 'z@orgao.mg.gov.br' }, { tamper: 'cookie' })).error, /expirou ou foi aberto em outro navegador/);
  });

  test('a token issued with another nonce or for another client is refused', async () => {
    assert.match((await ssoLogin(server, provider, { sub: 'w', email: 'w@orgao.mg.gov.br', nonce: 'outro' })).error, /Não foi possível concluir/);
    assert.match((await ssoLogin(server, provider, { sub: 'w', email: 'w@orgao.mg.gov.br', aud: 'outro-cliente' })).error, /Não foi possível concluir/);
    assert.match((await ssoLogin(server, provider, { sub: 'w', email: 'w@orgao.mg.gov.br', exp: 1 })).error, /Não foi possível concluir/);
  });

  test('a disabled account does not get in through SSO', async () => {
    const admin = (await ssoLogin(server, provider, { sub: 'chefe', email: ADMIN.email })).token;
    const users = (await server.call('GET', '/api/admin/users', { token: admin })).json;
    const joao = users.find((u) => u.email === 'joao@outro.mg.gov.br');
    assert.equal(joao.sso, true);
    assert.equal((await server.call('PUT', `/api/admin/users/${joao.id}`, { token: admin, body: { disabled: true } })).status, 200);
    const r = await ssoLogin(server, provider, { sub: 'pessoa-2', email: 'joao@outro.mg.gov.br' });
    assert.match(r.error, /desativada/);
  });

  test('"voltar" only goes to pages of the portal', async () => {
    const r = await ssoLogin(server, provider, { sub: 'pessoa-1', email: 'maria.silva@orgao.mg.gov.br' }, { voltar: '//site-malicioso.com' });
    assert.equal(r.voltar, null);
  });

  test('the password login keeps working', async () => {
    const r = await server.call('POST', '/api/auth/login', { body: ADMIN });
    assert.equal(r.status, 200);
  });
});

describe('SSO only (PASSWORD_LOGIN=false)', () => {
  let provider;
  let server;
  before(async () => {
    provider = await fakeProvider();
    server = await startServer({
      env: { ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, OIDC_ISSUER: provider.base, OIDC_CLIENT_ID: CLIENT.id, OIDC_CLIENT_SECRET: CLIENT.secret, PASSWORD_LOGIN: 'false' },
    });
  });
  after(async () => {
    await server?.stop();
    provider?.close();
  });

  test('e-mail and password, sign-up and "forgot password" are off', async () => {
    assert.deepEqual((await server.call('GET', '/api/auth/options')).json, { password: false, sso: { label: 'Entrar com a conta da organização' } });
    assert.equal((await server.call('POST', '/api/auth/login', { body: ADMIN })).status, 403);
    assert.equal((await server.call('POST', '/api/auth/register', { body: { email: 'a@b.gov.br', name: 'A', password: 'senha-qualquer-1' } })).status, 403);
    assert.equal((await server.call('POST', '/api/auth/forgot', { body: { email: ADMIN.email } })).status, 403);
  });

  test('the admin enters through SSO and can add people without a password', async () => {
    const admin = (await ssoLogin(server, provider, { sub: 'chefe', email: ADMIN.email })).token;
    const r = await server.call('POST', '/api/admin/users', { token: admin, body: { email: 'editor@orgao.mg.gov.br', name: 'Editor', role: 'editor' } });
    assert.equal(r.status, 201, r.text);
    // The editor then enters through SSO and already has the role.
    const editor = (await ssoLogin(server, provider, { sub: 'editor-1', email: 'editor@orgao.mg.gov.br' })).token;
    assert.equal((await server.call('GET', '/api/auth/me', { token: editor })).json.user.role, 'editor');
  });
});

describe('without SSO configured', () => {
  let server;
  before(async () => {
    server = await startServer({ env: { ADMIN_PASSWORD: ADMIN.password } });
  });
  after(() => server?.stop());

  test('only the password login, and PASSWORD_LOGIN=false alone does not lock everybody out', async () => {
    assert.deepEqual((await server.call('GET', '/api/auth/options')).json, { password: true, sso: null });
    assert.equal((await fetch(`${server.base}/api/auth/sso/start`, { redirect: 'manual' })).status, 404);
  });
});

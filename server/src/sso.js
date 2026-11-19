/**
 * Login with the organization's SSO through OpenID Connect (PRO-154): authorization code flow with
 * PKCE, configured by environment variables, so any compliant provider works (Entra ID, Keycloak,
 * gov.br, Google…).
 *
 * - /api/auth/sso/start sends the browser to the provider, with state, nonce and a PKCE challenge.
 *   The state also goes in an HttpOnly cookie, so the answer must come back to the same browser.
 * - /api/auth/sso/callback trades the code for tokens at the provider's token endpoint (server to
 *   server, over TLS), checks the ID token (issuer, audience, expiry, nonce) and logs the person in.
 *   As OpenID Connect Core 3.1.3.7 allows for a token received this way, the ID token signature isn't
 *   checked again: the TLS connection to the token endpoint already proves where it came from.
 * - The session token goes back to the portal in the URL fragment (#), which browsers don't send to
 *   servers or keep in logs.
 *
 * Pending logins live in memory for 10 minutes: fine, since the catalog runs as one instance.
 */
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const PENDING_MS = 10 * 60_000;
const COOKIE = 'catalogo_sso';
const CLOCK_SKEW_S = 120;

function config(env = process.env) {
  const issuer = String(env.OIDC_ISSUER || '').replace(/\/+$/, '');
  return {
    enabled: !!(issuer && env.OIDC_CLIENT_ID),
    issuer,
    clientId: env.OIDC_CLIENT_ID || '',
    clientSecret: env.OIDC_CLIENT_SECRET || '',
    /** 'basic' (client_secret_basic, the default) or 'post' (client_secret_post). */
    tokenAuth: String(env.OIDC_TOKEN_AUTH || 'basic').toLowerCase() === 'post' ? 'post' : 'basic',
    scopes: env.OIDC_SCOPES || 'openid email profile',
    label: env.OIDC_LABEL || 'Entrar com a conta da organização',
    /** Only e-mails from these domains get in (empty: any). */
    domains: String(env.OIDC_ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    /** PASSWORD_LOGIN=false: SSO only (no e-mail and password, no sign-up, no "forgot password"). */
    passwordLogin: !(issuer && env.OIDC_CLIENT_ID) || String(env.PASSWORD_LOGIN ?? 'true').toLowerCase() !== 'false',
    redirectUri: `${PUBLIC_URL}/api/auth/sso/callback`,
    secureCookie: PUBLIC_URL.startsWith('https://'),
  };
}

const cfg = config();

/** What the login page needs to know. */
function options() {
  return { password: cfg.passwordLogin, sso: cfg.enabled ? { label: cfg.label } : null };
}

// ----- provider metadata -----

let discovery = null;

/** The provider's OpenID configuration, fetched once (retried after a failure). */
async function metadata() {
  if (discovery) return discovery;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(cfg.issuer);
  if (!cfg.issuer.startsWith('https://') && !local) throw new Error('OIDC_ISSUER precisa ser https://');
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`o provedor respondeu ${res.status} à descoberta`);
  const meta = await res.json();
  if (String(meta.issuer || '').replace(/\/+$/, '') !== cfg.issuer) throw new Error(`o emissor anunciado (${meta.issuer}) não é o OIDC_ISSUER`);
  if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error('a descoberta não trouxe os endereços de autorização e de token');
  discovery = meta;
  return meta;
}

// ----- pending logins -----

const pending = new Map();

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}

const random = () => crypto.randomBytes(32).toString('base64url');
const challengeOf = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

/** Only paths inside the portal (no "//other.site"). */
const safeBack = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v.slice(0, 500) : '');

function cookieOf(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function setCookie(res, value, maxAgeS) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/api/auth/sso', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
  if (cfg.secureCookie) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/** Back to the login page with a message. */
function fail(res, message) {
  setCookie(res, '', 0);
  res.redirect(302, `/entrar?sso_erro=${encodeURIComponent(message)}`);
}

// ----- routes -----

async function start(req, res) {
  if (!cfg.enabled) return res.status(404).json({ message: 'O login pela organização não está configurado.' });
  let meta;
  try {
    meta = await metadata();
  } catch (err) {
    console.error('[sso] descoberta:', err.message);
    return fail(res, 'Não foi possível falar com o provedor de login. Tente de novo em instantes.');
  }
  sweep();
  const state = random();
  const nonce = random();
  const verifier = random();
  pending.set(state, { nonce, verifier, back: safeBack(req.query.voltar), expires: Date.now() + PENDING_MS });
  setCookie(res, state, PENDING_MS / 1000);
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
  }).toString();
  res.redirect(302, url.toString());
}

function decodeJwt(token) {
  const [, payload] = String(token || '').split('.');
  if (!payload) throw new Error('o provedor não devolveu um ID token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/** Checks the ID token claims; returns them. */
function checkIdToken(claims, { issuer, nonce }) {
  const now = Math.floor(Date.now() / 1000);
  if (String(claims.iss || '').replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) throw new Error('ID token de outro emissor');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.clientId)) throw new Error('ID token para outro cliente');
  if (aud.length > 1 && claims.azp && claims.azp !== cfg.clientId) throw new Error('ID token para outro cliente (azp)');
  if (!(Number(claims.exp) > now - CLOCK_SKEW_S)) throw new Error('ID token expirado');
  if (claims.nonce !== nonce) throw new Error('nonce diferente do enviado');
  if (!claims.sub) throw new Error('ID token sem "sub"');
  return claims;
}

async function callback(req, res, { login }) {
  if (!cfg.enabled) return res.status(404).json({ message: 'O login pela organização não está configurado.' });
  const { code, state, error, error_description: description } = req.query;
  const cookieState = cookieOf(req);
  const entry = typeof state === 'string' ? pending.get(state) : undefined;
  if (typeof state === 'string') pending.delete(state);
  if (error) return fail(res, `O provedor de login recusou a entrada${description ? `: ${String(description).slice(0, 200)}` : '.'}`);
  if (!entry || !cookieState || cookieState !== state || entry.expires < Date.now()) {
    return fail(res, 'O login expirou ou foi aberto em outro navegador. Tente de novo.');
  }
  try {
    const meta = await metadata();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(code || ''), redirect_uri: cfg.redirectUri, code_verifier: entry.verifier, client_id: cfg.clientId });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (cfg.clientSecret && cfg.tokenAuth === 'post') body.set('client_secret', cfg.clientSecret);
    else if (cfg.clientSecret) {
      const enc = (v) => encodeURIComponent(v);
      headers.authorization = `Basic ${Buffer.from(`${enc(cfg.clientId)}:${enc(cfg.clientSecret)}`).toString('base64')}`;
    }
    const tokenRes = await fetch(meta.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new Error(`token: ${tokenRes.status} ${tokens.error || ''} ${tokens.error_description || ''}`.trim());

    let claims = checkIdToken(decodeJwt(tokens.id_token), { issuer: meta.issuer, nonce: entry.nonce });
    // Some providers only put the e-mail in userinfo.
    if (!claims.email && meta.userinfo_endpoint && tokens.access_token) {
      const infoRes = await fetch(meta.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10_000) });
      const info = infoRes.ok ? await infoRes.json() : {};
      if (info.sub === claims.sub) claims = { ...info, ...claims, email: info.email, email_verified: info.email_verified, name: claims.name || info.name };
    }
    const email = String(claims.email || '').trim().toLowerCase();
    if (!email) return fail(res, 'O provedor de login não informou o seu e-mail. Peça ao time do provedor para liberar o escopo "email".');
    if (claims.email_verified === false || claims.email_verified === 'false') return fail(res, 'O seu e-mail ainda não foi confirmado no provedor de login.');
    if (cfg.domains.length && !cfg.domains.includes(email.split('@')[1])) return fail(res, `Só entram e-mails de ${cfg.domains.map((d) => '@' + d).join(', ')}.`);

    const name = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || claims.preferred_username || '';
    const result = login({ issuer: meta.issuer, sub: String(claims.sub), email, name });
    if (result.error) return fail(res, result.error);
    setCookie(res, '', 0);
    const fragment = new URLSearchParams({ token: result.token, ...(entry.back ? { voltar: entry.back } : {}) });
    res.redirect(302, `/entrar/sso#${fragment}`);
  } catch (err) {
    console.error('[sso] callback:', err.message);
    fail(res, 'Não foi possível concluir o login pela organização. Tente de novo.');
  }
}

module.exports = { config, options, start, callback, checkIdToken, safeBack, passwordLogin: () => cfg.passwordLogin, enabled: () => cfg.enabled };

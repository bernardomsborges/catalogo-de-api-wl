/**
 * Credentials the catalog server uses to call other services (read an OpenAPI document, check an
 * API's health). `secret` holds the secret part of each type (header value, token, password,
 * query value or client secret) and is never sent back to the browser.
 */
const TIMEOUT_MS = 20_000;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PARAM_NAME = /^[A-Za-z0-9_.~\-[\]]+$/;

const AUTH_TYPES = ['none', 'bearer', 'basic', 'header', 'query', 'oauth2'];
const AUTH_FIELDS = ['authType', 'headerName', 'paramName', 'username', 'tokenUrl', 'clientId', 'scope'];
const SECRET_LABEL = {
  bearer: 'o token',
  basic: 'a senha',
  header: 'o valor do cabeçalho',
  query: 'o valor do parâmetro',
  oauth2: 'o client secret',
};

/** OAuth 2.0 tokens by cache key: { token, expiresAt }. Memory only. */
const oauthTokens = new Map();

/** Entries saved before auth types existed had only a header name + value. */
const authTypeOf = (e) => e.authType || (e.secret ? 'header' : 'none');

/** Validates the non-secret settings of the chosen auth type. */
function readAuth(input) {
  const authType = AUTH_TYPES.includes(input.authType) ? input.authType : 'none';
  const str = (k) => String(input[k] || '').trim();
  const fields = { authType };
  if (authType === 'header') {
    fields.headerName = str('headerName');
    if (!HEADER_NAME.test(fields.headerName)) return { error: 'Informe um nome de cabeçalho válido (ex.: X-API-Key).' };
  }
  if (authType === 'query') {
    fields.paramName = str('paramName');
    if (!PARAM_NAME.test(fields.paramName)) return { error: 'Informe um nome de parâmetro válido (ex.: api_key).' };
  }
  if (authType === 'basic') {
    fields.username = str('username');
    if (!fields.username || fields.username.includes(':')) return { error: 'Informe o usuário (sem ":").' };
  }
  if (authType === 'oauth2') {
    fields.tokenUrl = str('tokenUrl');
    fields.clientId = str('clientId');
    fields.scope = str('scope');
    if (!/^https?:\/\//i.test(fields.tokenUrl)) return { error: 'A URL do token deve começar com http:// ou https://.' };
    if (!fields.clientId) return { error: 'Informe o client ID.' };
  }
  return { fields };
}

/** Short error text from a JSON error body. */
function bodyMessage(text) {
  try {
    const d = JSON.parse(text);
    const m = d.error_description || d.mensagem || d.message || (typeof d.detail === 'string' ? d.detail : '') || (typeof d.error === 'string' ? d.error : '');
    return String(m).replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/** OAuth 2.0 client credentials: gets a token and reuses it (per key) until shortly before it expires. */
async function oauthToken(key, e) {
  const cached = key && oauthTokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: e.clientId, client_secret: e.secret });
  if (e.scope) body.set('scope', e.scope);
  const res = await fetch(e.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const msg = bodyMessage(text);
    throw new Error(`O servidor de token respondeu ${res.status}${msg ? `: ${msg}` : ''}. Confira o client ID e o client secret.`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('O servidor de token não devolveu access_token.');
  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 5 * 60_000;
  if (key) oauthTokens.set(key, { token: data.access_token, expiresAt: Date.now() + ttl });
  return data.access_token;
}

/** Puts the credential in the request, according to the auth type. `key` caches OAuth tokens. */
async function authorize(key, e, headers, url) {
  const secret = e.secret || '';
  switch (authTypeOf(e)) {
    case 'bearer':
      headers.Authorization = `Bearer ${secret.replace(/^Bearer\s+/i, '')}`;
      break;
    case 'basic':
      headers.Authorization = `Basic ${Buffer.from(`${e.username}:${secret}`).toString('base64')}`;
      break;
    case 'header':
      headers[e.headerName || 'Authorization'] = secret;
      break;
    case 'query':
      url.searchParams.set(e.paramName, secret);
      break;
    case 'oauth2':
      headers.Authorization = `Bearer ${await oauthToken(key, e)}`;
      break;
  }
}

/** Drops a cached OAuth token (settings changed, or the token was rejected). */
const forgetToken = (key) => oauthTokens.delete(key);

/**
 * Applies new credential settings to a stored entry. An empty secret keeps the stored one while the
 * type stays the same. Returns an error text, or '' when the entry is ready.
 */
function applyAuthSettings(prev, next, input) {
  const auth = readAuth(input);
  if (auth.error) return auth.error;
  for (const f of AUTH_FIELDS) delete next[f];
  Object.assign(next, auth.fields);
  const newSecret = typeof input.secret === 'string' ? input.secret.trim() : '';
  const typeChanged = authTypeOf(prev) !== auth.fields.authType;
  if (auth.fields.authType === 'none') delete next.secret;
  else if (newSecret) next.secret = newSecret;
  else if (typeChanged || input.clearSecret) delete next.secret;
  if (auth.fields.authType !== 'none' && !next.secret) return `Informe ${SECRET_LABEL[auth.fields.authType]}.`;
  return '';
}

/** Non-secret settings, for the browser. */
function authView(e) {
  return {
    authType: authTypeOf(e),
    headerName: e.headerName || '',
    paramName: e.paramName || '',
    username: e.username || '',
    tokenUrl: e.tokenUrl || '',
    clientId: e.clientId || '',
    scope: e.scope || '',
    hasSecret: !!e.secret,
  };
}

module.exports = { AUTH_FIELDS, SECRET_LABEL, authTypeOf, readAuth, bodyMessage, authorize, forgetToken, applyAuthSettings, authView };

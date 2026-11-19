// Logs first (PRO-208): some modules already write while loading.
const logger = require('./log');
logger.install();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const store = require('./store');
const consoleProxy = require('./console-proxy');
const specSync = require('./spec-sync');
const recipes = require('./recipes');
const health = require('./health');
const llm = require('./ai/llm');
const aiIndex = require('./ai/catalog-index');
const assistant = require('./ai/assistant');
const agent = require('./ai/agent');
const subscriptions = require('./subscriptions');
const notify = require('./notify');
const accounts = require('./accounts');
const transfer = require('./transfer');
const security = require('./security');
const singleInstance = require('./single-instance');
const migrate = require('./db/migrate');
const sso = require('./sso');
const { rateLimit } = require('./rate-limit');
const linkPreview = require('./link-preview');
const metrics = require('./metrics');
const sitemap = require('./sitemap');
const systems = require('./systems');

const PORT = Number(process.env.PORT) || 3000;
/** The portal's public address, for absolute links (previews, sitemap). */
const PUBLIC_ORIGIN = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

/**
 * TRUST_PROXY → Express "trust proxy": a hop count ("1"), "true"/"false", or addresses/presets
 * ("loopback", "10.0.0.0/8, 172.16.0.0/12"). Unset keeps Express's default (trust nobody).
 */
function trustProxySetting(value) {
  const v = (value || '').trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// The built Angular app, served from the same port in production.
const WEB_DIST = path.join(__dirname, '..', '..', 'web', 'dist', 'web', 'browser');

const app = express();
app.disable('x-powered-by');
// Request id (X-Request-Id) and one log line per request; the health check only at debug level.
app.use(logger.requests({ quiet: (req) => req.path === '/healthz' }));
const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
app.use(security.securityHeaders({ indexFile: path.join(WEB_DIST, 'index.html') }));
app.use(cors(security.corsOptions()));
// The import file carries the whole catalog, so it gets a bigger limit than the other routes.
app.use('/api/transfer', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '5mb' }));

// ----- Health of the catalog itself (Docker HEALTHCHECK, load balancers) -----
// Light on purpose: no catalog building, just "the process answers and so does the database".
const HEALTH_DB_TIMEOUT_MS = 3000;
app.get('/healthz', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const database = store.backendName();
  let timeout;
  try {
    await Promise.race([
      store.ping(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`sem resposta em ${HEALTH_DB_TIMEOUT_MS / 1000}s`)), HEALTH_DB_TIMEOUT_MS);
      }),
    ]);
    res.json({ status: 'ok', database });
  } catch (err) {
    console.error('[saúde do catálogo] banco de dados:', err.message);
    res.status(503).json({ status: 'erro', database, message: 'O banco de dados não está respondendo.' });
  } finally {
    clearTimeout(timeout);
  }
});

// ----- People and permissions -----
// Every request may carry a session token; `req.account` is the person (or undefined).
app.use('/api', (req, _res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const account = token ? accounts.verify(token) : null;
  if (account) {
    req.account = account;
    req.user = account.email;
  }
  next();
});

/** Wraps async handlers so a storage error answers 500 instead of crashing. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireLogin(req, res, next) {
  if (!req.account) return res.status(401).json({ message: 'Entre com a sua conta para continuar.' });
  next();
}

/** Admins and editors: everything about APIs and ReceAPItos. */
function requireAdmin(req, res, next) {
  if (!req.account) return res.status(401).json({ message: 'Sessão inválida ou expirada.' });
  if (!accounts.isStaff(req.account)) return res.status(403).json({ message: 'Você não tem permissão para esta ação.' });
  next();
}

/** Admins only: people, groups and access requests. */
function requireAdminRole(req, res, next) {
  if (!req.account) return res.status(401).json({ message: 'Sessão inválida ou expirada.' });
  if (req.account.role !== 'admin') return res.status(403).json({ message: 'Só administradores podem gerenciar pessoas e acessos.' });
  next();
}

/** APIs the person may access (full), and the private ones they can't (summary only). */
function catalogFor(account) {
  const all = store.list();
  return { visible: all.filter((a) => accounts.canSee(account, a)), locked: all.filter((a) => !accounts.canSee(account, a)).map(accounts.lockedView) };
}

/** ReceAPItos the person may see: every API they use must be accessible. */
function recipesFor(account) {
  const visible = new Set(catalogFor(account).visible.flatMap((a) => [a.id, a.slug]));
  return recipes.list().filter((r) => r.steps.every((s) => visible.has(s.apiId) || (s.apiSlug && visible.has(s.apiSlug))));
}

const authLimit = rateLimit(20, 10 * 60_000);

// ----- SSO (OpenID Connect) and which ways of logging in are on -----
app.get('/api/auth/options', (_req, res) => res.json(sso.options()));
// Each SSO login takes two calls (start and callback); the password is checked by the provider, not here.
const ssoLimit = rateLimit(60, 10 * 60_000);
app.get('/api/auth/sso/start', ssoLimit, sso.start);
app.get('/api/auth/sso/callback', ssoLimit, (req, res) => sso.callback(req, res, { login: accounts.ssoLogin }));

/** With PASSWORD_LOGIN=false, people enter only through SSO. */
function requirePasswordLogin(_req, res, next) {
  if (!sso.passwordLogin()) return res.status(403).json({ message: `O login com senha está desligado. Use "${sso.options().sso?.label}".` });
  next();
}

app.post('/api/auth/register', authLimit, requirePasswordLogin, wrap(async (req, res) => {
  const { user, token, error } = await accounts.register(req.body || {});
  if (error) return res.status(400).json({ message: error });
  res.status(201).json({ token, user: accounts.publicUser(user) });
}));

app.post('/api/auth/login', authLimit, requirePasswordLogin, wrap(async (req, res) => {
  const { email, username, password } = req.body || {};
  const r = await accounts.login(email ?? username, password);
  if (!r) return res.status(401).json({ message: 'E-mail ou senha incorretos.' });
  res.json({ token: r.token, user: accounts.publicUser(r.user) });
}));

// "Esqueci minha senha": same answer whether or not the e-mail has an account.
app.post('/api/auth/forgot', authLimit, requirePasswordLogin, async (req, res) => {
  const started = accounts.startReset(req.body?.email);
  if (started) {
    notify.sendPasswordReset(started.user, started.token, started.minutes).catch((err) => console.error('[e-mail] redefinir senha:', err.message));
  }
  res.status(202).json({ message: 'Se houver uma conta com este e-mail, enviamos um link para criar uma senha nova. Confira também a caixa de spam.' });
});

app.post('/api/auth/reset', authLimit, requirePasswordLogin, wrap(async (req, res) => {
  const { user, token, error } = await accounts.finishReset(req.body?.token, req.body?.password);
  if (error) return res.status(400).json({ message: error });
  res.json({ token, user: accounts.publicUser(user) });
}));

app.get('/api/auth/me', requireLogin, (req, res) => res.json({ user: accounts.publicUser(req.account) }));

// Tokens are signed, not stored: logging out is forgetting the token on the browser.
app.post('/api/auth/logout', (_req, res) => res.status(204).end());
// "Sair de todos os dispositivos": every token of the person stops working, this one included.
app.post('/api/auth/logout-all', requireLogin, (req, res) => {
  accounts.endSessions(req.account.id);
  console.log(`[contas] ${req.account.email} encerrou todas as próprias sessões.`);
  res.status(204).end();
});

app.post('/api/auth/password', requireLogin, requirePasswordLogin, wrap(async (req, res) => {
  const { token, error } = await accounts.changePassword(req.account, req.body?.current, req.body?.next);
  if (error) return res.status(400).json({ message: error });
  res.json({ token, user: accounts.publicUser(req.account) });
}));

// Account page: groups one can ask to join, and one's own requests.
app.get('/api/account/groups', requireLogin, (_req, res) => res.json(accounts.listGroups({ requestableOnly: true })));
app.get('/api/account/requests', requireLogin, (req, res) => res.json(accounts.myRequests(req.account)));
app.post('/api/account/requests', requireLogin, authLimit, (req, res) => {
  const api = req.body?.api ? store.get(String(req.body.api)) : null;
  if (req.body?.api && !api) return res.status(404).json({ message: 'API não encontrada.' });
  const { request, created, error } = accounts.requestAccess(req.account, { groupId: req.body?.groupId, api, message: req.body?.message });
  if (error) return res.status(400).json({ message: error });
  if (created) {
    // Administrators without an e-mail address (e.g. the first "admin") don't receive it: then
    // ACCESS_REQUESTS_EMAIL / CATALOG_CONTACT_EMAIL do.
    const admins = accounts.adminEmails();
    const fallback = process.env.ACCESS_REQUESTS_EMAIL || process.env.CATALOG_CONTACT_EMAIL || '';
    notify
      .sendAccessRequested(request, { admins: admins.length ? admins : fallback ? [fallback] : [], api })
      .then((n) => !n && console.warn('[e-mail] pedido de acesso sem destinatário: cadastre um administrador com e-mail ou defina ACCESS_REQUESTS_EMAIL.'))
      .catch((err) => console.error('[e-mail] pedido de acesso:', err.message));
  }
  res.status(201).json(request);
});

// Groups for the API form (who may access a private API).
app.get('/api/groups', requireAdmin, (_req, res) => res.json(accounts.listGroups()));

// ----- Admin: people, groups, requests -----
/**
 * @param {import('express').Response} res
 * @param {{ notFound?: boolean, error?: string, [key: string]: any }} result
 * @param {number} [ok]
 */
const accountReply = (res, { notFound, error, ...rest }, ok = 200) => {
  if (notFound) return res.status(404).json({ message: 'Não encontrado.' });
  if (error) return res.status(400).json({ message: error });
  res.status(ok).json(rest.user ?? rest.group ?? rest.request ?? rest.system ?? {});
};
app.get('/api/admin/users', requireAdminRole, (_req, res) => res.json(accounts.listUsers()));
app.post('/api/admin/users', requireAdminRole, wrap(async (req, res) => accountReply(res, await accounts.createUser(req.body || {}, { withoutPassword: !sso.passwordLogin() }), 201)));
app.put('/api/admin/users/:id', requireAdminRole, wrap(async (req, res) => accountReply(res, await accounts.updateUser(req.params.id, req.body || {}, req.account))));
app.post('/api/admin/users/:id/logout-all', requireAdminRole, (req, res) => {
  const result = accounts.endSessions(req.params.id);
  if (!result.notFound) console.log(`[contas] ${req.account.email} encerrou as sessões da conta ${req.params.id}.`);
  accountReply(res, result);
});
app.delete('/api/admin/users/:id', requireAdminRole, (req, res) => accountReply(res, accounts.removeUser(req.params.id, req.account)));
app.get('/api/admin/groups', requireAdminRole, (_req, res) => res.json(accounts.listGroups({ withMembers: true })));
app.post('/api/admin/groups', requireAdminRole, (req, res) => accountReply(res, accounts.saveGroup(null, req.body || {}), 201));
app.put('/api/admin/groups/:id', requireAdminRole, (req, res) => accountReply(res, accounts.saveGroup(req.params.id, req.body || {})));
app.delete('/api/admin/groups/:id', requireAdminRole, (req, res) => accountReply(res, accounts.removeGroup(req.params.id)));
app.get('/api/admin/requests', requireAdminRole, (req, res) => {
  const list = accounts.listRequests(req.query.status ? String(req.query.status) : undefined);
  // For requests about an API, the groups that give access to it (the admin picks one).
  res.json(list.map((r) => (r.apiId ? { ...r, apiGroups: store.get(r.apiId)?.groups || [] } : r)));
});
/** Answers a request and e-mails the person who asked. */
function decideRequest(req, res, approve) {
  const result = accounts.decide(req.params.id, approve, req.account, { groupId: req.body?.groupId, note: req.body?.note });
  if (result.request) {
    const api = result.request.apiId ? store.get(result.request.apiId) : null;
    notify.sendAccessDecided(result.request, api).catch((err) => console.error('[e-mail] resposta do pedido:', err.message));
  }
  accountReply(res, result);
}
app.post('/api/admin/requests/:id/approve', requireAdminRole, (req, res) => decideRequest(req, res, true));
app.post('/api/admin/requests/:id/reject', requireAdminRole, (req, res) => decideRequest(req, res, false));

app.get('/api/apis', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  let result = store.list().map((a) => accounts.viewApi(req.account, a));
  if (q) {
    result = result.filter((a) =>
      [a.name, a.summary, a.category, a.owner, ...(a.tags || [])].join(' ').toLowerCase().includes(q)
    );
  }
  res.json(result);
});

app.get('/api/apis/:idOrSlug', (req, res) => {
  const api = store.get(req.params.idOrSlug);
  if (!api) return res.status(404).json({ message: 'API não encontrada.' });
  res.json(accounts.viewApi(req.account, api));
});

/** Answers a store result: 404, 400 (validation), 409 (someone else saved first) or the API. */
/**
 * @param {import('express').Response} res
 * @param {import('./store').SaveResult} result
 * @param {number} [status]
 */
function saved(res, { api, errors, notFound, conflict }, status = 200) {
  if (notFound) return res.status(404).json({ message: 'API não encontrada.' });
  if (conflict) return res.status(409).json({ message: conflict });
  if (errors) return res.status(400).json({ message: errors.join(' '), errors });
  return res.status(status).json(api);
}

/** After a publication: e-mail whoever follows the API about a new "Novidades" entry or deprecation. */
function afterPublish(before, api) {
  if (!before || !api) return;
  notify.onApiUpdated(before, api).then(
    (n) => n && console.log(`[avisos] ${api.name}: ${n} e-mail(s) enviados.`),
    (err) => console.error('[avisos]', err.message)
  );
}

const snapshot = (id) => {
  const a = store.get(id);
  return a && a.id === id ? structuredClone(a) : null;
};

app.post('/api/apis', requireAdmin, wrap(async (req, res) => {
  saved(res, await store.create(req.body, { by: req.user }), 201);
}));

// Publishes directly (records a revision in the history).
app.put('/api/apis/:id', requireAdmin, wrap(async (req, res) => {
  const before = snapshot(req.params.id);
  const result = await store.update(req.params.id, req.body, { by: req.user });
  saved(res, result);
  afterPublish(before, result.api);
}));

// ----- Drafts and history (admin) -----
app.get('/api/drafts', requireAdmin, (_req, res) => res.json(store.drafts()));

app.get('/api/apis/:id/draft', requireAdmin, (req, res) => {
  const d = store.getDraft(req.params.id);
  if (!d) return res.status(404).json({ message: 'Esta API não tem rascunho.' });
  res.json({ ...d.data, revision: d.baseRevision, draft: { updatedAt: d.updatedAt, updatedBy: d.updatedBy, baseRevision: d.baseRevision } });
});

app.put('/api/apis/:id/draft', requireAdmin, wrap(async (req, res) => {
  const { draft, errors, notFound } = await store.saveDraft(req.params.id, req.body, req.user);
  if (notFound) return res.status(404).json({ message: 'API não encontrada.' });
  if (errors) return res.status(400).json({ message: errors.join(' '), errors });
  res.json({ updatedAt: draft.updatedAt, updatedBy: draft.updatedBy, baseRevision: draft.baseRevision });
}));

app.delete('/api/apis/:id/draft', requireAdmin, wrap(async (req, res) => {
  await store.discardDraft(req.params.id);
  res.status(204).end();
}));

app.post('/api/apis/:id/publish', requireAdmin, wrap(async (req, res) => {
  const before = snapshot(req.params.id);
  const result = await store.publishDraft(req.params.id, req.body, { by: req.user });
  saved(res, result);
  afterPublish(before, result.api);
}));

app.get('/api/apis/:id/versions', requireAdmin, wrap(async (req, res) => {
  if (!snapshot(req.params.id)) return res.status(404).json({ message: 'API não encontrada.' });
  res.json(await store.versions(req.params.id));
}));

app.get('/api/apis/:id/versions/:rev', requireAdmin, wrap(async (req, res) => {
  const data = await store.version(req.params.id, Number(req.params.rev));
  if (!data) return res.status(404).json({ message: 'Versão não encontrada.' });
  res.json(data);
}));

app.post('/api/apis/:id/versions/:rev/restore', requireAdmin, wrap(async (req, res) => {
  const before = snapshot(req.params.id);
  const result = await store.restore(req.params.id, Number(req.params.rev), req.user);
  saved(res, result);
  afterPublish(before, result.api);
}));

app.delete('/api/apis/:id', requireAdmin, wrap(async (req, res) => {
  const api = store.get(req.params.id);
  if (!(await store.remove(req.params.id))) return res.status(404).json({ message: 'API não encontrada.' });
  // Edits and publications stay in the version history; a deletion takes the history along, so it goes to the log.
  console.log(`[auditoria] ${new Date().toISOString()} API "${api?.name}" (${api?.slug}) excluída por ${req.user}`);
  specSync.remove(req.params.id);
  subscriptions.removeApi(req.params.id);
  systems.removeApi(req.params.id);
  health.remove(req.params.id);
  res.status(204).end();
}));

// ----- Export and import between catalogs (e.g. homologação → produção) -----
app.post('/api/transfer/export', requireAdmin, (req, res) => {
  res.json(transfer.exportBundle({ apiIds: req.body?.apiIds, includeRecipes: req.body?.recipes !== false }));
});

app.post('/api/transfer/preview', requireAdmin, (req, res) => {
  const { plan, error } = transfer.preview(req.body?.bundle);
  if (error) return res.status(400).json({ message: error });
  res.json({ ...plan, canCreateGroups: req.account.role === 'admin' });
});

app.post('/api/transfer/import', requireAdmin, wrap(async (req, res) => {
  const { results, error } = await transfer.apply(req.body?.bundle, req.body || {}, {
    by: req.user,
    canCreateGroups: req.account.role === 'admin',
    onUpdated: afterPublish,
  });
  if (error) return res.status(400).json({ message: error });
  res.json({ results });
}));

// ----- AI: catalog index and assistant (PRO-149, PRO-151) -----

app.get('/api/ai/status', (_req, res) => res.json({ ...aiIndex.status(), model: llm.enabled() ? llm.MODEL : null }));

app.get('/api/ai/search', rateLimit(60, 60_000), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 500);
  if (!q) return res.json({ results: [], mode: 'palavras' });
  const { results, mode } = await aiIndex.search(assistant.redact(q), {
    api: req.query.api ? String(req.query.api) : undefined,
    limit: Math.min(Number(req.query.limit) || 8, 20),
    allow: aiIndex.allowFor(catalogFor(req.account).visible),
  });
  res.json({ mode, results: results.map((d) => ({ ...assistant.publicDoc(d), score: d.score })) });
}));

app.post('/api/ai/ask', rateLimit(20, 10 * 60_000), async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (question.length < 3) return res.status(400).json({ message: 'Escreva a sua pergunta.' });
  if (question.length > 1000) return res.status(400).json({ message: 'A pergunta passa de 1000 caracteres. Resuma, por favor.' });
  // Earlier turns of the conversation (text only), for follow-up questions.
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((h) => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string')
    .slice(-8)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }));
  try {
    // The assistant only gets what this person may see: full data of accessible APIs, the summary
    // of private ones they can't access, and the ReceAPItos they can open.
    const { visible, locked } = catalogFor(req.account);
    const allowedRecipes = recipesFor(req.account);
    res.json(
      await agent.ask(question, {
        api: req.body?.api ? String(req.body.api) : undefined,
        history,
        catalog: visible,
        locked,
        recipes: { list: () => allowedRecipes },
        health,
        who: req.account ? accounts.publicUser(req.account) : null,
      })
    );
  } catch (err) {
    console.error('[ia] pergunta:', err.message);
    res.status(502).json({ message: 'O assistente não conseguiu responder agora. Tente de novo em instantes.' });
  }
});

// Questions the assistant couldn't answer, grouped (PRO-198): where the documentation is missing.
app.get('/api/ai/gaps', requireAdmin, (_req, res) => res.json(assistant.gapGroups()));
app.post('/api/ai/gaps/resolve', requireAdmin, (req, res) => {
  const { key, resolved = true } = req.body || {};
  if (typeof key !== 'string' || !assistant.resolveGap(key, !!resolved, req.user)) return res.status(404).json({ message: 'Pergunta não encontrada.' });
  res.json(assistant.gapGroups().find((g) => g.key === key));
});

// "Melhorar com IA" in the admin (PRO-150). Nothing is saved here: the form shows the suggestions.
const docAgent = require('./ai/doc-agent');
function requireLlm(_req, res, next) {
  if (!llm.enabled()) return res.status(503).json({ message: 'A IA não está configurada (LLM_BASE_URL).' });
  next();
}

app.post('/api/ai/doc-gaps', requireAdmin, (req, res) => {
  const api = req.body?.api;
  if (!api || !Array.isArray(api.endpoints)) return res.status(400).json({ message: 'Envie a API do formulário.' });
  const gaps = docAgent.aiGaps(api);
  const endpoints = [...new Set(gaps.map((g) => /^endpoints\[(\d+)\]/.exec(g.target)?.[1]).filter(Boolean).map(Number))];
  // How many batches the panel asks at the same time (LLM_PARALLEL, 1 to 10).
  const parallel = Math.min(10, Math.max(1, Number(process.env.LLM_PARALLEL) || 5));
  res.json({ total: gaps.length, apiLevel: gaps.some((g) => !g.target.startsWith('endpoints[')), endpoints, parallel });
});

app.post('/api/ai/improve', requireAdmin, requireLlm, async (req, res) => {
  const { api, endpoints, apiLevel } = req.body || {};
  if (!api || !Array.isArray(api.endpoints)) return res.status(400).json({ message: 'Envie a API do formulário.' });
  try {
    res.json(await docAgent.improve(api, { endpoints, apiLevel: apiLevel !== false }));
  } catch (err) {
    console.error('[ia] melhorar:', err.message);
    res.status(502).json({ message: `A IA não conseguiu sugerir agora: ${err.message}` });
  }
});

app.post('/api/ai/guide', requireAdmin, requireLlm, async (req, res) => {
  const { api, topic } = req.body || {};
  if (!api || !Array.isArray(api.endpoints)) return res.status(400).json({ message: 'Envie a API do formulário.' });
  try {
    res.json(await docAgent.guide(api, topic));
  } catch (err) {
    console.error('[ia] guia:', err.message);
    res.status(502).json({ message: `A IA não conseguiu escrever o guia agora: ${err.message}` });
  }
});

// "Montar com IA" in the ReceAPIto form. Nothing is saved here: the form shows the draft.
const recipeAgent = require('./ai/recipe-agent');
app.post('/api/ai/recipe', requireAdmin, requireLlm, rateLimit(30, 10 * 60_000), async (req, res) => {
  const idea = String(req.body?.idea || '').trim();
  if (idea.length < 5) return res.status(400).json({ message: 'Descreva a ideia do ReceAPIto.' });
  if (idea.length > 3000) return res.status(400).json({ message: 'A descrição passa de 3000 caracteres. Resuma, por favor.' });
  const history = (Array.isArray(req.body?.history) ? req.body.history : []).filter((h) => typeof h === 'string').slice(-6).map((h) => h.slice(0, 3000));
  const draft = req.body?.draft && Array.isArray(req.body.draft.steps) ? req.body.draft : null;
  try {
    res.json(await recipeAgent.build({ idea: assistant.redact(idea), draft, history: history.map(assistant.redact) }, catalogFor(req.account).visible));
  } catch (err) {
    console.error('[ia] receapito:', err.message);
    res.status(502).json({ message: `A IA não conseguiu montar agora: ${err.message}` });
  }
});

// ----- Health / status page -----
app.get('/api/status', (req, res) => {
  res.json(catalogFor(req.account).visible.map((a) => ({ apiId: a.id, slug: a.slug, name: a.name, category: a.category, ...health.publicView(a.id, true) })));
});

app.get('/api/apis/:id/health', requireAdmin, requireApi, (req, res) => res.json(health.adminView(req.params.id)));

app.put('/api/apis/:id/health', requireAdmin, requireApi, async (req, res) => {
  const { detail, error } = health.configure(req.params.id, req.body);
  if (error) return res.status(400).json({ message: error });
  if (detail.monitored) await health.check(req.params.id);
  res.json(health.adminView(req.params.id));
});

app.post('/api/apis/:id/health/check', requireAdmin, requireApi, async (req, res) => {
  await health.check(req.params.id);
  res.json(health.adminView(req.params.id));
});

// ----- Recipes (tasks with several routes) -----
app.get('/api/recipes', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const api = String(req.query.api || '');
  let list = recipesFor(req.account);
  if (api) list = list.filter((r) => r.steps.some((s) => s.apiId === api || s.apiSlug === api));
  if (q) list = list.filter((r) => [r.title, r.goal, ...(r.tags || [])].join(' ').toLowerCase().includes(q));
  res.json(list);
});

app.get('/api/recipes/:idOrSlug', (req, res) => {
  const r = recipes.get(req.params.idOrSlug);
  if (!r || !recipesFor(req.account).some((x) => x.id === r.id)) return res.status(404).json({ message: 'ReceAPIto não encontrado.' });
  res.json(r);
});

app.post('/api/recipes', requireAdmin, (req, res) => {
  const { recipe, errors } = recipes.create(req.body);
  if (errors) return res.status(400).json({ message: errors.join(' '), errors });
  res.status(201).json(recipe);
});

app.put('/api/recipes/:id', requireAdmin, (req, res) => {
  const { recipe, errors, notFound } = recipes.update(req.params.id, req.body);
  if (notFound) return res.status(404).json({ message: 'ReceAPIto não encontrado.' });
  if (errors) return res.status(400).json({ message: errors.join(' '), errors });
  res.json(recipe);
});

app.delete('/api/recipes/:id', requireAdmin, (req, res) => {
  if (!recipes.remove(req.params.id)) return res.status(404).json({ message: 'ReceAPIto não encontrado.' });
  res.status(204).end();
});
// ----- "Acompanhar esta API" (e-mail notices) -----
const subscribeHits = new Map();
function subscribeRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const recent = (subscribeHits.get(key) || []).filter((t) => now - t < 60 * 60_000);
  if (recent.length >= 10) return res.status(429).json({ message: 'Muitos pedidos. Tente de novo mais tarde.' });
  recent.push(now);
  subscribeHits.set(key, recent);
  next();
}

const publicApi = (a) => ({ name: a.name, slug: a.slug });

app.post('/api/apis/:idOrSlug/subscribe', subscribeRateLimit, async (req, res) => {
  const api = store.get(req.params.idOrSlug);
  if (!api) return res.status(404).json({ message: 'API não encontrada.' });
  // Private API: only people with access, and only to their own account's e-mail.
  if (api.visibility === 'private') {
    if (!accounts.canSee(req.account, api)) return res.status(403).json({ message: 'Você não tem acesso a esta API.' });
    if (String(req.body?.email || '').trim().toLowerCase() !== req.account.email) return res.status(400).json({ message: 'Para esta API, os avisos só vão para o e-mail da sua conta.' });
  }
  const { sub, error } = subscriptions.subscribe(api.id, req.body?.email);
  if (error) return res.status(400).json({ message: error });
  try {
    if (sub) await notify.sendConfirmation(sub, api);
  } catch (err) {
    console.error('[e-mail] confirmação:', err.message);
    return res.status(502).json({ message: 'Não foi possível enviar o e-mail de confirmação agora. Tente mais tarde.' });
  }
  // Same answer whether or not the address already follows the API.
  res.status(202).json({ message: 'Enviamos um link de confirmação para o seu e-mail.' });
});

function subscriptionReply(res, sub) {
  const api = sub && store.get(sub.apiId);
  if (!sub || !api) return res.status(404).json({ message: 'Link inválido ou expirado.' });
  res.json({ api: publicApi(api), email: sub.email, status: sub.status });
}

app.post('/api/subscriptions/confirm', (req, res) => subscriptionReply(res, subscriptions.confirm(req.body?.token)));
app.post('/api/subscriptions/resubscribe', (req, res) => subscriptionReply(res, subscriptions.resubscribe(req.body?.token)));
// Token in the body (page) or in the query (one-click button of the mail client, RFC 8058).
app.post('/api/subscriptions/unsubscribe', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) =>
  subscriptionReply(res, subscriptions.unsubscribe(req.body?.token || req.query.token))
);

app.get('/api/subscriptions/counts', requireAdmin, (_req, res) => res.json(subscriptions.counts()));

// OpenAPI sync (admin only). Responses never include the read credential.
app.get('/api/sync', requireAdmin, (_req, res) => res.json(specSync.summary()));

function requireApi(req, res, next) {
  if (!store.get(req.params.id) || store.get(req.params.id).id !== req.params.id) {
    return res.status(404).json({ message: 'API não encontrada.' });
  }
  next();
}

/**
 * @param {import('express').Response} res
 * @param {{ detail?: any, error?: string, notConfigured?: boolean }} result
 */
function syncReply(res, { detail, error, notConfigured }) {
  if (notConfigured) return res.status(400).json({ message: 'Configure a URL da especificação primeiro.' });
  if (error) return res.status(400).json({ message: error });
  res.json(detail);
}

// "Importar OpenAPI → Link": fetches the document once with the given credential (not saved).
app.post('/api/import/openapi', requireAdmin, async (req, res) => {
  const apiId = req.body?.apiId && store.get(req.body.apiId)?.id === req.body.apiId ? req.body.apiId : undefined;
  const { text, source, how, error } = await specSync.fetchOnce(req.body, apiId);
  if (error) return res.status(400).json({ message: error });
  res.json({ text, source, how });
});

app.get('/api/apis/:id/sync', requireAdmin, requireApi, (req, res) => res.json(specSync.view(req.params.id, true)));

app.put('/api/apis/:id/sync', requireAdmin, requireApi, async (req, res) => {
  const r = specSync.configure(req.params.id, req.body);
  if (r.error || !r.detail.configured) return syncReply(res, r);
  syncReply(res, await specSync.check(req.params.id));
});

app.post('/api/apis/:id/sync/check', requireAdmin, requireApi, async (req, res) => {
  syncReply(res, await specSync.check(req.params.id));
});

app.post('/api/apis/:id/sync/applied', requireAdmin, requireApi, (req, res) => {
  syncReply(res, specSync.markApplied(req.params.id, req.body?.hash));
});

// "Testar este endpoint": sends the request server-side so browser CORS rules don't block it.
app.post('/api/console/send', (req, res, next) => {
  const api = req.body?.apiId && store.get(req.body.apiId);
  if (api && !accounts.canSee(req.account, api)) return res.status(403).json({ message: 'Você não tem acesso a esta API.' });
  // Usage metrics (PRO-165) leave out the team's own tests.
  req.countMetrics = !accounts.isStaff(req.account);
  next();
}, consoleProxy.handle);

// ----- Consumer systems (PRO-166): who uses each API, see systems.js -----
// The list and its contacts are internal: the team manages it; people who can see an API and are
// logged in see who uses it.
app.get('/api/admin/systems', requireAdmin, (_req, res) => res.json(systems.list()));
app.get('/api/admin/systems/suggestions', requireAdmin, (_req, res) => res.json(systems.suggestions(accounts.listRequests('approved'), store.list())));
app.post('/api/admin/systems', requireAdmin, (req, res) => accountReply(res, systems.save(null, req.body, store.list(), req.user), 201));
app.put('/api/admin/systems/:id', requireAdmin, (req, res) => accountReply(res, systems.save(req.params.id, req.body, store.list(), req.user)));
app.delete('/api/admin/systems/:id', requireAdmin, (req, res) => accountReply(res, systems.remove(req.params.id)));
app.get('/api/apis/:idOrSlug/consumers', requireLogin, (req, res) => {
  const api = store.get(req.params.idOrSlug);
  if (!api || !accounts.canSee(req.account, api)) return res.status(404).json({ message: 'API não encontrada.' });
  res.json(systems.consumersOf(api.id));
});

// ----- Usage metrics (PRO-165): anonymous daily counters, see metrics.js -----
// The portal reports what is read in the browser: API, guide and route pages, and catalog searches.
const metricsLimit = rateLimit(120, 60_000, 'Muitos registros seguidos.');
app.post('/api/metrics', metricsLimit, (req, res) => {
  const { type, api: apiRef, guide, endpoint, q, results } = req.body || {};
  if (accounts.isStaff(req.account)) return res.status(204).end();
  if (type === 'view') {
    const api = typeof apiRef === 'string' && store.get(apiRef);
    if (!api) return res.status(400).json({ message: 'API desconhecida.' });
    metrics.view(api, { guide: typeof guide === 'string' ? guide : undefined, endpoint: typeof endpoint === 'string' ? endpoint : undefined });
  } else if (type === 'search') {
    metrics.search(q, results);
  } else {
    return res.status(400).json({ message: 'Tipo de registro inválido.' });
  }
  res.status(204).end();
});
app.get('/api/admin/metrics', requireAdmin, (req, res) => {
  const apiId = req.query.api ? String(req.query.api) : null;
  res.json(metrics.report({ days: req.query.days, apiId, apis: store.list(), gaps: assistant.gaps() }));
});

// Search engines (PRO-207): public APIs and the ReceAPItos open to everyone.
app.get('/sitemap.xml', (_req, res) => {
  const apis = store.list().filter((a) => accounts.canSee(undefined, a));
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(sitemap.sitemapXml({ origin: PUBLIC_ORIGIN, apis, recipes: recipesFor(undefined) }));
});
app.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send(sitemap.robotsTxt({ origin: PUBLIC_ORIGIN })));

// In production, serve the built Angular app from the same port.
// index.html goes out with the title and preview tags of the page (see link-preview.js), so "/"
// is not served as a static file.
if (fs.existsSync(WEB_DIST)) {
  const indexHtml = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
  const origin = PUBLIC_ORIGIN;
  const lookups = {
    // An anonymous visitor's view: name and summary only, for private APIs too.
    findApi: (slug) => {
      const api = store.get(slug);
      return api && accounts.viewApi(undefined, api);
    },
    findRecipe: (slug) => recipesFor(undefined).find((r) => r.slug === slug),
  };
  app.use(express.static(WEB_DIST, { index: false }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    const preview = linkPreview.previewFor(req.path, lookups);
    res.type('html').set('Cache-Control', 'no-cache').send(linkPreview.renderIndex(indexHtml, preview, { url: origin + req.path, origin }));
  });
}

// Storage errors (database down, disk full…) answer 500 with a readable message.
// The request's id goes back to the person, to quote when reporting the problem (PRO-208).
app.use((err, req, res, _next) => {
  console.error('[erro]', err);
  res.status(500).json({ message: `Erro ao gravar os dados. Tente de novo em instantes. Se continuar, informe o código ${req.id}.`, requestId: req.id });
});

// One copy only (see single-instance.js): with PostgreSQL, a second copy waits here for the first.
// Then everything loads before the first admin check and before serving: with an unreadable store,
// the server stops instead of starting empty and writing over the data.
singleInstance
  .acquire()
  .then((info) => {
    console.log(`[instância] ${info}.`);
    return migrate.run();
  })
  .then((info) => {
    console.log(`[banco] ${info}.`);
    return Promise.all([store.init(), accounts.init(), recipes.init(), subscriptions.init(), specSync.init(), health.init(), assistant.init(), aiIndex.init(), metrics.init(), systems.init()]);
  })
  .then(async ([, accountsInfo]) => {
    console.log(`[contas] ${accountsInfo}.`);
    const createdAdmin = await accounts.ensureAdmin();
    if (createdAdmin) {
      console.log(`[contas] administrador criado: ${createdAdmin}`);
      if (!process.env.ADMIN_PASSWORD) console.warn('[aviso] ADMIN_PASSWORD não definido — o administrador foi criado com a senha padrão. Troque-a ao entrar.');
    }
    app.listen(PORT, started);
  })
  .catch((err) => {
    console.error('[dados] Não foi possível carregar os dados:', err.message);
    process.exit(1);
  });

// On stop (deploy, docker stop), the usage counters not yet written are saved first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    Promise.race([Promise.resolve(metrics.flush()), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0));
  });
}

function started() {
  console.log(`Catálogo de APIs rodando em http://localhost:${PORT}`);
  // AI index: built now, updated on every API or recipe change.
  // The provider check runs first, so the index knows whether embeddings are available.
  llm.check().finally(() => aiIndex.rebuild(store.list(), recipes.list()));
  store.onChange((event, api) => aiIndex.onApiChange(event, api, store.list(), recipes.list()));
  recipes.onChange(() => aiIndex.onRecipesChange(store.list(), recipes.list()));
  specSync.start();
  // Health checks; going down / coming back e-mails whoever follows the API.
  health.start((apiId, previous, next, entry) => {
    const api = store.get(apiId);
    if (!api) return;
    console.log(`[saúde] ${api.name}: ${previous} → ${next}`);
    notify.onHealthChange(api, previous, next, entry).then(
      (n) => n && console.log(`[avisos] ${api.name}: ${n} e-mail(s) de incidente.`),
      (err) => console.error('[avisos]', err.message)
    );
  });
}

const crypto = require('crypto');

/**
 * Catalog data. Published APIs are kept in memory for fast reads (list/get are synchronous);
 * writes go to the storage backend: PostgreSQL when DATABASE_URL is set, JSON files otherwise.
 * Every publication is a numbered revision kept in the history; drafts wait to be published.
 */
const backend = process.env.DATABASE_URL ? require('./db/pg-backend') : require('./db/file-backend');

let apis = [];
/** { [apiId]: { data, baseRevision, updatedAt, updatedBy } } */
let drafts = {};
const listeners = new Set();

/** Writes run one at a time, so two saves never interleave inside this process. */
/** @type {Promise<unknown>} */
let queue = Promise.resolve();
/**
 * What a write answers: the saved API (or draft), or why it wasn't saved.
 * @typedef {{ api?: any, draft?: any, errors?: string[], conflict?: string, notFound?: boolean }} SaveResult
 */

/**
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function init() {
  const loaded = await backend.init();
  apis = loaded.apis;
  drafts = loaded.drafts;
  console.log(`[dados] ${apis.length} API(s) carregada(s) (${backend.name}).`);
}

/** Called after an API is created, changed or removed: (event, api). Used by the AI index. */
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event, api) {
  for (const fn of listeners) {
    try {
      fn(event, api);
    } catch (err) {
      console.error('[dados]', err.message);
    }
  }
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const STATUSES = ['estavel', 'beta', 'depreciada', 'em-desenvolvimento'];
const AUTH_TYPES = ['none', 'apiKey', 'bearer', 'oauth2', 'basic'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SCHEME_TYPES = ['apiKey', 'bearer', 'oauth2', 'basic'];
const LOCATIONS = ['header', 'query', 'cookie'];

/** Cleans the credential list (one entry per header/token/key the consumer sends). */
function normalizeSchemes(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((s) => s && SCHEME_TYPES.includes(s.type))
    .map((s, i) => {
      let key = String(s.key || `cred${i + 1}`).trim();
      while (seen.has(key)) key += '_';
      seen.add(key);
      return {
        key,
        type: s.type,
        name: String(s.name || '').trim(),
        in: LOCATIONS.includes(s.in) ? s.in : 'header',
        description: String(s.description || ''),
        example: String(s.example || ''),
        bearerFormat: String(s.bearerFormat || ''),
        tokenUrl: String(s.tokenUrl || ''),
        scopes: String(s.scopes || ''),
        // Bearer issued by the API itself: "METHOD /path" of the login and logout routes.
        ...(s.type === 'bearer' && String(s.tokenEndpoint || '').trim() ? { tokenEndpoint: String(s.tokenEndpoint).trim() } : {}),
        ...(s.type === 'bearer' && String(s.logoutEndpoint || '').trim() ? { logoutEndpoint: String(s.logoutEndpoint).trim() } : {}),
      };
    });
}

/** A real calendar day written as YYYY-MM-DD. */
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Deprecated APIs (PRO-205): the day it is switched off and the API that replaces it. Kept only
 * while the status is "depreciada". A replacement that isn't in this catalog (e.g. an import from
 * another one) is dropped instead of refusing the save.
 */
function deprecationFields(input, ownId) {
  if (input.status !== 'depreciada') return {};
  const replacedBy = String(input.replacedBy || '');
  return {
    sunsetDate: validDay(input.sunsetDate) ? input.sunsetDate : '',
    replacedBy: replacedBy && replacedBy !== ownId && apis.some((a) => a.id === replacedBy) ? replacedBy : '',
  };
}

function validate(input, currentId) {
  const errors = [];
  if (!input || typeof input !== 'object') return ['Corpo da requisição inválido.'];
  if (!input.name || !String(input.name).trim()) errors.push('O nome é obrigatório.');
  if (!input.summary || !String(input.summary).trim()) errors.push('O resumo é obrigatório.');
  if (!input.baseUrl || !/^https?:\/\//.test(input.baseUrl)) errors.push('A URL base deve começar com http:// ou https://.');
  if (input.status && !STATUSES.includes(input.status)) errors.push('Status inválido.');
  if (input.status === 'depreciada' && input.sunsetDate && !validDay(input.sunsetDate)) errors.push('A data de desligamento é inválida (use AAAA-MM-DD).');
  if (input.auth?.type && !AUTH_TYPES.includes(input.auth.type)) errors.push('Tipo de autenticação inválido.');
  (input.auth?.schemes || []).forEach((sc, i) => {
    if (!SCHEME_TYPES.includes(sc?.type)) errors.push(`Credencial ${i + 1}: tipo inválido.`);
    else if (sc.type === 'apiKey' && !String(sc.name || '').trim()) errors.push(`Credencial ${i + 1}: informe o nome do cabeçalho/parâmetro.`);
  });
  (input.endpoints || []).forEach((e, i) => {
    if (!METHODS.includes(e.method)) errors.push(`Endpoint ${i + 1}: método inválido.`);
    if (!e.path || !String(e.path).startsWith('/')) errors.push(`Endpoint ${i + 1}: o caminho deve começar com "/".`);
  });
  const slug = slugify(input.slug || input.name);
  if (!slug) errors.push('Não foi possível gerar o identificador (slug).');
  if (apis.some((a) => a.slug === slug && a.id !== currentId)) errors.push(`Já existe uma API com o identificador "${slug}".`);
  return errors;
}

function normalize(input, existing) {
  const now = new Date().toISOString();
  return {
    id: existing?.id || crypto.randomUUID(),
    slug: slugify(input.slug || input.name),
    name: String(input.name).trim(),
    summary: String(input.summary).trim(),
    description: input.description || '',
    category: input.category || 'Geral',
    tags: Array.isArray(input.tags) ? input.tags.filter(Boolean) : [],
    status: input.status || 'beta',
    ...deprecationFields(input, existing?.id),
    version: input.version || '1.0.0',
    owner: input.owner || '',
    contactEmail: input.contactEmail || '',
    // 'private': only the summary is shown to people outside `groups` (see accounts.js).
    visibility: input.visibility === 'private' ? 'private' : 'public',
    groups: input.visibility === 'private' && Array.isArray(input.groups) ? [...new Set(input.groups.map(String))] : [],
    baseUrl: String(input.baseUrl).replace(/\/+$/, ''),
    environments: Array.isArray(input.environments) ? input.environments : [],
    auth: (() => {
      const schemes = normalizeSchemes(input.auth?.schemes);
      return {
        // With a credential list, the summary fields follow its first entries.
        type: schemes[0]?.type || (schemes.length ? 'none' : input.auth?.type || 'none'),
        headerName: schemes.length ? schemes.find((x) => x.type === 'apiKey')?.name || '' : input.auth?.headerName || '',
        tokenUrl: schemes.length ? schemes.find((x) => x.type === 'oauth2')?.tokenUrl || '' : input.auth?.tokenUrl || '',
        scopes: schemes.length ? schemes.find((x) => x.type === 'oauth2')?.scopes || '' : input.auth?.scopes || '',
        instructions: input.auth?.instructions || '',
        schemes,
        mode: input.auth?.mode === 'any' ? 'any' : 'all',
        // Keys used by endpoints without their own rule (missing = all of them).
        ...(Array.isArray(input.auth?.defaults) && schemes.length
          ? { defaults: input.auth.defaults.map(String).filter((k) => schemes.some((x) => x.key === k)) }
          : {}),
      };
    })(),
    rateLimit: input.rateLimit || '',
    sla: input.sla || '',
    endpoints: (input.endpoints || []).map((e) => ({
      id: e.id || crypto.randomUUID(),
      method: e.method,
      path: e.path,
      summary: e.summary || '',
      description: e.description || '',
      // Group of routes (OpenAPI tag): folders in the Postman collection.
      ...(String(e.tag || '').trim() ? { tag: String(e.tag).trim().slice(0, 80) } : {}),
      parameters: Array.isArray(e.parameters) ? e.parameters : [],
      requestBody: e.requestBody || '',
      responses: Array.isArray(e.responses) ? e.responses : [],
      // Missing = same credentials as the API; [] = public endpoint.
      ...(Array.isArray(e.security) ? { security: e.security.map(String) } : {}),
    })),
    guides: Array.isArray(input.guides) ? input.guides : [],
    changelog: Array.isArray(input.changelog) ? input.changelog : [],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
}

const CONFLICT = 'Esta API foi alterada por outra pessoa enquanto você editava. Recarregue a página para ver a versão atual.';

/** Publishes `input` over `existing` (or as a new API), recording a revision in the history. */
async function publish(input, existing, meta = {}) {
  const errors = validate(input, existing?.id);
  if (errors.length) return { errors };
  // The editor's starting revision, when known, must still be the current one.
  if (existing && input.revision != null && Number(input.revision) !== existing.revision) return { conflict: CONFLICT };
  const api = normalize(input, existing);
  const ok = await backend.savePublished(api, existing?.revision || 0, meta);
  if (!ok) return { conflict: CONFLICT };
  apis = existing ? apis.map((a) => (a.id === api.id ? api : a)) : [...apis, api];
  emit(existing ? 'update' : 'create', api);
  return { api };
}

const find = (id) => apis.find((a) => a.id === id);

module.exports = {
  init,
  onChange,
  backendName: () => backend.name,
  /** Resolves when the storage answers (PostgreSQL: SELECT 1; JSON files: nothing to check). */
  ping: () => (backend.ping ? backend.ping() : Promise.resolve()),
  /** Validation and the saved shape of an input, without saving (used by the import preview). */
  validate,
  normalize,
  slugify,
  list: () => apis,
  get: (idOrSlug) => apis.find((a) => a.id === idOrSlug || a.slug === idOrSlug),

  /** @returns {Promise<SaveResult>} */
  create: (input, meta = {}) => serial(() => publish(input, null, { note: 'Criada', ...meta })),

  /** @returns {Promise<SaveResult>} */
  update: (id, input, meta = {}) =>
    serial(async () => {
      const existing = find(id);
      if (!existing) return { notFound: true };
      return publish(input, existing, meta);
    }),

  remove: (id) =>
    serial(async () => {
      const existing = find(id);
      if (!existing) return false;
      await backend.deleteApi(id);
      apis = apis.filter((a) => a.id !== id);
      delete drafts[id];
      emit('remove', existing);
      return true;
    }),

  // ----- drafts -----
  getDraft: (id) => drafts[id] ?? null,
  drafts: () => Object.fromEntries(Object.entries(drafts).map(([id, d]) => [id, { updatedAt: d.updatedAt, updatedBy: d.updatedBy, baseRevision: d.baseRevision }])),

  /** @returns {Promise<SaveResult>} */
  saveDraft: (id, input, by = '') =>
    serial(async () => {
      const existing = find(id);
      if (!existing) return { notFound: true };
      const errors = validate(input, id);
      if (errors.length) return { errors };
      const { revision: _r, ...data } = input;
      const draft = {
        data,
        baseRevision: drafts[id]?.baseRevision ?? (input.revision != null ? Number(input.revision) : existing.revision),
        updatedAt: new Date().toISOString(),
        updatedBy: by,
      };
      await backend.saveDraft(id, draft);
      drafts[id] = draft;
      return { draft };
    }),

  discardDraft: (id) =>
    serial(async () => {
      await backend.deleteDraft(id);
      delete drafts[id];
    }),

  /** Publishes `input` (the edited draft) and drops the draft. */
  /** @returns {Promise<SaveResult>} */
  publishDraft: (id, input, meta = {}) =>
    serial(async () => {
      const existing = find(id);
      if (!existing) return { notFound: true };
      const draft = drafts[id];
      const base = input.revision ?? draft?.baseRevision;
      const result = await publish({ ...input, revision: base }, existing, { note: 'Rascunho publicado', ...meta });
      if (result.api && draft) {
        await backend.deleteDraft(id);
        delete drafts[id];
      }
      return result;
    }),

  // ----- history -----
  versions: (id) => backend.listVersions(id),
  version: (id, revision) => backend.getVersion(id, revision),

  /** Publishes an old revision again (as a new revision, so the history keeps everything). */
  /** @returns {Promise<SaveResult>} */
  restore: (id, revision, by = '') =>
    serial(async () => {
      const existing = find(id);
      if (!existing) return { notFound: true };
      const data = await backend.getVersion(id, revision);
      if (!data) return { notFound: true };
      return publish({ ...data, revision: existing.revision }, existing, { by, note: `Restaurada a versão ${revision}` });
    }),
};

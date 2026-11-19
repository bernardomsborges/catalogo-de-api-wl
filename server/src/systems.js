/**
 * Consumer systems (PRO-166): which systems use each API and, when known, which routes. Before changing
 * an API, the team sees who depends on it and whom to warn.
 *
 * [{ id, name, owner, contactEmail, description, uses: [{ apiId, routes: ['GET /path', ...] }],
 *    createdAt, updatedAt, updatedBy }]
 * `routes` empty = the system uses the API as a whole (any breaking change affects it).
 * Routes are kept as "METHOD /path", the same key the breaking-change report uses.
 */
const crypto = require('crypto');
const path = require('path');
const { docStore } = require('./db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const SYSTEMS_FILE = process.env.SYSTEMS_FILE || path.join(path.dirname(DATA_FILE), 'systems.json');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @type {any[]} */
let systems = [];
const doc = docStore('systems', SYSTEMS_FILE);

async function init() {
  systems = (await doc.load({ systems: [] })).systems || [];
  return `${systems.length} sistema(s) consumidor(es)`;
}

const persist = () => doc.save({ systems });
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const routeKey = (e) => `${e.method} ${e.path}`;

function list() {
  return [...systems].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/**
 * Checks and normalizes a system. `apis`: the catalog — unknown APIs and routes are dropped, so a
 * system never points to something that doesn't exist.
 */
function normalize(input, apis) {
  const name = clean(input?.name, 120);
  const owner = clean(input?.owner, 120);
  const contactEmail = clean(input?.contactEmail, 254).toLowerCase();
  const errors = [];
  if (!name) errors.push('Informe o nome do sistema.');
  if (contactEmail && !EMAIL.test(contactEmail)) errors.push('O e-mail de contato é inválido.');
  const byId = new Map(apis.map((a) => [a.id, a]));
  /** @type {Map<string, string[]>} */
  const uses = new Map();
  for (const u of Array.isArray(input?.uses) ? input.uses : []) {
    const api = byId.get(String(u?.apiId));
    if (!api || uses.has(api.id)) continue;
    const known = new Set((api.endpoints || []).map(routeKey));
    uses.set(api.id, [...new Set((Array.isArray(u.routes) ? u.routes : []).map(String))].filter((r) => known.has(r)));
  }
  if (!uses.size) errors.push('Escolha ao menos uma API que o sistema usa.');
  return {
    errors,
    data: { name, owner, contactEmail, description: clean(input?.description, 500), uses: [...uses].map(([apiId, routes]) => ({ apiId, routes })) },
  };
}

function save(id, input, apis, by = '') {
  const existing = id ? systems.find((s) => s.id === id) : null;
  if (id && !existing) return { notFound: true };
  const { errors, data } = normalize(input, apis);
  if (errors.length) return { error: errors.join(' ') };
  if (systems.some((s) => s.id !== id && s.name.toLowerCase() === data.name.toLowerCase())) return { error: `Já existe um sistema chamado “${data.name}”.` };
  const now = new Date().toISOString();
  const system = { ...(existing || { id: crypto.randomUUID(), createdAt: now }), ...data, updatedAt: now, updatedBy: by };
  systems = existing ? systems.map((s) => (s.id === id ? system : s)) : [...systems, system];
  persist();
  return { system };
}

function remove(id) {
  if (!systems.some((s) => s.id === id)) return { notFound: true };
  systems = systems.filter((s) => s.id !== id);
  persist();
  return {};
}

/** Systems that use an API, each with the routes it uses (empty = the whole API). */
function consumersOf(apiId) {
  return list()
    .map((s) => ({ s, use: s.uses.find((u) => u.apiId === apiId) }))
    .filter((x) => x.use)
    .map(({ s, use }) => ({ id: s.id, name: s.name, owner: s.owner, contactEmail: s.contactEmail, description: s.description, routes: use.routes }));
}

/** An API was deleted: no system keeps pointing to it. */
function removeApi(apiId) {
  if (!systems.some((s) => s.uses.some((u) => u.apiId === apiId))) return;
  systems = systems.map((s) => ({ ...s, uses: s.uses.filter((u) => u.apiId !== apiId) }));
  persist();
}

/**
 * Approved access requests whose person and API aren't linked to any system yet: each one is a
 * system the team may want to register (who asked, for which API, and why).
 * `requests`: from accounts.listRequests('approved'); `apis`: the catalog (group → APIs).
 */
function suggestions(requests, apis) {
  const linked = new Set(systems.flatMap((s) => (s.contactEmail ? s.uses.map((u) => `${s.contactEmail}|${u.apiId}`) : [])));
  const out = [];
  for (const r of requests) {
    if (!r.user) continue;
    const apiIds = r.apiId ? [r.apiId] : apis.filter((a) => (a.groups || []).includes(r.groupId)).map((a) => a.id);
    const missing = apiIds.filter((id) => !linked.has(`${r.user.email}|${id}`) && apis.some((a) => a.id === id));
    if (!missing.length) continue;
    out.push({
      requestId: r.id,
      person: r.user,
      apis: missing.map((id) => ({ id, name: apis.find((a) => a.id === id).name })),
      message: r.message || '',
      decidedAt: r.decidedAt || r.createdAt,
    });
  }
  return out.sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

module.exports = { init, list, save, remove, consumersOf, removeApi, suggestions, routeKey };

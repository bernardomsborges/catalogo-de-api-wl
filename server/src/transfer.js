/**
 * Export and import of APIs (and ReceAPItos) between catalogs, e.g. homologação → produção.
 * The file is plain JSON. APIs and ReceAPItos are matched by slug, because ids differ between
 * catalogs; private APIs carry their groups by name for the same reason.
 * Only the published documentation travels: drafts, history, followers, health checks and
 * OpenAPI sync settings (which hold credentials) stay where they are.
 */
const store = require('./store');
const recipes = require('./recipes');
const accounts = require('./accounts');

const FORMAT = 'catalogo-de-apis';
const VERSION = 1;

const groupNamesById = () => Object.fromEntries(accounts.listGroups().map((g) => [g.id, g.name]));
const groupIdsByName = () => Object.fromEntries(accounts.listGroups().map((g) => [g.name.toLowerCase(), g.id]));

// ----- export -----

function portableApi(api, names) {
  const { id: _id, createdAt: _c, updatedAt: _u, revision: _r, ...rest } = structuredClone(api);
  rest.endpoints = (rest.endpoints || []).map(({ id: _e, ...e }) => e);
  rest.groups = (rest.groups || []).map((g) => names[g]).filter(Boolean);
  return rest;
}

const apiSlugOf = (step) => store.get(step.apiId)?.slug || step.apiSlug || '';

function portableRecipe(recipe) {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = structuredClone(recipe);
  rest.steps = rest.steps.map(({ id: _s, apiId: _a, ...s }) => ({ ...s, apiSlug: apiSlugOf({ apiId: _a, apiSlug: s.apiSlug }) }));
  return rest;
}

/** `apiIds`: which APIs (missing = all). ReceAPItos go along when every API they use is in the file. */
/** @param {{ apiIds?: string[], includeRecipes?: boolean }} [options] */
function exportBundle({ apiIds, includeRecipes = true } = {}) {
  const wanted = Array.isArray(apiIds) ? new Set(apiIds.map(String)) : null;
  const apis = store.list().filter((a) => !wanted || wanted.has(a.id));
  const names = groupNamesById();
  const slugs = new Set(apis.map((a) => a.slug));
  const recipeList = includeRecipes ? recipes.list().filter((r) => r.steps.every((s) => slugs.has(apiSlugOf(s)))) : [];
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    source: process.env.PUBLIC_URL || '',
    apis: apis.map((a) => portableApi(a, names)),
    recipes: recipeList.map(portableRecipe),
  };
}

// ----- import -----

function checkBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.format !== FORMAT) return 'Este arquivo não é uma exportação do Catálogo de APIs.';
  if (Number(bundle.version) > VERSION) return 'Este arquivo veio de uma versão mais nova do catálogo. Atualize este sistema antes de importar.';
  if (!Array.isArray(bundle.apis)) return 'O arquivo não tem a lista de APIs.';
  if (bundle.recipes != null && !Array.isArray(bundle.recipes)) return 'A lista de ReceAPItos do arquivo é inválida.';
  return '';
}

const slugOf = (x) => store.slugify(x?.slug || x?.name);
const recipeSlugOf = (x) => store.slugify(x?.slug || x?.title);

/** The API as it would be saved here: groups by id, and endpoint ids kept where the route already exists. */
function resolveApi(item, existing, ids) {
  const input = structuredClone(item);
  input.groups = (item.groups || []).map((n) => ids[String(n).toLowerCase()]).filter(Boolean);
  const endpointId = new Map((existing?.endpoints || []).map((e) => [`${e.method} ${e.path}`, e.id]));
  input.endpoints = (Array.isArray(item.endpoints) ? item.endpoints : []).map((e) => ({ ...e, id: endpointId.get(`${e?.method} ${e?.path}`) }));
  return input;
}

/** What matters when comparing two versions of an API (no ids, dates or revision). */
function apiFingerprint(api) {
  const { id: _i, createdAt: _c, updatedAt: _u, revision: _r, ...rest } = store.normalize(api, api);
  // Ids of deleted groups don't count (they are left out of the export).
  rest.groups = rest.groups.filter(accounts.groupExists);
  return JSON.stringify({ ...rest, endpoints: rest.endpoints.map(({ id: _e, ...e }) => e) });
}

function resolveRecipe(item, apiIdBySlug) {
  const input = structuredClone(item);
  input.steps = Array.isArray(item.steps) ? item.steps.map((s) => ({ ...s, apiId: apiIdBySlug(s?.apiSlug) || '' })) : item.steps;
  return input;
}

function recipeFingerprint(recipe) {
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = recipes.normalize(recipe, recipe);
  return JSON.stringify({ ...rest, steps: rest.steps.map(({ id: _s, apiId, apiSlug, ...s }) => ({ ...s, api: apiSlugOf({ apiId, apiSlug }) })) });
}

/** Repeated slugs inside the file: only the first one is used. */
function duplicates(list, slugFn) {
  const seen = new Set();
  return list.map((x) => {
    const slug = slugFn(x);
    const dup = !!slug && seen.has(slug);
    seen.add(slug);
    return dup;
  });
}

/** Preview: what each item of the file would do here. Nothing is saved. */
function preview(bundle) {
  const bad = checkBundle(bundle);
  if (bad) return { error: bad };
  const ids = groupIdsByName();
  const missingGroups = new Set();

  const apiDup = duplicates(bundle.apis, slugOf);
  const apis = bundle.apis.map((item, i) => {
    const slug = slugOf(item || {});
    const existing = store.get(slug)?.slug === slug ? store.get(slug) : null;
    const row = { slug, name: String(item?.name || slug || `API ${i + 1}`), action: existing ? 'update' : 'create', errors: [], warnings: [] };
    if (apiDup[i]) return { ...row, action: 'invalid', errors: [`Aparece mais de uma vez no arquivo com o identificador "${slug}".`] };
    const errors = store.validate(item, existing?.id);
    if (errors.length) return { ...row, action: 'invalid', errors };
    const missing = item.visibility === 'private' ? (item.groups || []).filter((n) => !ids[String(n).toLowerCase()]) : [];
    missing.forEach((n) => missingGroups.add(String(n)));
    if (missing.length) row.missingGroups = missing.map(String);
    if (existing) {
      const next = store.normalize(resolveApi(item, existing, ids), existing);
      if (!missing.length && apiFingerprint(next) === apiFingerprint(existing)) row.action = 'same';
      else if (store.getDraft(existing.id)) row.warnings.push('Tem um rascunho aqui, que ficará desatualizado.');
    }
    return row;
  });

  const valid = new Set(apis.filter((a) => a.action !== 'invalid').map((a) => a.slug));
  const list = bundle.recipes || [];
  const recipeDup = duplicates(list, recipeSlugOf);
  const recipeRows = list.map((item, i) => {
    const slug = recipeSlugOf(item || {});
    const existing = recipes.get(slug)?.slug === slug ? recipes.get(slug) : null;
    const row = { slug, name: String(item?.title || slug || `ReceAPIto ${i + 1}`), action: existing ? 'update' : 'create', errors: [], warnings: [], needsApis: [] };
    if (recipeDup[i]) return { ...row, action: 'invalid', errors: [`Aparece mais de uma vez no arquivo com o identificador "${slug}".`] };
    const used = [...new Set((Array.isArray(item?.steps) ? item.steps : []).map((s) => String(s?.apiSlug || '')))];
    const unknown = used.filter((s) => !(store.get(s)?.slug === s) && !valid.has(s));
    if (unknown.length) return { ...row, action: 'invalid', errors: [`Usa API(s) que não existem aqui nem no arquivo: ${unknown.map((s) => s || '(sem identificador)').join(', ')}.`] };
    row.needsApis = used.filter((s) => valid.has(s) && !(store.get(s)?.slug === s));
    const input = resolveRecipe(item, (s) => store.get(s)?.id || (valid.has(s) ? 'novo' : ''));
    const errors = recipes.validate(input, existing?.id);
    if (errors.length) return { ...row, action: 'invalid', errors };
    if (existing && !row.needsApis.length && recipeFingerprint(recipes.normalize(input, existing)) === recipeFingerprint(existing)) row.action = 'same';
    return row;
  });

  return {
    plan: {
      exportedAt: bundle.exportedAt || null,
      source: bundle.source || '',
      apis,
      recipes: recipeRows,
      missingGroups: [...missingGroups],
    },
  };
}

/**
 * Saves the chosen items (`apis` and `recipes`: lists of slugs). APIs go first, so ReceAPItos can
 * point to the ones just created. Each API change is a new revision, so it can be undone in the history.
 */
async function apply(bundle, { apis: apiSlugs = [], recipes: recipeSlugs = [], createGroups = false } = {}, ctx = {}) {
  const bad = checkBundle(bundle);
  if (bad) return { error: bad };
  const pickApis = new Set(apiSlugs.map(String));
  const pickRecipes = new Set(recipeSlugs.map(String));
  const results = [];
  const seenApis = new Set();
  const chosen = bundle.apis.filter((item) => {
    const slug = slugOf(item || {});
    if (!pickApis.has(slug) || seenApis.has(slug)) return false;
    seenApis.add(slug);
    return true;
  });

  if (createGroups && ctx.canCreateGroups) {
    const ids = groupIdsByName();
    const names = new Set(chosen.filter((a) => a.visibility === 'private').flatMap((a) => (a.groups || []).map(String)));
    for (const name of names) {
      if (ids[name.toLowerCase()]) continue;
      const r = accounts.saveGroup(null, { name });
      results.push(r.group ? { kind: 'group', slug: name, name, action: 'created' } : { kind: 'group', slug: name, name, action: 'error', message: r.error });
    }
  }
  const ids = groupIdsByName();

  for (const item of chosen) {
    const slug = slugOf(item);
    const name = String(item.name || slug);
    const existing = store.get(slug)?.slug === slug ? store.get(slug) : null;
    try {
      const input = resolveApi(item, existing, ids);
      if (existing && apiFingerprint(store.normalize(input, existing)) === apiFingerprint(existing)) {
        results.push({ kind: 'api', slug, name, action: 'unchanged' });
        continue;
      }
      const before = existing ? structuredClone(existing) : null;
      const meta = { by: ctx.by, note: 'Importada' };
      const r = existing ? await store.update(existing.id, { ...input, revision: existing.revision }, meta) : await store.create(input, meta);
      if (r.api) {
        results.push({ kind: 'api', slug, name, action: existing ? 'updated' : 'created', id: r.api.id });
        if (before) ctx.onUpdated?.(before, r.api);
      } else {
        results.push({ kind: 'api', slug, name, action: 'error', message: r.errors?.join(' ') || r.conflict || 'Não foi possível salvar.' });
      }
    } catch (err) {
      results.push({ kind: 'api', slug, name, action: 'error', message: err.message });
    }
  }

  const seenRecipes = new Set();
  for (const item of bundle.recipes || []) {
    const slug = recipeSlugOf(item || {});
    if (!pickRecipes.has(slug) || seenRecipes.has(slug)) continue;
    seenRecipes.add(slug);
    const name = String(item.title || slug);
    const missing = (Array.isArray(item.steps) ? item.steps : []).map((s) => String(s?.apiSlug || '')).filter((s) => !(store.get(s)?.slug === s));
    if (missing.length) {
      results.push({ kind: 'recipe', slug, name, action: 'error', message: `Faltam as APIs: ${[...new Set(missing)].join(', ')}. Importe-as junto.` });
      continue;
    }
    const existing = recipes.get(slug)?.slug === slug ? recipes.get(slug) : null;
    const input = resolveRecipe(item, (s) => store.get(s)?.id);
    if (existing) {
      const errors = recipes.validate(input, existing.id);
      if (!errors.length && recipeFingerprint(recipes.normalize(input, existing)) === recipeFingerprint(existing)) {
        results.push({ kind: 'recipe', slug, name, action: 'unchanged' });
        continue;
      }
    }
    const r = existing ? recipes.update(existing.id, input) : recipes.create(input);
    results.push(r.recipe ? { kind: 'recipe', slug, name, action: existing ? 'updated' : 'created' } : { kind: 'recipe', slug, name, action: 'error', message: r.errors?.join(' ') || 'Não foi possível salvar.' });
  }

  return { results };
}

module.exports = { exportBundle, preview, apply };

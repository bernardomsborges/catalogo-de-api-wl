/**
 * Recipes: real tasks done with several routes in order. Stored in PostgreSQL when DATABASE_URL is
 * set, otherwise in RECIPES_FILE (default: recipes.json next to DATA_FILE). The browser builds the code examples from the steps.
 */
const path = require('path');
const crypto = require('crypto');
const { docStore } = require('./db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'apis.json');
const RECIPES_FILE = process.env.RECIPES_FILE || path.join(path.dirname(DATA_FILE), 'recipes.json');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PARAM_IN = ['path', 'query', 'header'];
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

let recipes = [];
const doc = docStore('recipes', RECIPES_FILE);
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

async function init() {
  recipes = await doc.load([]);
}

function persist() {
  doc.save(recipes);
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const str = (v, max = 20_000) => String(v ?? '').slice(0, max);

function validate(input, currentId) {
  const errors = [];
  if (!input || typeof input !== 'object') return ['Corpo da requisição inválido.'];
  if (!str(input.title).trim()) errors.push('O título é obrigatório.');
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) errors.push('Inclua pelo menos um passo.');
  steps.forEach((s, i) => {
    const n = `Passo ${i + 1}`;
    if (!s || typeof s !== 'object') return errors.push(`${n}: inválido.`);
    if (!s.apiId && !s.apiSlug) errors.push(`${n}: escolha a API.`);
    if (!METHODS.includes(s.method)) errors.push(`${n}: método inválido.`);
    if (!str(s.path).startsWith('/')) errors.push(`${n}: escolha a rota.`);
    (s.outputs || []).forEach((o) => {
      if (!VAR_NAME.test(str(o?.name))) errors.push(`${n}: nome de variável inválido "${str(o?.name)}" (use letras, números e _).`);
      if (!str(o?.path).trim()) errors.push(`${n}: informe de onde vem a variável ${str(o?.name)}.`);
    });
    if (str(s.body).trim()) {
      try {
        JSON.parse(s.body);
      } catch {
        errors.push(`${n}: o corpo não é um JSON válido (as {{VARIÁVEIS}} devem ficar entre aspas).`);
      }
    }
  });
  const slug = slugify(input.slug || input.title);
  if (!slug) errors.push('Não foi possível gerar o identificador (slug).');
  if (recipes.some((r) => r.slug === slug && r.id !== currentId)) errors.push(`Já existe um ReceAPIto com o identificador "${slug}".`);
  return errors;
}

function normalize(input, existing) {
  const now = new Date().toISOString();
  const inputs = {};
  for (const [k, v] of Object.entries(input.inputs || {})) if (VAR_NAME.test(k) && str(v).trim()) inputs[k] = str(v, 500).trim();
  return {
    id: existing?.id || crypto.randomUUID(),
    slug: slugify(input.slug || input.title),
    title: str(input.title, 200).trim(),
    goal: str(input.goal, 500).trim(),
    intro: str(input.intro),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => str(t, 60).trim()).filter(Boolean) : [],
    inputs,
    steps: input.steps.map((s) => ({
      id: s.id || crypto.randomUUID(),
      title: str(s.title, 200).trim(),
      description: str(s.description),
      apiId: str(s.apiId, 100),
      ...(s.apiSlug ? { apiSlug: str(s.apiSlug, 200) } : {}),
      method: s.method,
      path: str(s.path, 500),
      params: (Array.isArray(s.params) ? s.params : [])
        .filter((p) => p && PARAM_IN.includes(p.in) && str(p.name).trim())
        .map((p) => ({ in: p.in, name: str(p.name, 200).trim(), value: str(p.value, 2000) })),
      body: str(s.body),
      outputs: (Array.isArray(s.outputs) ? s.outputs : []).map((o) => ({ name: str(o.name, 60).trim(), path: str(o.path, 300).trim() })),
    })),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

module.exports = {
  init,
  /** Called after any recipe change (the AI index uses it). */
  onChange: (fn) => listeners.add(fn),
  list: () => recipes,
  /** Validation and the saved shape of an input, without saving (used by the import preview). */
  validate,
  normalize,
  get: (idOrSlug) => recipes.find((r) => r.id === idOrSlug || r.slug === idOrSlug),
  create(input) {
    const errors = validate(input);
    if (errors.length) return { errors };
    const recipe = normalize(input);
    recipes.push(recipe);
    persist();
    changed();
    return { recipe };
  },
  update(id, input) {
    const existing = recipes.find((r) => r.id === id);
    if (!existing) return { notFound: true };
    const errors = validate(input, id);
    if (errors.length) return { errors };
    const recipe = normalize(input, existing);
    recipes = recipes.map((r) => (r.id === id ? recipe : r));
    persist();
    changed();
    return { recipe };
  },
  remove(id) {
    const before = recipes.length;
    recipes = recipes.filter((r) => r.id !== id);
    if (recipes.length === before) return false;
    persist();
    changed();
    return true;
  },
};

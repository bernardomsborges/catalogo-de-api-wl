/**
 * Search index of the catalog for the AI (PRO-149). One document per route (and per recipe), with
 * what someone needs to pick it: API, method, path, title, description, parameter and field names,
 * required credentials. Example values and credential examples are left out on purpose.
 *
 * Search mixes meaning (embeddings, when the AI provider is configured) with words (BM25), so it
 * still works — by words only — when the provider is off or failing. Kept up to date on every
 * API/recipe change, without restarts.
 */
const path = require('path');
const crypto = require('crypto');
const llm = require('./llm');
const { docStore } = require('../db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', '..', 'data', 'apis.json');
const CACHE_FILE = process.env.AI_EMBEDDINGS_FILE || path.join(path.dirname(DATA_FILE), 'ai-embeddings.json');

/** { [docId]: { id, kind, apiId, apiSlug, apiName, method, path, title, link, text, hash } } */
const docs = new Map();
/** Embeddings by text hash (persisted, so restarts don't pay again). */
let vectors = new Map();
const cacheDoc = docStore('ai-embeddings', CACHE_FILE, { pretty: false });
let lastError = '';
let pending = Promise.resolve();

async function init() {
  vectors = new Map(Object.entries(await cacheDoc.load({})));
}

let saveTimer = null;
function saveCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Only vectors still in use.
    const used = new Set([...docs.values()].map((d) => d.hash));
    const obj = Object.fromEntries([...vectors].filter(([h]) => used.has(h)));
    cacheDoc.save(obj);
  }, 2000);
  saveTimer.unref?.();
}

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 24);

/** Same anchor as the API reference page. */
const anchorOf = (method, p) => 'ep-' + (method + p).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

/** Field names of a JSON example (values are never indexed). */
function fieldNames(json, limit = 40) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const out = new Set();
  const walk = (v, depth) => {
    if (out.size >= limit || depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return walk(v[0], depth + 1);
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return [...out];
}

/** Route that issues the API's own bearer token: configured on the credential, or the one answering access_token. */
function tokenRouteOf(api, scheme) {
  const m = /^\s*([A-Z]+)\s+(\S+)\s*$/i.exec(scheme.tokenEndpoint || '');
  const ep = m
    ? api.endpoints.find((e) => e.method === m[1].toUpperCase() && e.path === m[2])
    : api.endpoints.find((e) => e.responses.some((r) => r.status >= 200 && r.status < 300 && /"access_token"\s*:/.test(r.body || '')));
  return ep ? { method: ep.method, path: ep.path } : null;
}

/** Credentials an endpoint needs (names only), following the catalog rules (defaults, per-endpoint, any/all). */
function credentialsOf(api, ep) {
  const schemes = api.auth?.schemes?.length ? api.auth.schemes : [];
  const keys = ep.security ?? api.auth?.defaults;
  const list = keys ? schemes.filter((s) => keys.includes(s.key)) : schemes;
  const label = (s) => (s.type === 'apiKey' ? `${s.name} (${s.in === 'query' ? 'query' : s.in === 'cookie' ? 'cookie' : 'cabeçalho'})` : s.type === 'bearer' ? 'Token Bearer' : s.type === 'basic' ? 'Basic' : 'OAuth 2.0');
  if (!list.length) return { names: schemes.length ? ['nenhuma (rota pública)'] : [], mode: 'all', tokenRoute: null };
  const bearer = list.find((s) => s.type === 'bearer');
  const tokenRoute = bearer ? tokenRouteOf(api, bearer) : null;
  return { names: list.map(label), mode: api.auth?.mode === 'any' && list.length > 1 ? 'any' : 'all', tokenRoute };
}

const clip = (t, n) => (String(t || '').length > n ? String(t).slice(0, n) + '…' : String(t || ''));

function endpointDoc(api, ep) {
  const cred = credentialsOf(api, ep);
  const params = ep.parameters.map((p) => `${p.name} (${p.in}${p.required ? ', obrigatório' : ''})${p.description ? ': ' + clip(p.description, 160) : ''}`);
  const okResponse = ep.responses.find((r) => r.status >= 200 && r.status < 300);
  const text = [
    `API: ${api.name}${api.category ? ` (${api.category})` : ''}`,
    `Rota: ${ep.method} ${ep.path}`,
    ep.summary && `Título: ${ep.summary}`,
    ep.description && `Descrição: ${clip(ep.description, 800)}`,
    params.length && `Parâmetros: ${params.join('; ')}`,
    ep.requestBody?.trim() && `Campos do corpo: ${fieldNames(ep.requestBody).join(', ')}`,
    okResponse?.body?.trim() && `Campos da resposta: ${fieldNames(okResponse.body).join(', ')}`,
    `Respostas: ${ep.responses.map((r) => `${r.status}${r.description ? ' ' + clip(r.description, 60) : ''}`).join('; ')}`,
    cred.names.length && `Credenciais: ${cred.names.join(cred.mode === 'any' ? ' ou ' : ' + ')}${cred.tokenRoute ? ` (o token vem de ${cred.tokenRoute.method} ${cred.tokenRoute.path})` : ''}`,
    api.summary && `Sobre a API: ${clip(api.summary, 200)}`,
  ]
    .filter(Boolean)
    .join('\n');
  // What the embedding sees: what the route does, not every field of its answer.
  const embedText = [
    `${ep.method} ${ep.path}`,
    ep.summary,
    ep.description && clip(ep.description, 600),
    ep.parameters.length && `Parâmetros: ${ep.parameters.map((p) => p.name + (p.description ? ' ' + clip(p.description, 100) : '')).join('; ')}`,
    ep.requestBody?.trim() && `Envia: ${fieldNames(ep.requestBody, 20).join(', ')}`,
    `API ${api.name}`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id: `ep:${api.id}:${ep.method} ${ep.path}`,
    embedText,
    tokenRoute: cred.tokenRoute,
    kind: 'endpoint',
    apiId: api.id,
    apiSlug: api.slug,
    apiName: api.name,
    method: ep.method,
    path: ep.path,
    title: ep.summary || `${ep.method} ${ep.path}`,
    link: `/apis/${api.slug}/referencia#${anchorOf(ep.method, ep.path)}`,
    credentials: cred.names,
    credentialsMode: cred.mode,
    text,
  };
}

function recipeDoc(recipe, apis) {
  const steps = recipe.steps.map((s, i) => `${i + 1}. ${s.title || ''} (${s.method} ${s.path})`);
  const apiNames = [...new Set(recipe.steps.map((s) => apis.find((a) => a.id === s.apiId || a.slug === s.apiSlug)?.name).filter(Boolean))];
  return {
    id: `recipe:${recipe.id}`,
    kind: 'recipe',
    apiId: null,
    apiIds: [...new Set(recipe.steps.map((s) => apis.find((a) => a.id === s.apiId || a.slug === s.apiSlug)?.id).filter(Boolean))],
    apiSlug: null,
    apiName: apiNames.join(', '),
    title: recipe.title,
    link: `/receapitos/${recipe.slug}`,
    text: [`ReceAPIto (receita): ${recipe.title}`, recipe.goal && `Objetivo: ${recipe.goal}`, apiNames.length && `APIs: ${apiNames.join(', ')}`, `Passos: ${steps.join('; ')}`].filter(Boolean).join('\n'),
  };
  // (recipes embed their full text)
}

// ----- words (BM25) -----

const STOP = new Set('a o as os de da do das dos e em no na nos nas um uma uns umas para por com sem que como qual quais se ao aos à às é ser ter meu minha seu sua isso esta este essa esse eu voce você preciso quero fazer pelo pela'.split(' '));
const norm = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Light stemming: "processos" → "process", "documentos" → "document". */
const stem = (w) => (w.length > 4 ? w.replace(/(oes|aes|ais|eis|ns|s)$/, '').replace(/(ar|er|ir|ndo|cao|coes)$/, '') : w);
const tokens = (t) => norm(t).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

function bm25(queryTokens, list) {
  const N = list.length || 1;
  const avg = list.reduce((s, d) => s + d.tokens.length, 0) / N || 1;
  const df = new Map();
  for (const d of list) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  return list.map((d) => {
    let score = 0;
    for (const q of new Set(queryTokens)) {
      const tf = d.tokens.filter((t) => t === q).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.tokens.length / avg)));
    }
    return score;
  });
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ----- building -----

/** Embeds documents that don't have a vector yet (in the background, one batch at a time). */
function embedMissing() {
  if (!llm.embeddingsEnabled()) return pending;
  pending = pending.then(async () => {
    const todo = [...docs.values()].filter((d) => !vectors.has(d.hash));
    if (!todo.length) return;
    try {
      const vecs = await llm.embed(todo.map((d) => d.embedText || d.text));
      todo.forEach((d, i) => vectors.set(d.hash, vecs[i]));
      lastError = '';
      saveCache();
      console.log(`[ia] Índice: ${todo.length} trecho(s) com embeddings.`);
    } catch (err) {
      lastError = err.message;
      console.warn(`[aviso] Índice da IA sem embeddings (busca por palavras): ${err.message}`);
    }
  });
  return pending;
}

function put(doc) {
  doc.hash = hash(doc.embedText || doc.text);
  doc.tokens = tokens(`${doc.title} ${doc.title} ${doc.text}`);
  docs.set(doc.id, doc);
}

function indexApi(api) {
  for (const [id, d] of docs) if (d.kind === 'endpoint' && d.apiId === api.id) docs.delete(id);
  for (const ep of api.endpoints) put(endpointDoc(api, ep));
}

function removeApi(apiId) {
  for (const [id, d] of docs) if (d.kind === 'endpoint' && d.apiId === apiId) docs.delete(id);
}

function indexRecipes(recipes, apis) {
  for (const [id, d] of docs) if (d.kind === 'recipe') docs.delete(id);
  for (const r of recipes) put(recipeDoc(r, apis));
}

/** Full rebuild (startup). */
function rebuild(apis, recipes) {
  docs.clear();
  for (const a of apis) indexApi(a);
  indexRecipes(recipes, apis);
  return embedMissing();
}

/** An API was created/changed/removed: update its documents (and recipes that mention it). */
function onApiChange(event, api, apis, recipes) {
  if (event === 'remove') removeApi(api.id);
  else indexApi(api);
  indexRecipes(recipes, apis);
  return embedMissing();
}

function onRecipesChange(apis, recipes) {
  indexRecipes(recipes, apis);
  return embedMissing();
}

// ----- search -----

const queryVectors = new Map();
async function queryVector(q) {
  if (queryVectors.has(q)) return queryVectors.get(q);
  const [v] = await llm.embed([q]);
  if (queryVectors.size > 200) queryVectors.delete(queryVectors.keys().next().value);
  queryVectors.set(q, v);
  return v;
}

/**
 * Most relevant documents for a question. `api` (id or slug) limits to one API.
 * Returns docs with `score` (0–1) and how they were found.
 */
const expansions = new Map();
/** Search terms for a question, written by the model (cached; empty on failure). */
async function expandQuery(question) {
  const key = question.trim().toLowerCase();
  if (expansions.has(key)) return expansions.get(key);
  let terms = [];
  try {
    const out = await llm.chat(
      [
        {
          role: 'system',
          content:
            'Você ajuda a buscar rotas num catálogo de APIs. Dada a pergunta, gere termos de busca: palavras-chave, sinônimos em português e os equivalentes em inglês que costumam aparecer em títulos e caminhos de rotas (ex.: anexar → attach, external, documento; enviar → send). Responda só JSON: {"termos": ["..."]} com no máximo 15 termos curtos.',
        },
        { role: 'user', content: question },
      ],
      { json: true }
    );
    terms = (Array.isArray(out.termos) ? out.termos : []).map((t) => String(t).slice(0, 40)).slice(0, 15);
  } catch (err) {
    lastError = err.message;
  }
  if (expansions.size > 300) expansions.delete(expansions.keys().next().value);
  expansions.set(key, terms);
  return terms;
}

/**
 * Filter for search results: only routes of the APIs in `catalog`, and only ReceAPItos whose
 * every API is there. The catalog passed in is already limited to what the person may see.
 */
function allowFor(catalog) {
  const ids = new Set(catalog.map((a) => a.id));
  return (d) => (d.kind === 'recipe' ? (d.apiIds || []).every((id) => ids.has(id)) : ids.has(d.apiId));
}

/**
 * @param {string} question
 * @param {{ api?: string, limit?: number, kinds?: string[], expand?: boolean, allow?: (doc: any) => boolean }} [options]
 */
async function search(question, { api, limit = 8, kinds = ['endpoint', 'recipe'], expand = true, allow } = {}) {
  let list = [...docs.values()].filter((d) => kinds.includes(d.kind) && (!allow || allow(d)));
  if (api) list = list.filter((d) => d.apiId === api || d.apiSlug === api || d.apiIds?.includes(api));
  if (!list.length) return { results: [], mode: 'palavras' };
  // Without embeddings, the model widens the question with search terms (synonyms, English
  // words used in route titles…), so "anexar um PDF" still finds "Attach External Document".
  let extra = [];
  const useVectors = llm.embeddingsEnabled() && list.some((d) => vectors.has(d.hash));
  if (!useVectors && llm.enabled() && expand) extra = await expandQuery(question);
  const lex = bm25([...tokens(question), ...tokens(extra.join(' '))], list);
  const maxLex = Math.max(...lex, 0) || 1;
  let sem = null;
  if (useVectors) {
    try {
      const qv = await queryVector(question);
      sem = list.map((d) => (vectors.has(d.hash) ? cosine(qv, vectors.get(d.hash)) : 0));
      lastError = '';
    } catch (err) {
      lastError = err.message;
    }
  }
  const scored = list.map((d, i) => ({
    doc: d,
    score: sem ? 0.75 * Math.max(0, sem[i]) + 0.25 * (lex[i] / maxLex) : lex[i] / maxLex,
  }));
  const results = scored
    .filter((s) => s.score > (sem ? 0.15 : 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, score }) => ({ ...doc, score: Math.round(score * 1000) / 1000 }));
  return { results, mode: sem ? 'significado' : extra.length ? 'palavras+ia' : 'palavras' };
}

function status() {
  const all = [...docs.values()];
  return {
    enabled: llm.enabled(),
    semantic: llm.embeddingsEnabled(),
    documents: all.length,
    endpoints: all.filter((d) => d.kind === 'endpoint').length,
    recipes: all.filter((d) => d.kind === 'recipe').length,
    withEmbeddings: all.filter((d) => vectors.has(d.hash)).length,
    lastError,
  };
}

/** For tests/debug: the indexed text of a document. */
const textOf = (id) => docs.get(id)?.text;
/** The document of one route. */
const routeDoc = (apiId, method, p) => docs.get(`ep:${apiId}:${method} ${p}`);
const allDocs = () => [...docs.values()];

module.exports = { init, rebuild, onApiChange, onRecipesChange, search, allowFor, status, textOf, routeDoc, allDocs, whenReady: () => pending };

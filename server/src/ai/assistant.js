/**
 * "Perguntar" (PRO-151): the person describes a task; the assistant answers with the API and routes
 * to use, in order. The model only sees the routes found in the catalog index and must cite them by
 * reference ([R1], [R2]…); the server then checks every reference and every "METHOD /path" in the
 * answer against the catalog, so nothing invented reaches the person.
 *
 * Keys and tokens pasted in the question are removed before it goes to the model, and nothing is
 * stored except questions without an answer (anonymous, for documentation gaps).
 */
const crypto = require('crypto');
const path = require('path');
const { promptName } = require('../branding');
const llm = require('./llm');
const index = require('./catalog-index');
const { docStore } = require('../db/doc-store');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', '..', 'data', 'apis.json');
const GAPS_FILE = process.env.AI_GAPS_FILE || path.join(path.dirname(DATA_FILE), 'ai-gaps.json');
const MAX_GAPS = 500;
/** Score above which a search result counts as clearly related (for contacts and suggestions). */
const STRONG_MATCH = Number(process.env.AI_STRONG_MATCH) || 0.5;

/** Removes things that look like secrets: bearer tokens, keys, JWTs, long random strings, e-mails. */
function redact(text) {
  return String(text)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [removido]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[token removido]')
    .replace(/\b((?:x-)?api[-_]?key|token|senha|password|secret|chave)\s*[:=]\s*\S+/gi, '$1: [removido]')
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]+\b/g, '[valor removido]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-mail removido]');
}

/**
 * Questions the assistant couldn't answer: { id, question, api (slug of the page), at, resolvedAt?,
 * resolvedBy? }. The admin sees them grouped (PRO-198): they are where the documentation is missing.
 */
let gaps = [];
const gapsDoc = docStore('ai-gaps', GAPS_FILE);

async function init() {
  gaps = await gapsDoc.load([]);
  // Questions saved before they had an id.
  if (gaps.some((g) => !g.id)) {
    gaps = gaps.map((g) => (g.id ? g : { ...g, id: crypto.randomUUID() }));
    gapsDoc.save(gaps);
  }
}

function recordGap(question, api) {
  gaps.push({ id: crypto.randomUUID(), question, api: api || null, at: new Date().toISOString() });
  gaps = gaps.slice(-MAX_GAPS);
  gapsDoc.save(gaps);
}

/** The same question typed differently ("Como emitir boleto?" / "como emitir  boleto") gets one key. */
function gapKey(question) {
  return String(question)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Unanswered questions grouped by key, most recent first. A group is open while it has an open
 * question: asking again after it was marked as resolved opens it again.
 */
function gapGroups() {
  const groups = new Map();
  for (const g of gaps) {
    const key = gapKey(g.question);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, question: g.question, count: 0, open: 0, firstAt: g.at, lastAt: g.at, apis: [], resolvedAt: null, resolvedBy: null }));
    group.count++;
    if (!g.resolvedAt) group.open++;
    if (g.at >= group.lastAt) {
      group.lastAt = g.at;
      group.question = g.question; // the most recent wording
    }
    if (g.at < group.firstAt) group.firstAt = g.at;
    if (g.api && !group.apis.includes(g.api)) group.apis.push(g.api);
    if (g.resolvedAt && (!group.resolvedAt || g.resolvedAt > group.resolvedAt)) {
      group.resolvedAt = g.resolvedAt;
      group.resolvedBy = g.resolvedBy || null;
    }
  }
  return [...groups.values()].map((g) => ({ ...g, resolved: g.open === 0 })).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

/** Marks every question of a group as resolved (or open again). Returns false when there is none. */
function resolveGap(key, resolved, by) {
  const matching = gaps.filter((g) => gapKey(g.question) === key);
  if (!key || !matching.length) return false;
  const at = new Date().toISOString();
  for (const g of matching) {
    if (resolved && !g.resolvedAt) Object.assign(g, { resolvedAt: at, resolvedBy: by || '' });
    if (!resolved) {
      delete g.resolvedAt;
      delete g.resolvedBy;
    }
  }
  gapsDoc.save(gaps);
  return true;
}

const SYSTEM = `Você é o assistente do ${promptName()}. Ajuda quem vai integrar a descobrir QUAL API e QUAIS ROTAS usar para uma tarefa.

Regras:
- Use SOMENTE as rotas e ReceAPItos (receitas) listados em "Catálogo" (referências R1, R2…). Nunca invente rotas, parâmetros, campos ou APIs.
- Cite cada rota pela referência entre colchetes, por exemplo [R2]. Não escreva caminhos que não estejam na lista.
- Se várias rotas forem necessárias, coloque-as na ordem em que devem ser chamadas (ex.: primeiro criar a sessão).
- Nunca peça, aceite ou repita chaves, senhas ou tokens. Se a pessoa colar algum, diga para não compartilhar.
- Se nada na lista resolve a tarefa, responda found=false e diga isso claramente, sem tentar adivinhar.
- Se a pessoa pedir ajuda para montar no Power Automate (Desktop ou Cloud), indique as rotas do mesmo jeito e avise que cada passo traz o código pronto para colar nas abas "PA Desktop" e "PA Cloud". Não escreva você o código do Power Automate.
- Escreva em português do Brasil, de forma curta e direta.

Responda APENAS com um objeto JSON:
{"found": true|false,
 "answer": "explicação curta em Markdown, citando [R1], [R2]…",
 "steps": [{"ref": "R1", "why": "o que este passo faz"}],
 "main": "R1"}
"main" é a rota principal da tarefa (ou null).`;

const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'")\]]*)/g;

/**
 * Answers a question. `catalog` gives the APIs (for links/contacts and to check routes).
 * Returns { found, answer, steps, main, contacts, mode }.
 */
async function ask(question, { api, catalog }) {
  const clean = redact(question).trim();
  const apiObj = api ? catalog.find((a) => a.id === api || a.slug === api) : null;
  const { results, mode } = await index.search(clean, { api: apiObj?.id, limit: 10, allow: index.allowFor(catalog) });
  // Routes that need the API's own session token bring the route that issues it, so the
  // answer can start with "create the session" even when the question doesn't mention it.
  const context = [...results];
  for (const d of results) {
    if (d.kind !== 'endpoint' || !d.tokenRoute) continue;
    const session = index.routeDoc(d.apiId, d.tokenRoute.method, d.tokenRoute.path);
    if (session && !context.some((x) => x.id === session.id)) context.unshift(session);
  }
  const refs = context.slice(0, 12).map((d, i) => ({ ref: `R${i + 1}`, doc: d }));
  const contactsFor = (docs) => {
    const ids = [...new Set(docs.flatMap((d) => (d.apiIds ? d.apiIds : [d.apiId])).filter(Boolean))];
    const list = (ids.length ? ids.map((id) => catalog.find((a) => a.id === id)) : apiObj ? [apiObj] : []).filter(Boolean);
    const out = list.slice(0, 3).map((a) => ({ api: a.name, slug: a.slug, owner: a.owner || '', email: a.contactEmail || '' }));
    // Nothing related at all: the catalog team.
    if (!out.length) out.push({ api: null, slug: null, owner: process.env.CATALOG_CONTACT_NAME || 'Time do Catálogo de APIs', email: process.env.CATALOG_CONTACT_EMAIL || '' });
    return out;
  };

  const notFound = (answer) => {
    recordGap(clean, apiObj?.slug);
    return {
      found: false,
      answer: answer || 'Não encontrei no catálogo uma rota que resolva isso.',
      steps: [],
      main: null,
      // Only clearly related APIs (or the API of the page) — otherwise the catalog team.
      contacts: contactsFor(apiObj ? [] : results.filter((d) => d.score >= STRONG_MATCH).slice(0, 3)),
      mode,
      related: results.filter((d) => d.score >= STRONG_MATCH).slice(0, 3).map(publicDoc),
    };
  };

  if (!refs.length) return notFound();
  if (!llm.enabled()) {
    // Without the model: the best matches from the index, no generated text.
    return { found: true, answer: '', steps: refs.slice(0, 5).map(({ doc }) => ({ ...publicDoc(doc), why: '' })), main: null, contacts: [], mode, aiOff: true };
  }

  const catalogText = refs.map(({ ref, doc }) => `[${ref}] ${doc.kind === 'recipe' ? 'RECEITA' : 'ROTA'}\n${doc.text}`).join('\n\n');
  const scope = apiObj ? `A pessoa está na página da API "${apiObj.name}"; priorize essa API.\n\n` : '';
  const out = await llm.chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${scope}Catálogo:\n${catalogText}\n\nPergunta: ${clean}` },
    ],
    { json: true, maxTokens: 1200 }
  );

  const byRef = new Map(refs.map((r) => [r.ref, r.doc]));
  const steps = (Array.isArray(out.steps) ? out.steps : [])
    .map((s) => ({ doc: byRef.get(String(s.ref || '').replace(/[[\]\s]/g, '')), why: String(s.why || '').slice(0, 400) }))
    .filter((s) => s.doc)
    .map((s) => ({ ...publicDoc(s.doc), why: s.why }));
  if (!out.found || !steps.length) return notFound(linkify(String(out.answer || ''), byRef, catalog));

  const mainDoc = byRef.get(String(out.main || '').replace(/[[\]\s]/g, ''));
  return {
    found: true,
    answer: linkify(String(out.answer || ''), byRef, catalog),
    steps,
    main: mainDoc?.kind === 'endpoint' ? publicDoc(mainDoc) : steps.find((s) => s.kind === 'endpoint') ?? null,
    contacts: [],
    mode,
  };
}

/** [R2] → link to the route; "METHOD /path" not in the catalog is flagged. */
function linkify(answer, byRef, catalog) {
  let text = answer.replace(/\[(R\d+)\]/g, (m, ref) => {
    const d = byRef.get(ref);
    return d ? (d.kind === 'recipe' ? `[ReceAPIto “${d.title}”](${d.link})` : `[\`${d.method} ${d.path}\`](${d.link})`) : '';
  });
  text = text.replace(ROUTE, (m, method, p) => {
    const exists = catalog.some((a) => a.endpoints.some((e) => e.method === method && e.path === p.replace(/[.,;:]+$/, '')));
    return exists ? m : `${m} (rota não encontrada no catálogo)`;
  });
  return text.slice(0, 6000);
}

/** What the browser may see of an index document. */
function publicDoc(d) {
  return {
    kind: d.kind,
    apiSlug: d.apiSlug,
    apiName: d.apiName,
    method: d.method || null,
    path: d.path || null,
    title: d.title,
    link: d.link,
    credentials: d.credentials || [],
    credentialsMode: d.credentialsMode || 'all',
  };
}

/** Contacts for an answer without solution: the given APIs' teams, or the catalog team. */
function contacts(apis) {
  const out = apis.filter(Boolean).slice(0, 3).map((a) => ({ api: a.name, slug: a.slug, owner: a.owner || '', email: a.contactEmail || '' }));
  if (!out.length) out.push({ api: null, slug: null, owner: process.env.CATALOG_CONTACT_NAME || 'Time do Catálogo de APIs', email: process.env.CATALOG_CONTACT_EMAIL || '' });
  return out;
}

module.exports = { init, ask, redact, gaps: () => gaps, gapGroups, gapKey, resolveGap, publicDoc, recordGap, contacts };

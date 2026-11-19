/**
 * Catalog assistant with access to the catalog data (side button "Assistente").
 *
 * The model gets tools to read the catalog — list and detail APIs, search and detail routes, list
 * recipes, health status — and answers questions about it: which API/routes solve a task, which
 * APIs exist, who owns one, what is down, etc. Tools only return what the public portal already
 * shows: never sync/health credentials, drafts or subscriber e-mails.
 *
 * The final answer is checked against the catalog: steps must be real routes, and any
 * "METHOD /path" in the text that doesn't exist is flagged. Without tool support, it falls back
 * to the search-then-answer flow (assistant.js).
 */
const llm = require('./llm');
const { promptName } = require('../branding');
const index = require('./catalog-index');
const assistant = require('./assistant');

const MAX_ROUNDS = 6;
const MAX_TOOL_CHARS = 14_000;
const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'")\]]*)/g;
const STATUS_LABEL = { estavel: 'estável', beta: 'beta', depreciada: 'depreciada', 'em-desenvolvimento': 'em desenvolvimento' };
const HEALTH_LABEL = { up: 'no ar', degraded: 'instável', down: 'fora do ar', pending: 'verificando' };

const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const clip = (t, n) => (String(t || '').length > n ? String(t).slice(0, n) + '…' : String(t || ''));
const anchorOf = (method, p) => 'ep-' + (method + p).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'listar_apis',
      description: 'Lista as APIs do catálogo com categoria, status (estável, beta, depreciada…), versão, resumo, time responsável, contato, quantidade de rotas e saúde atual.',
      parameters: { type: 'object', properties: { categoria: { type: 'string' }, status: { type: 'string', description: 'estavel, beta, depreciada ou em-desenvolvimento' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detalhar_api',
      description: 'Detalhes de uma API: descrição, ambientes, credenciais exigidas, lista de rotas, guias, novidades recentes, saúde e ReceAPItos (receitas) que a usam.',
      parameters: { type: 'object', properties: { api: { type: 'string', description: 'slug ou nome da API' } }, required: ['api'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_rotas',
      description: 'Busca as rotas (e ReceAPItos) mais relevantes para uma tarefa descrita em linguagem natural.',
      parameters: { type: 'object', properties: { pergunta: { type: 'string' }, api: { type: 'string', description: 'slug para limitar a uma API (opcional)' } }, required: ['pergunta'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detalhar_rota',
      description: 'Detalhes de uma rota: parâmetros, campos enviados e recebidos, respostas e credenciais (inclusive de onde vem o token).',
      parameters: {
        type: 'object',
        properties: { api: { type: 'string', description: 'slug da API' }, metodo: { type: 'string' }, caminho: { type: 'string' } },
        required: ['api', 'metodo', 'caminho'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_receitas',
      description: 'Lista os ReceAPItos (antes chamados de receitas: tarefas de ponta a ponta com várias rotas), com objetivo e passos.',
      parameters: { type: 'object', properties: { api: { type: 'string', description: 'slug para filtrar (opcional)' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'status_das_apis',
      description: 'Situação atual de cada API monitorada (no ar, instável, fora do ar), tempo de resposta e disponibilidade em 90 dias.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const SYSTEM = `Você é o assistente do ${promptName()}.
Você tem ferramentas para consultar os dados do catálogo: APIs, rotas, ReceAPItos (o nome do catálogo para receitas) e status. Use-as sempre que precisar de algum dado — não responda de memória.

Você ajuda a:
- descobrir qual API e quais rotas resolvem uma tarefa, na ordem em que devem ser chamadas (ex.: criar a sessão antes);
- responder perguntas sobre o catálogo: quais APIs existem, status, versão, responsável, contato, credenciais, ReceAPItos, o que está fora do ar.

Regras:
- Use SOMENTE dados que vieram das ferramentas. Nunca invente APIs, rotas, parâmetros, campos, pessoas ou e-mails.
- Ao citar uma rota, escreva o método e o caminho exatos, ex.: \`POST /v1/sessions\`.
- Nunca peça, aceite ou repita chaves, senhas ou tokens. Se a pessoa colar algum, diga para não compartilhar.
- Se o catálogo não tem o que a pessoa procura, diga isso claramente (found=false).
- Permissões: algumas APIs são privadas. Você só recebe os detalhes das APIs que a pessoa pode acessar. Quando uma ferramenta indicar "acesso": "sem acesso", diga que a API existe (com nome, resumo e time responsável) mas que a pessoa não tem acesso aos detalhes, e oriente: entrar com a conta (se ela não entrou) ou usar o botão "Pedir acesso" na página da API. Nunca tente adivinhar rotas, campos ou regras dessas APIs.
- Português do Brasil, respostas curtas e diretas.

Quando terminar, responda APENAS com JSON:
{"found": true|false,
 "answer": "resposta em Markdown",
 "steps": [{"api": "slug", "method": "POST", "path": "/v1/...", "why": "o que este passo faz"}],
 "main": 0}
"steps" só quando a resposta envolve chamar rotas (na ordem); senão []. "main" é o índice do passo principal (ou null).`;

/** Finds an API by slug, id or (part of the) name. */
function findApi(catalog, ref) {
  const r = norm(ref);
  if (!r) return null;
  return catalog.find((a) => a.slug === ref || a.id === ref) || catalog.find((a) => norm(a.name) === r) || catalog.find((a) => norm(a.name).includes(r) || r.includes(norm(a.name)));
}

/** What the agent may say about a private API the person can't access: the summary only. */
function lockedInfo(a) {
  return {
    nome: a.name,
    slug: a.slug,
    categoria: a.category,
    status: STATUS_LABEL[a.status] || a.status,
    versao: a.version,
    resumo: clip(a.summary, 200),
    responsavel: a.owner || '',
    contato: a.contactEmail || '',
    acesso: 'sem acesso',
    aviso: 'API privada: a pessoa não tem acesso aos detalhes. Oriente a pedir acesso na página da API.',
    link: `/apis/${a.slug}`,
  };
}

function makeTools({ catalog, locked = [], recipes, health }) {
  const healthOf = (a) => {
    const h = health.publicView(a.id);
    return h.monitored ? HEALTH_LABEL[h.status] || h.status : 'sem monitoramento';
  };
  const recipesOf = (a) => recipes.list().filter((r) => r.steps.some((s) => s.apiId === a.id || s.apiSlug === a.slug));

  return {
    /** @param {{ categoria?: string, status?: string }} [filters] */
    listar_apis({ categoria, status } = {}) {
      let list = catalog;
      if (categoria) list = list.filter((a) => norm(a.category).includes(norm(categoria)));
      if (status) list = list.filter((a) => norm(a.status) === norm(status).replace(/\s+/g, '-') || norm(STATUS_LABEL[a.status]) === norm(status));
      return list.map((a) => ({
        nome: a.name,
        slug: a.slug,
        categoria: a.category,
        status: STATUS_LABEL[a.status] || a.status,
        versao: a.version,
        resumo: clip(a.summary, 200),
        responsavel: a.owner || '',
        contato: a.contactEmail || '',
        rotas: a.endpoints.length,
        saude: healthOf(a),
        acesso: 'liberado',
        link: `/apis/${a.slug}`,
      })).concat(
        locked
          .filter((a) => (!categoria || norm(a.category).includes(norm(categoria))) && (!status || norm(a.status) === norm(status).replace(/\s+/g, '-') || norm(STATUS_LABEL[a.status]) === norm(status)))
          .map(lockedInfo)
      );
    },

    detalhar_api({ api }) {
      const a = findApi(catalog, api);
      if (!a) {
        const l = findApi(locked, api);
        if (l) return lockedInfo(l);
        return { erro: `Nenhuma API encontrada para "${api}".`, apis_disponiveis: catalog.map((x) => x.slug) };
      }
      const h = health.publicView(a.id);
      return {
        nome: a.name,
        slug: a.slug,
        categoria: a.category,
        status: STATUS_LABEL[a.status] || a.status,
        versao: a.version,
        resumo: a.summary,
        descricao: clip(a.description, 1500),
        responsavel: a.owner || '',
        contato: a.contactEmail || '',
        url_base: a.baseUrl,
        ambientes: a.environments.map((e) => ({ nome: e.name, url: e.url })),
        credenciais: (a.auth?.schemes || []).map((s) => ({ tipo: s.type, nome: s.name || (s.type === 'bearer' ? 'Authorization: Bearer' : ''), onde: s.in, descricao: clip(s.description, 300) })),
        credenciais_juntas_ou_alternativas: a.auth?.mode === 'any' ? 'qualquer uma' : 'todas juntas',
        limites: a.rateLimit || '',
        sla: a.sla || '',
        rotas: a.endpoints.map((e) => `${e.method} ${e.path}${e.summary ? ' — ' + e.summary : ''}`),
        guias: a.guides.map((g) => g.title),
        novidades_recentes: a.changelog.slice(0, 3).map((c) => ({ versao: c.version, data: c.date, notas: clip(c.notes, 400) })),
        saude: h.monitored ? { status: HEALTH_LABEL[h.status] || h.status, tempo_ms: h.latencyMs, disponibilidade_90d: h.uptime90 } : 'sem monitoramento',
        receitas: recipesOf(a).map((r) => ({ titulo: r.title, link: `/receapitos/${r.slug}` })),
        link: `/apis/${a.slug}`,
      };
    },

    async buscar_rotas({ pergunta, api }) {
      const a = api ? findApi(catalog, api) : null;
      if (api && !a && findApi(locked, api)) return lockedInfo(findApi(locked, api));
      const { results } = await index.search(assistant.redact(String(pergunta || '')), { api: a?.id, limit: 8, allow: index.allowFor(catalog) });
      return results.map((d) =>
        d.kind === 'recipe'
          ? { tipo: 'ReceAPIto', titulo: d.title, apis: d.apiName, link: d.link }
          : { tipo: 'rota', api: d.apiSlug, nome_api: d.apiName, metodo: d.method, caminho: d.path, titulo: d.title, credenciais: d.credentials, token_vem_de: d.tokenRoute ? `${d.tokenRoute.method} ${d.tokenRoute.path}` : undefined }
      );
    },

    detalhar_rota({ api, metodo, caminho }) {
      const a = findApi(catalog, api);
      const m = String(metodo || '').toUpperCase();
      const ep = a?.endpoints.find((e) => e.method === m && e.path === caminho);
      if (!a && findApi(locked, api)) return lockedInfo(findApi(locked, api));
      if (!a || !ep) return { erro: `Rota ${m} ${caminho} não encontrada${a ? ' na API ' + a.name : ''}.` };
      const doc = index.routeDoc(a.id, ep.method, ep.path);
      return { api: a.slug, metodo: ep.method, caminho: ep.path, detalhes: doc?.text || '', link: `/apis/${a.slug}/referencia#${anchorOf(ep.method, ep.path)}` };
    },

    /** @param {{ api?: string }} [filters] */
    listar_receitas({ api } = {}) {
      const a = api ? findApi(catalog, api) : null;
      return recipes
        .list()
        .filter((r) => !a || r.steps.some((s) => s.apiId === a.id || s.apiSlug === a.slug))
        .map((r) => ({
          titulo: r.title,
          objetivo: r.goal,
          passos: r.steps.map((s) => `${s.method} ${s.path}`),
          link: `/receapitos/${r.slug}`,
        }));
    },

    status_das_apis() {
      return catalog.map((a) => {
        const h = health.publicView(a.id);
        return h.monitored
          ? { nome: a.name, slug: a.slug, status: HEALTH_LABEL[h.status] || h.status, desde: h.since, tempo_ms: h.latencyMs, disponibilidade_90d: h.uptime90 }
          : { nome: a.name, slug: a.slug, status: 'sem monitoramento' };
      });
    },
  };
}

/** Links route mentions to the reference; flags the ones that don't exist. */
function linkRoutes(text, catalog, preferred) {
  return String(text).replace(ROUTE, (m, method, raw) => {
    const p = raw.replace(/[.,;:]+$/, '');
    const tail = raw.slice(p.length);
    const owners = catalog.filter((a) => a.endpoints.some((e) => e.method === method && e.path === p));
    if (!owners.length) return `${m} (rota não encontrada no catálogo)`;
    const a = owners.find((x) => preferred.includes(x.slug)) || owners[0];
    return `[\`${method} ${p}\`](/apis/${a.slug}/referencia#${anchorOf(method, p)})${tail}`;
  });
}

/** Removes backticks around route mentions so they can become links. */
const unwrapRoutes = (text) => String(text).replace(/`((?:GET|POST|PUT|PATCH|DELETE)\s+\/[^`]*)`/g, '$1');

/**
 * Answers a question (with the conversation so far). Returns the same shape as assistant.ask:
 * { found, answer, steps, main, contacts, mode, related? }.
 */
/** Who is asking, for the model: whether they are logged in, their role and groups (no name or e-mail). */
function whoText(who) {
  if (!who) return 'Quem pergunta: visitante, sem login. APIs privadas só aparecem com o resumo; para ver os detalhes, a pessoa precisa entrar e ter acesso.';
  const role = { admin: 'administrador (vê todas as APIs)', editor: 'editor (vê todas as APIs)', consumer: 'consumidor' }[who.role] || who.role;
  const groups = who.groups?.length ? who.groups.map((g) => g.name).join(', ') : 'nenhum';
  return `Quem pergunta: pessoa com login, papel ${role}, grupos: ${groups}.`;
}

/**
 * `catalog`: APIs the person may access (full). `locked`: private APIs they can't, as summaries.
 * `recipes`: object with list() of the ReceAPItos they may see. `who`: the person (or null).
 */
async function ask(question, { api, history = [], catalog, locked = [], recipes, health, who = null }) {
  if (!llm.enabled()) return assistant.ask(question, { api, catalog });
  const clean = assistant.redact(question).trim();
  const page = api ? findApi(catalog, api) : null;
  const lockedPage = api && !page ? findApi(locked, api) : null;
  const tools = makeTools({ catalog, locked, recipes, health });
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: whoText(who) },
    ...history.slice(-8).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: assistant.redact(String(h.content || '')).slice(0, 2000) })),
    {
      role: 'user',
      content: page
        ? `(A pessoa está na página da API "${page.name}", slug ${page.slug}.)\n${clean}`
        : lockedPage
          ? `(A pessoa está na página da API "${lockedPage.name}", slug ${lockedPage.slug}, que é privada e ela não tem acesso.)\n${clean}`
          : clean,
    },
  ];
  const seenApis = new Set(page ? [page.slug] : []);

  let final = null;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const msg = await llm.chatWithTools(messages, TOOLS);
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        final = msg.content || '';
        break;
      }
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let result;
        try {
          const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          const fn = tools[call.function?.name];
          result = fn ? await fn(args) : { erro: `Ferramenta desconhecida: ${call.function?.name}` };
          for (const k of ['api', 'slug']) if (args[k]) seenApis.add(findApi(catalog, args[k])?.slug);
        } catch (err) {
          result = { erro: err.message };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: clip(JSON.stringify(result), MAX_TOOL_CHARS) });
      }
    }
  } catch (err) {
    if (err.toolsUnsupported) return assistant.ask(question, { api, catalog });
    throw err;
  }
  if (final == null) {
    // Too many rounds: ask for the answer with what was gathered.
    messages.push({ role: 'user', content: 'Responda agora com o que você já consultou, no formato JSON pedido.' });
    final = await llm.chat(messages);
  }

  let out;
  try {
    out = llm.parseJson(final);
  } catch {
    out = { found: !!String(final).trim(), answer: String(final), steps: [] };
  }

  // Steps: only real routes.
  const steps = [];
  for (const s of Array.isArray(out.steps) ? out.steps : []) {
    const method = String(s.method || '').toUpperCase();
    const path = String(s.path || '').trim();
    const a = findApi(catalog, s.api) || catalog.find((x) => x.endpoints.some((e) => e.method === method && e.path === path));
    const ep = a?.endpoints.find((e) => e.method === method && e.path === path);
    if (!a || !ep) continue;
    seenApis.add(a.slug);
    const doc = index.routeDoc(a.id, method, path);
    steps.push({ ...(doc ? assistant.publicDoc(doc) : { kind: 'endpoint', apiSlug: a.slug, apiName: a.name, method, path, title: ep.summary || `${method} ${path}`, link: `/apis/${a.slug}/referencia#${anchorOf(method, path)}`, credentials: [], credentialsMode: 'all' }), why: clip(s.why, 400) });
  }
  const answer = linkRoutes(unwrapRoutes(String(out.answer || '')), catalog, [...seenApis]).slice(0, 8000);
  const mainIdx = Number.isInteger(out.main) ? out.main : null;
  const main = (mainIdx != null && steps[mainIdx]) || steps.find((s) => s.method !== 'GET') || steps[0] || null;

  if (out.found === false) {
    assistant.recordGap(clean, page?.slug);
    return { found: false, answer: answer || 'Não encontrei isso no catálogo.', steps: [], main: null, contacts: assistant.contacts(page ? [page] : []), mode: 'agente' };
  }
  return { found: true, answer, steps, main, contacts: [], mode: 'agente' };
}

module.exports = { ask, TOOLS, makeTools };

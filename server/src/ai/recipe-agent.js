/**
 * "Montar com IA" in the ReceAPIto form: the admin describes the idea of the requests ("entrar no
 * SEI, abrir um processo e anexar um PDF") and the model drafts the ReceAPIto.
 *
 * - The routes come from the catalog: a search picks the candidates and the model can only choose
 *   among them by id ("r3"), so it can't invent a route. Steps with an unknown id are dropped.
 * - Parameters that aren't in the route, invalid variable names and response fields that aren't
 *   in the documented example come back as warnings, so the admin knows what to check.
 * - Nothing is saved here: the form shows the draft and the admin edits and saves it.
 */
const llm = require('./llm');
const { promptName } = require('../branding');
const aiIndex = require('./catalog-index');

/** Routes sent to the model per request (each one costs tokens). */
const MAX_ROUTES = 36;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'")\],;]*)/gi;

const clip = (t, n) => (String(t || '').length > n ? String(t).slice(0, n) + '…' : String(t || ''));
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const key = (apiId, method, path) => `${apiId} ${method} ${path}`;

/** Leaf paths of the success response example ("access_token", "unidades[0].id"). */
function responsePaths(ep, limit = 30) {
  const ok = (ep.responses || []).find((r) => r.status >= 200 && r.status < 300 && String(r.body || '').trim());
  if (!ok) return [];
  let data;
  try {
    data = JSON.parse(ok.body);
  } catch {
    return [];
  }
  const out = [];
  const walk = (v, path, depth) => {
    if (out.length >= limit || depth > 4) return;
    if (Array.isArray(v)) return v.length ? walk(v[0], `${path}[0]`, depth + 1) : undefined;
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (path) out.push(path);
  };
  walk(data, '', 0);
  return out;
}

/**
 * Routes the model may use: the ones the search finds for the idea, the ones written in the idea
 * ("POST /v1/sessions"), the ones already in the draft and the routes that issue the tokens.
 */
async function pickRoutes(text, draft, apis) {
  const picked = new Map();
  const add = (api, ep) => {
    if (api && ep && picked.size < MAX_ROUTES) picked.set(key(api.id, ep.method, ep.path), { api, ep });
  };
  const find = (apiRef, method, path) => {
    const api = apis.find((a) => a.id === apiRef || a.slug === apiRef);
    return [api, api?.endpoints.find((e) => e.method === method && e.path === path)];
  };

  // 1. What the draft already uses stays available.
  for (const s of draft?.steps || []) add(...find(s.apiId || s.apiSlug, s.method, s.path));

  // 2. Routes written out in the text.
  for (const m of String(text).matchAll(ROUTE)) {
    const method = m[1].toUpperCase();
    const path = m[2].replace(/[.:]+$/, '');
    for (const api of apis) add(api, api.endpoints.find((e) => e.method === method && e.path === path));
  }

  // 3. Search by meaning/words, limited to the APIs the admin can see.
  const { results } = await aiIndex.search(text, { kinds: ['endpoint'], limit: 24, allow: aiIndex.allowFor(apis) });
  const tokenRoutes = [];
  for (const d of results) {
    const [api, ep] = find(d.apiId, d.method, d.path);
    add(api, ep);
    if (api && d.tokenRoute) tokenRoutes.push([api, api.endpoints.find((e) => e.method === d.tokenRoute.method && e.path === d.tokenRoute.path)]);
  }

  // 4. An API named in the text contributes its first routes even if the search missed them.
  const folded = fold(text);
  for (const api of apis) {
    if (api.name.length > 3 && folded.includes(fold(api.name))) api.endpoints.slice(0, 12).forEach((ep) => add(api, ep));
  }

  // 5. Token routes last, but they must fit: they replace the tail if the list is full.
  const list = [...picked.values()];
  for (const [api, ep] of tokenRoutes) {
    if (!api || !ep || picked.has(key(api.id, ep.method, ep.path))) continue;
    if (list.length >= MAX_ROUTES) list.pop();
    list.unshift({ api, ep });
    picked.set(key(api.id, ep.method, ep.path), { api, ep });
  }
  return list;
}

/** What the model sees of each route. */
function brief(id, { api, ep }) {
  const doc = aiIndex.routeDoc(api.id, ep.method, ep.path);
  return {
    id,
    api: api.name,
    rota: `${ep.method} ${ep.path}`,
    titulo: ep.summary || '',
    descricao: clip(ep.description, 300),
    parametros: (ep.parameters || []).map((p) => ({ nome: p.name, onde: p.in, obrigatorio: !!p.required, ...(p.example ? { exemplo: clip(p.example, 60) } : {}), ...(p.description ? { descricao: clip(p.description, 120) } : {}) })),
    ...(String(ep.requestBody || '').trim() ? { corpo_exemplo: clip(ep.requestBody, 700) } : {}),
    campos_da_resposta: responsePaths(ep, 25),
    credenciais: doc?.credentials ?? [],
    ...(doc?.tokenRoute ? { token_vem_de: `${doc.tokenRoute.method} ${doc.tokenRoute.path}` } : {}),
  };
}

const SYSTEM = `Você ajuda a equipe do ${promptName()} a montar um "ReceAPIto": uma tarefa real feita com várias rotas de API em ordem, passo a passo. Escreva em português do Brasil, com tom claro, direto e cordial, para pessoas desenvolvedoras.

Você recebe a ideia da pessoa, as rotas disponíveis (cada uma com um "id") e, às vezes, o ReceAPIto atual para ajustar.

Regras:
- Use SOMENTE as rotas de "rotas_disponiveis", pelo "id". Nunca invente rota, parâmetro ou campo.
- Coloque os passos na ordem em que devem ser chamados. Se uma rota precisa de token e existe "token_vem_de", inclua antes o passo que obtém o token.
- Dados passam de um passo para outro por variáveis em MAIÚSCULAS (ex.: TOKEN, ID_PROCESSO). Em "guarda", diga qual campo da resposta vai para qual variável; use exatamente um caminho de "campos_da_resposta". Nos passos seguintes use a variável como {{VARIAVEL}}.
- O que a pessoa precisa informar (usuário, senha, chave de API, número de um processo…) também é variável {{ASSIM}}; descreva cada uma em "entradas". Nunca escreva senha, token ou chave de verdade.
- Em "parametros", preencha os de caminho e os obrigatórios, e os opcionais que a ideia pede. "onde" é "path", "query" ou "header".
- Em "corpo", devolva um objeto JSON baseado em "corpo_exemplo" (ou null se a rota não tem corpo). Variáveis ficam dentro de texto: "{{SENHA}}".
- Credenciais: para token Bearer use o cabeçalho Authorization com "Bearer {{TOKEN}}"; para chave de API use o parâmetro indicado em "credenciais" com uma variável.
- "explicacao" de cada passo: 1 ou 2 frases dizendo o que o passo faz e o que ele guarda.
- Se "receapito_atual" vier preenchido, aplique o pedido sobre ele e devolva o ReceAPIto inteiro, mantendo o que não foi pedido para mudar.
- Se as rotas disponíveis não bastam para a ideia, monte o que der, e diga em "duvidas" o que faltou. Se a ideia estiver vaga demais para montar qualquer passo, devolva "passos": [] e faça as perguntas em "duvidas".
- "mensagem": 1 a 3 frases para a pessoa, dizendo o que você montou e o que supôs.

Responda APENAS com um objeto JSON neste formato:
{"titulo": "...", "objetivo": "uma frase", "introducao": "Markdown curto, opcional", "etiquetas": ["..."], "entradas": {"VARIAVEL": "o que é"}, "passos": [{"rota": "r1", "titulo": "...", "explicacao": "...", "parametros": [{"onde": "path", "nome": "...", "valor": "..."}], "corpo": null, "guarda": [{"variavel": "TOKEN", "campo": "access_token"}]}], "mensagem": "...", "duvidas": ["..."]}`;

/** The current draft in the format the model answers with (routes by id). */
function draftForModel(draft, ids) {
  if (!draft?.steps?.some((s) => s.path)) return null;
  return {
    titulo: draft.title || '',
    objetivo: draft.goal || '',
    introducao: draft.intro || '',
    etiquetas: draft.tags || [],
    entradas: draft.inputs || {},
    passos: draft.steps
      .filter((s) => s.path)
      .map((s) => {
        let corpo = null;
        try {
          corpo = String(s.body || '').trim() ? JSON.parse(s.body) : null;
        } catch {
          corpo = s.body;
        }
        return {
          rota: ids.get(key(s.apiId, s.method, s.path)) ?? `${s.method} ${s.path} (não existe mais)`,
          titulo: s.title || '',
          explicacao: s.description || '',
          parametros: (s.params || []).map((p) => ({ onde: p.in, nome: p.name, valor: p.value })),
          corpo,
          guarda: (s.outputs || []).map((o) => ({ variavel: o.name, campo: o.path })),
        };
      }),
  };
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const varName = (v) => String(v || '').trim().replace(/^\{\{\s*|\s*\}\}$/g, '').replace(/[^A-Za-z0-9_]+/g, '_').toUpperCase();

/** Turns the model's answer into form steps, dropping what isn't in the catalog. */
function toRecipe(out, routes) {
  const warnings = [];
  const steps = [];
  (Array.isArray(out.passos) ? out.passos : []).forEach((p, i) => {
    const n = `Passo ${i + 1}`;
    const route = routes.get(String(p?.rota || '').trim());
    if (!route) return warnings.push(`${n} foi descartado: a IA indicou uma rota que não está no catálogo.`);
    const { api, ep } = route;
    const known = new Map((ep.parameters || []).map((x) => [`${x.in}:${x.name.toLowerCase()}`, x]));
    const params = [];
    for (const x of Array.isArray(p.parametros) ? p.parametros : []) {
      const where = { path: 'path', caminho: 'path', query: 'query', header: 'header', cabecalho: 'header', 'cabeçalho': 'header' }[String(x?.onde || '').toLowerCase()];
      const name = text(x?.nome, 200);
      if (!where || !name) continue;
      const value = x.valor == null ? '' : String(x.valor).slice(0, 2000);
      const inPath = where === 'path' && ep.path.includes(`{${name}}`);
      // Headers are free (Authorization, API keys); path and query must be in the route.
      if (where === 'header' || inPath || known.has(`${where}:${name.toLowerCase()}`)) params.push({ in: where, name, value });
      else warnings.push(`${n}: o parâmetro "${name}" não existe em ${ep.method} ${ep.path} e foi removido.`);
    }
    let body = '';
    if (!['GET', 'DELETE'].includes(ep.method) && p.corpo != null && p.corpo !== '') {
      if (typeof p.corpo === 'string') {
        try {
          body = JSON.stringify(JSON.parse(p.corpo), null, 2);
        } catch {
          warnings.push(`${n}: o corpo sugerido não é um JSON válido; ficou o exemplo da rota.`);
        }
      } else body = JSON.stringify(p.corpo, null, 2);
    }
    const fields = responsePaths(ep, 200);
    const outputs = [];
    for (const g of Array.isArray(p.guarda) ? p.guarda : []) {
      const name = varName(g?.variavel);
      const path = text(g?.campo, 300);
      if (!VAR_NAME.test(name) || !path) continue;
      if (fields.length && !fields.includes(path)) warnings.push(`${n}: confira a variável ${name} — o campo "${path}" não aparece no exemplo de resposta da rota.`);
      else if (!fields.length) warnings.push(`${n}: confira a variável ${name} — a rota não tem exemplo de resposta para conferir o campo "${path}".`);
      outputs.push({ name, path });
    }
    steps.push({
      title: text(p.titulo, 200) || ep.summary || `${ep.method} ${ep.path}`,
      description: text(p.explicacao, 2000),
      apiId: api.id,
      apiSlug: api.slug,
      method: ep.method,
      path: ep.path,
      params,
      body,
      // The form fills the body example when the model left it out.
      bodyFromModel: !!body,
      outputs,
    });
  });

  const inputs = {};
  for (const [k, v] of Object.entries(out.entradas && typeof out.entradas === 'object' ? out.entradas : {})) {
    const name = varName(k);
    if (VAR_NAME.test(name) && text(v, 500)) inputs[name] = text(v, 500);
  }
  return {
    recipe: {
      title: text(out.titulo, 200),
      goal: text(out.objetivo, 500),
      intro: text(out.introducao, 20_000),
      tags: (Array.isArray(out.etiquetas) ? out.etiquetas : []).map((t) => text(t, 60)).filter(Boolean).slice(0, 8),
      inputs,
      steps,
    },
    warnings,
  };
}

/**
 * Drafts (or adjusts) a ReceAPIto.
 * @param {{ idea: string, draft?: object, history?: string[] }} input what the admin asked now, the form as it is, and what was asked before
 * @param {object[]} apis APIs the admin may use
 */
async function build({ idea, draft, history = [] }, apis) {
  // Earlier requests keep the search on topic when the new one is short ("troque o passo 2").
  const routesList = await pickRoutes([...history, idea].join('\n'), draft, apis);
  if (!routesList.length) {
    return { recipe: null, message: '', questions: ['Não encontrei no catálogo rotas parecidas com essa ideia. Pode dizer qual API usar, ou citar as rotas (ex.: POST /v1/sessions)?'], warnings: [], routes: 0 };
  }
  const routes = new Map();
  const ids = new Map();
  routesList.forEach((r, i) => {
    routes.set(`r${i + 1}`, r);
    ids.set(key(r.api.id, r.ep.method, r.ep.path), `r${i + 1}`);
  });
  const payload = {
    ideia: idea,
    ...(history.length ? { pedidos_anteriores: history } : {}),
    receapito_atual: draftForModel(draft, ids),
    rotas_disponiveis: [...routes].map(([id, r]) => brief(id, r)),
  };
  const out = await llm.chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    { json: true, maxTokens: 4000, temperature: 0.2 }
  );
  const { recipe, warnings } = toRecipe(out || {}, routes);
  return {
    recipe: recipe.steps.length ? recipe : null,
    message: text(out?.mensagem, 1500),
    questions: (Array.isArray(out?.duvidas) ? out.duvidas : []).map((q) => text(q, 500)).filter(Boolean).slice(0, 6),
    warnings,
    routes: routesList.length,
  };
}

module.exports = { build, toRecipe, responsePaths };

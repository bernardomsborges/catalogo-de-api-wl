/**
 * "Melhorar com IA" (PRO-150): finds documentation gaps in an API and asks the model to fill them.
 *
 * - Gaps are found here, without AI: English titles from FastAPI ("List Units"), missing
 *   descriptions, parameters without explanation, generic response descriptions.
 * - The model only gets those gaps plus the real names of parameters and fields, and answers one
 *   text per gap. Suggestions for anything that wasn't asked, or that cite (between backticks) a
 *   parameter, field or route that doesn't exist, are dropped.
 * - Nothing is saved here: the admin accepts, edits or rejects each suggestion in the form.
 */
const llm = require('./llm');
// Same gap rules as the quality score shown in the admin (PRO-164).
const { findGaps, aiGaps, looksEnglish } = require('../../../shared/doc-quality.ts');

const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'")\]]*)/g;
/**
 * A route cited in a text exists in the API. Accepts a query string ("GET /search.json?q=x") and
 * values in place of path variables ("GET /works/OL45804W.json" for /works/{work_id}.json).
 */
function routeExists(api, method, cited) {
  const p = String(cited).replace(/[?#].*$/, '').replace(/[.,;:]+$/, '');
  return api.endpoints.some((e) => {
    if (e.method !== method) return false;
    if (e.path === p) return true;
    const re = new RegExp('^' + e.path.split(/\{[^}]+\}/).map((x) => x.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('[^/]+') + '/?$');
    return re.test(p);
  });
}

const clip = (t, n) => (String(t || '').length > n ? String(t).slice(0, n) + '…' : String(t || ''));

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

/** Reads a value by target path ("endpoints[3].parameters[1].description"). */
function getAt(obj, target) {
  return target
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Names the suggestions may cite: parameters, body/response fields, credential names, routes. */
function knownNames(api) {
  const names = new Set();
  for (const s of api.auth?.schemes || []) {
    if (s.name) names.add(s.name);
    if (s.key) names.add(s.key);
    names.add('Authorization');
  }
  for (const ep of api.endpoints || []) {
    names.add(ep.path);
    names.add(`${ep.method} ${ep.path}`);
    for (const p of ep.parameters || []) names.add(p.name);
    for (const f of fieldNames(ep.requestBody)) names.add(f);
    for (const r of ep.responses || []) for (const f of fieldNames(r.body)) names.add(f);
  }
  return names;
}

/** Why a suggested text can't be used (cites something that doesn't exist), or ''. */
function inventedReference(text, api, names, original = '') {
  // A translation keeps what was already in the original text (examples, query strings, links).
  const kept = (t) => !!original && String(original).includes(t);
  for (const m of String(text).matchAll(ROUTE)) {
    const p = m[2].replace(/[.,;:]+$/, '');
    if (!routeExists(api, m[1], p) && !kept(p)) return `cita a rota ${m[1]} ${p}, que não existe`;
  }
  for (const m of String(text).matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim();
    if (/^\d{3}$/.test(t) || /^(true|false|null)$/.test(t) || kept(t)) continue;
    // A query string with known parameters: ?limit=10&offset=0
    if (/^\?[\w.\-[\]]+(=[^&\s]*)?(&[\w.\-[\]]+(=[^&\s]*)?)*$/.test(t) && t.slice(1).split('&').every((kv) => names.has(kv.split('=')[0]))) continue;
    const route = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/.exec(t);
    if (route ? !names.has(`${route[1]} ${route[2]}`) : !names.has(t) && !names.has(t.replace(/^\//, '/'))) return `cita \`${t}\`, que não está na especificação`;
  }
  return '';
}

/** Compact view of the endpoints sent to the model (names, never example values). */
function endpointBrief(api, i) {
  const ep = api.endpoints[i];
  const ok = (ep.responses || []).find((r) => r.status >= 200 && r.status < 300);
  return {
    i,
    rota: `${ep.method} ${ep.path}`,
    titulo: ep.summary || '',
    descricao: clip(ep.description, 500),
    parametros: (ep.parameters || []).map((p, j) => ({ j, nome: p.name, onde: p.in, obrigatorio: !!p.required, tipo: p.type, descricao: clip(p.description, 200) })),
    campos_enviados: fieldNames(ep.requestBody, 25),
    // The request body example helps to write a coherent response example.
    exemplo_enviado: clip(ep.requestBody, 800),
    campos_da_resposta: ok ? fieldNames(ok.body, 25) : [],
    respostas: (ep.responses || []).map((r, k) => ({ k, status: r.status, descricao: r.description || '' })),
  };
}

const SYSTEM = `Você escreve a documentação de APIs do Catálogo de APIs do Automatiza.MG (governo de Minas Gerais), em português do Brasil, com tom claro, direto e cordial, para pessoas desenvolvedoras.

Regras:
- Preencha SOMENTE as lacunas pedidas (cada uma tem um "target"). Não crie outras.
- Use apenas as rotas, parâmetros e campos informados. Nunca invente rotas, parâmetros, campos, valores ou regras de negócio que não dá para deduzir do que foi informado.
- Ao citar um parâmetro, campo ou rota, use crases e o nome exato (ex.: \`processo\`, \`POST /v1/sessions\`).
- Títulos de rota: curtos, no infinitivo, sem ponto final (ex.: "List Units" → "Listar unidades", "Create Session" → "Criar sessão").
- Descrições de rota: 1 a 3 frases dizendo o que a rota faz e quando usar.
- Descrições de parâmetro: 1 frase.
- Descrições de resposta: o que significa para quem chama (ex.: 401 → "Chave de acesso ou token ausente ou inválido.").
- Descrição da API: 2 a 4 frases sobre para que serve e o que dá para fazer com ela (pelo menos 150 caracteres).
- Resumo da API: 1 frase curta.
- Exemplo de parâmetro (tipo "example"): só o valor, sem aspas nem explicação, coerente com o nome, o tipo e a descrição (ex.: \`cpf\` → 12345678909, \`dataInicio\` → 2025-01-31, \`pagina\` → 1). Use dados fictícios, nunca de pessoas reais.
- Lacunas do tipo "translate": traduza o texto atual para o português, mantendo o sentido, os nomes entre crases, os números e os links.
- Se o exemplo de resposta atual for genérico ("string", 0, example.org), mantenha os mesmos campos e troque os valores por valores realistas.
- Exemplo de resposta (tipo "json"): um JSON válido e curto do que a rota devolve. Use os campos de "campos_da_resposta" quando houver; senão, deduza do caminho, do título, da descrição e do "exemplo_enviado". Valores fictícios. Listas com 1 ou 2 itens. Se a rota devolve um arquivo (download, PDF, imagem), escreva só um texto curto, sem JSON, como (arquivo PDF em binário).
- Descrição de credencial: 1 ou 2 frases sobre o que ela é e onde vai (cabeçalho, query, Bearer), usando o nome exato.
- Como obter as credenciais: diga a quem pedir, usando o time responsável e o e-mail de contato informados; se houver rota de login (token_vem_de), explique que o token vem dela. Se não houver e-mail, não comente a falta dele. Nunca invente sites, formulários ou prazos.

Responda APENAS com JSON: {"suggestions": [{"target": "...", "value": "..."}]}`;

/**
 * Suggestions for the gaps of `api` (the form content). `endpoints`: indexes to look at
 * (one batch); `apiLevel`: also the API description/summary.
 * Returns { suggestions: [{ target, kind, label, current, value }], dropped: [{ target, reason }], gaps }.
 */
/**
 * @param {any} api
 * @param {{ endpoints?: number[], apiLevel?: boolean }} [options]
 */
async function improve(api, { endpoints, apiLevel = true } = {}) {
  // `endpoints` missing = all routes; [] = none (an API-level batch).
  const only = Array.isArray(endpoints) ? new Set(endpoints.filter((i) => Number.isInteger(i) && api.endpoints[i])) : null;
  const gaps = aiGaps(api).filter((g) => {
    const i = /^endpoints\[(\d+)\]/.exec(g.target)?.[1];
    return i == null ? apiLevel : !only || only.has(Number(i));
  });
  if (!gaps.length) return { suggestions: [], dropped: [], gaps: 0 };

  const indexes = [...new Set(gaps.map((g) => /^endpoints\[(\d+)\]/.exec(g.target)?.[1]).filter(Boolean).map(Number))];
  const payload = {
    api: {
      nome: api.name,
      categoria: api.category,
      resumo: api.summary,
      descricao: clip(api.description, 800),
      time_responsavel: api.owner || '',
      email_de_contato: api.contactEmail || '',
      credenciais: (api.auth?.schemes || []).map((s) => ({ nome: s.name || s.key, tipo: s.type, onde: s.in, formato: s.bearerFormat || '', token_vem_de: s.tokenEndpoint || '', url_do_token: s.tokenUrl || '' })),
      rotas: api.endpoints.map((e) => `${e.method} ${e.path} — ${e.summary || ''}`).slice(0, 80),
    },
    rotas_com_lacunas: indexes.map((i) => endpointBrief(api, i)),
    lacunas: gaps.map((g) => ({ target: g.target, tipo: g.kind, o_que: g.label, atual: g.current })),
  };
  const out = await llm.chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    { json: true, maxTokens: 6000, temperature: 0.3 }
  );

  const wanted = new Map(gaps.map((g) => [g.target, g]));
  const names = knownNames(api);
  const suggestions = [];
  const dropped = [];
  const seen = new Set();
  for (const s of Array.isArray(out.suggestions) ? out.suggestions : []) {
    const target = String(s?.target || '').trim();
    const value = String(s?.value || '').trim();
    const gap = wanted.get(target);
    if (!gap) {
      dropped.push({ target: target || '(sem alvo)', reason: 'não foi pedido' });
      continue;
    }
    if (seen.has(target) || !value) continue;
    const limit = gap.kind === 'json' ? 6000 : gap.kind === 'example' ? 300 : /summary$/.test(target) ? 90 : 1200;
    if (value.length > limit) {
      dropped.push({ target: gap.label, reason: 'texto longo demais' });
      continue;
    }
    if (gap.kind === 'json') {
      let body = null;
      try {
        const parsed = typeof s.value === 'string' ? JSON.parse(value) : s.value;
        body = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
      } catch {
        // A file route: a short note such as "(arquivo PDF em binário)".
        if (!/^[[{]/.test(value) && value.length <= 200) body = value;
      }
      if (body == null) dropped.push({ target: gap.label, reason: 'o exemplo não é um JSON válido' });
      else {
        suggestions.push({ ...gap, current: '', value: body });
        seen.add(target);
      }
      continue;
    }
    // Examples are values, not text: no references to check.
    const invented = gap.kind === 'example' ? '' : inventedReference(value, api, names, gap.current);
    if (invented) {
      dropped.push({ target: gap.label, reason: invented });
      continue;
    }
    if (value === gap.current) continue;
    seen.add(target);
    suggestions.push({ ...gap, current: String(getAt(api, target) ?? ''), value });
  }
  return { suggestions, dropped, gaps: gaps.length };
}

const GUIDE_SYSTEM = `Você escreve guias para o Catálogo de APIs do Automatiza.MG, em português do Brasil, em Markdown.
Um guia explica um fluxo comum, passo a passo, citando as rotas na ordem em que devem ser chamadas.
Use SOMENTE as rotas listadas (cite como \`MÉTODO /caminho\`) e só os parâmetros e campos informados. Não invente nada.
Não inclua chaves, senhas ou tokens reais; use marcadores como SUA_CHAVE.
Responda APENAS com JSON: {"title": "...", "content": "markdown"}`;

/** Draft of a custom guide for a flow (e.g. "criar sessão → escolher unidade → criar processo"). */
async function guide(api, topic) {
  const routes = api.endpoints.map((e, i) => endpointBrief(api, i));
  const out = await llm.chat(
    [
      { role: 'system', content: GUIDE_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          api: { nome: api.name, resumo: api.summary, descricao: clip(api.description, 600), credenciais: (api.auth?.schemes || []).map((s) => ({ tipo: s.type, nome: s.name, descricao: clip(s.description, 200) })) },
          fluxo_pedido: String(topic || '').slice(0, 300) || 'o fluxo mais comum de uso da API, do início ao fim',
          rotas: routes,
        }),
      },
    ],
    { json: true, maxTokens: 3000, temperature: 0.3 }
  );
  const title = String(out.title || '').trim().slice(0, 120);
  let content = String(out.content || '').trim().slice(0, 20000);
  if (!title || !content) throw new Error('A IA não devolveu um guia.');
  // Routes that don't exist are flagged in the text instead of silently kept.
  const invented = [];
  content = content.replace(ROUTE, (m, method, p) => {
    const clean = p.replace(/[.,;:]+$/, '');
    if (routeExists(api, method, clean)) return m;
    invented.push(`${method} ${clean}`);
    return `${m} ⚠️(rota não existe nesta API)`;
  });
  return { title, content, invented };
}

module.exports = { routeExists, improve, guide, findGaps, aiGaps, looksEnglish, inventedReference, knownNames };

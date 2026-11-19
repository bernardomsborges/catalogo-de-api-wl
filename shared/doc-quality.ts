/**
 * Documentation quality of an API (PRO-164) and the gaps "Melhorar com IA" fills (PRO-150).
 *
 * Shared by the portal (score in the admin, live while editing) and the server (AI agent), so the
 * two always agree on what is missing. Plain TypeScript with erasable types only: Node runs it
 * directly (type stripping) and Angular compiles it as part of the app.
 */

// ----- loose shapes (the portal's Api model and the server's JSON both fit) -----

export interface QParam {
  name: string;
  in?: string;
  type?: string;
  description?: string;
  example?: string;
}
export interface QResponse {
  status: number;
  description?: string;
  body?: string;
}
export interface QEndpoint {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters?: QParam[];
  requestBody?: string;
  responses?: QResponse[];
  /** Missing = same credentials as the API; [] = public route. */
  security?: string[];
}
export interface QScheme {
  key?: string;
  type?: string;
  name?: string;
  description?: string;
}
export interface QApi {
  name?: string;
  summary?: string;
  description?: string;
  owner?: string;
  contactEmail?: string;
  auth?: { type?: string; instructions?: string; schemes?: QScheme[] };
  endpoints?: QEndpoint[];
  guides?: unknown[];
}

// ----- text gaps (what the AI can write) -----

export interface Gap {
  /** Path of the field in the API, e.g. "endpoints[3].parameters[1].description". */
  target: string;
  /** 'example': a parameter value; 'json': a response body example. */
  kind: 'fill' | 'improve' | 'translate' | 'example' | 'json';
  label: string;
  current: string;
}

export const MIN_DESCRIPTION = 120;

export const GENERIC_RESPONSE =
  /^(successful response|ok|success|validation error|unprocessable (entity|content)|bad request|unauthorized|forbidden|not found|bad gateway|internal server error|service unavailable|created|no content|accepted|conflict|too many requests|gateway timeout|default response)$/i;

const ENGLISH =
  /\b(list|get|create|update|delete|remove|send|select|sign|register|search|quick|types?|items?|options?|block|blocks|group|groups|session|units?|process|document|documents|history|health|organizations?|attach|external|download|reopen|complete|cancel|make|available|assignment|annotations?|markers?|catalog|panel|control|data|current|by|id|of|for|the|and|to)\b/i;

/** Signs of Portuguese in a title: prepositions, verbs in -ar/-er/-ir, -ção, -mento… */
const PORTUGUESE = /\b(de|da|do|das|dos|para|com|por|em|no|na|nos|nas|e|ou|um|uma)\b|(ar|er|ir|cao|coes|oes|agem|mento|idade|ncia)\b/i;

/** Clear signs of Portuguese, even next to words like "ID" or "item": prepositions and the usual verbs. */
const CLEARLY_PORTUGUESE =
  /\b(da|das|dos|para|com|pelo|pela|pelos|pelas|ao|aos|um|uma)\b|^(consultar|listar|criar|buscar|obter|atualizar|excluir|remover|enviar|cadastrar|gerar|alterar|substituir|verificar|pesquisar|baixar|mostrar|navegar|cancelar|assinar|anexar|abrir|fechar|incluir|converter|calcular|validar|registrar|ranking|imagem|dados)\b/i;

/** "List Units" / "Dashboard" style titles (FastAPI default from the function name). */
export function looksEnglish(text: string | undefined): boolean {
  const t = String(text || '').trim();
  if (!t || !/^[A-Za-z0-9 _/-]+$/.test(t)) return false; // accents → Portuguese
  if (CLEARLY_PORTUGUESE.test(t)) return false;
  return ENGLISH.test(t) || (/^[A-Z]/.test(t) && !PORTUGUESE.test(t));
}

const blank = (v: unknown) => !String(v ?? '').trim();

const EN_WORDS = /\b(the|and|of|to|is|are|for|with|from|this|that|which|by|can|when|each|their|its|will|be|returns?|number|results?|page|available|only)\b/gi;
const PT_WORDS = /\b(de|da|do|das|dos|para|com|por|que|um|uma|os|em|no|na|é|são|ao|pelo|pela|não|ou|se)\b/gi;

/** A sentence in English (descriptions copied from an English OpenAPI document). */
export function looksEnglishText(text: string | undefined): boolean {
  const t = String(text || '').trim();
  // Short texts ("Sucesso", "ID do registro"): only clear English words count.
  if (t.length < 25) return !t.match(PT_WORDS) && looksEnglish(t) && ENGLISH.test(t);
  const en = t.match(EN_WORDS)?.length ?? 0;
  const pt = t.match(PT_WORDS)?.length ?? 0;
  return en >= 2 && en > pt * 2;
}

/** Text gaps of an API: descriptions, titles and texts in English, generic responses. `only` limits to some endpoints. */
export function findGaps(api: QApi, only?: number[] | null): Gap[] {
  const gaps: Gap[] = [];
  const add = (target: string, kind: Gap['kind'], label: string, current: unknown = '') => gaps.push({ target, kind, label, current: String(current || '') });
  /** Missing → fill; in English → translate. */
  const text = (target: string, label: string, value: unknown) => {
    if (blank(value)) add(target, 'fill', label);
    else if (looksEnglishText(String(value))) add(target, 'translate', label, value);
  };
  if (!only) {
    if (String(api.description || '').trim().length < MIN_DESCRIPTION) add('description', api.description ? 'improve' : 'fill', 'Descrição da API', api.description);
    else if (looksEnglishText(api.description)) add('description', 'translate', 'Descrição da API', api.description);
    if (blank(api.summary) || looksEnglishText(api.summary)) add('summary', api.summary ? 'translate' : 'fill', 'Resumo da API', api.summary);
  }
  (api.endpoints || []).forEach((ep, i) => {
    if (only && !only.includes(i)) return;
    const route = `${ep.method} ${ep.path}`;
    if (blank(ep.summary)) add(`endpoints[${i}].summary`, 'fill', `${route} · título`);
    else if (looksEnglish(ep.summary)) add(`endpoints[${i}].summary`, 'translate', `${route} · título`, ep.summary);
    text(`endpoints[${i}].description`, `${route} · descrição`, ep.description);
    (ep.parameters || []).forEach((p, j) => text(`endpoints[${i}].parameters[${j}].description`, `${route} · parâmetro ${p.name}`, p.description));
    (ep.responses || []).forEach((r, k) => {
      const d = String(r.description || '').trim();
      if (!d || GENERIC_RESPONSE.test(d) || looksEnglishText(d)) add(`endpoints[${i}].responses[${k}].description`, d ? 'translate' : 'fill', `${route} · resposta ${r.status}`, d);
    });
  });
  return gaps;
}

const PLACEHOLDER = /^(string|example|lorem ipsum.*|https?:\/\/([a-z]+\.)?example\.(org|com)\S*|\S+@example\.(org|com)|2019-08-24(T14:15:22(\.\d+)?Z)?|3fa85f64-5717-4562-b3fc-2c963f66afa6)$/i;

/** A response example generated from the schema ("string", 0, example.org…), useless to the reader. */
export function isPlaceholderBody(body: string | undefined): boolean {
  let data: unknown;
  try {
    data = JSON.parse(String(body || ''));
  } catch {
    return false;
  }
  let leaves = 0;
  let fake = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.values(v).forEach((x) => walk(x, depth + 1));
    leaves++;
    if (v === 0 || v === null || v === '' || (typeof v === 'string' && PLACEHOLDER.test(v))) fake++;
  };
  walk(data, 0);
  return leaves > 0 && fake / leaves >= 0.6;
}

const hasAuth = (api: QApi) => !!api.auth?.schemes?.length || (!!api.auth?.type && api.auth.type !== 'none');
const isSuccess = (r: QResponse) => r.status >= 200 && r.status < 300;
const isError = (r: QResponse) => r.status >= 400;

/** The 2xx response whose example the score looks at (the first with a body, else the first). */
function successIndex(ep: QEndpoint): number {
  const list = (ep.responses || []).map((r, k) => [r, k] as const).filter(([r]) => isSuccess(r));
  if (!list.length) return -1;
  return (list.find(([r]) => !blank(r.body)) ?? list[0])[1];
}

/**
 * Everything "Melhorar com IA" can write to reach 100: the text gaps plus parameter examples,
 * response examples and credential texts. (Team, contact and guides need a person.)
 */
export function aiGaps(api: QApi, only?: number[] | null): Gap[] {
  const gaps = findGaps(api, only);
  const add = (target: string, kind: Gap['kind'], label: string) => gaps.push({ target, kind, label, current: '' });
  if (!only && hasAuth(api)) {
    (api.auth?.schemes || []).forEach((sc, i) => {
      if (blank(sc.description)) add(`auth.schemes[${i}].description`, 'fill', `Credencial ${sc.name || sc.key || sc.type} · descrição`);
    });
    if (blank(api.auth?.instructions)) add('auth.instructions', 'fill', 'Como obter as credenciais');
  }
  (api.endpoints || []).forEach((ep, i) => {
    if (only && !only.includes(i)) return;
    const route = `${ep.method} ${ep.path}`;
    (ep.parameters || []).forEach((p, j) => {
      if (blank(p.example)) add(`endpoints[${i}].parameters[${j}].example`, 'example', `${route} · exemplo do parâmetro ${p.name}`);
    });
    const k = successIndex(ep);
    const r = k >= 0 ? ep.responses![k] : null;
    if (r && r.status !== 204 && blank(r.body)) add(`endpoints[${i}].responses[${k}].body`, 'json', `${route} · exemplo da resposta ${r.status}`);
    else if (r && isPlaceholderBody(r.body)) gaps.push({ target: `endpoints[${i}].responses[${k}].body`, kind: 'json', label: `${route} · exemplo da resposta ${r.status} (genérico)`, current: String(r.body) });
  });
  return gaps;
}

/** Responses to add where a route has no 2xx or no error documented. Written here, without AI. */
export interface ResponseProposal {
  endpoint: number;
  label: string;
  add: QResponse[];
}

export function missingResponses(api: QApi, only?: number[] | null): ResponseProposal[] {
  const out: ResponseProposal[] = [];
  (api.endpoints || []).forEach((ep, i) => {
    if (only && !only.includes(i)) return;
    const responses = ep.responses || [];
    const add: QResponse[] = [];
    if (!responses.some(isSuccess)) {
      const ok: Record<string, QResponse> = {
        GET: { status: 200, description: 'Consulta feita com sucesso.' },
        POST: { status: 201, description: 'Criado com sucesso.' },
        PUT: { status: 200, description: 'Atualizado com sucesso.' },
        PATCH: { status: 200, description: 'Atualizado com sucesso.' },
        DELETE: { status: 204, description: 'Removido com sucesso. A resposta não tem corpo.' },
      };
      add.push({ ...(ok[ep.method] || ok['GET']), body: '' });
    }
    if (!responses.some(isError)) {
      const sendsData = !!(ep.parameters || []).length || !blank(ep.requestBody);
      const needsAuth = Array.isArray(ep.security) ? ep.security.length > 0 : hasAuth(api);
      if (sendsData) add.push({ status: 400, description: 'Dados inválidos: confira os parâmetros e o corpo enviados.', body: '' });
      if (needsAuth) add.push({ status: 401, description: 'Credencial ausente ou inválida.', body: '' });
      if (/\{[^}]+\}/.test(ep.path)) add.push({ status: 404, description: 'Não encontrado: confira o identificador informado no caminho.', body: '' });
      add.push({ status: 500, description: 'Erro interno da API. Tente de novo; se continuar, fale com o time responsável.', body: '' });
    }
    if (add.length) out.push({ endpoint: i, label: `${ep.method} ${ep.path} · respostas que faltam`, add });
  });
  return out;
}

// ----- quality score -----

export interface QualityCheck {
  ok: boolean;
  /** What is missing, written as an action ("Escreva a descrição de GET /x"). */
  label: string;
  /** Field to jump to (same path format as Gap.target). */
  target: string;
}

export interface QualityItem {
  key: string;
  label: string;
  weight: number;
  points: number;
  checks: QualityCheck[];
  /** Checks still failing. */
  pending: QualityCheck[];
  /** The item doesn't apply (e.g. API without credentials): full points. */
  notApplicable: boolean;
}

export interface Quality {
  /** 0–100. 100 only when nothing is pending. */
  score: number;
  items: QualityItem[];
  pendingCount: number;
}

export const COMPLETE_SCORE = 90;

/**
 * Score of the API's documentation. `recipes`: how many recipes use the API (they count as a
 * guide). Every point comes from a list of checks, and every failed check says what to fill.
 */
export function docQuality(api: QApi, opts: { recipes?: number } = {}): Quality {
  const gaps = new Map(findGaps(api).map((g) => [g.target, g]));
  const eps = api.endpoints || [];
  const route = (ep: QEndpoint) => `${ep.method} ${ep.path}`;
  const noEndpoints: QualityCheck[] = eps.length ? [] : [{ ok: false, label: 'Cadastre os endpoints da API (ou importe o OpenAPI)', target: 'endpoints' }];

  const items: Omit<QualityItem, 'points' | 'pending' | 'notApplicable'>[] = [];
  const item = (key: string, label: string, weight: number, checks: QualityCheck[]) => items.push({ key, label, weight, checks });

  const desc = gaps.get('description');
  item('descricao', 'Descrição da API', 10, [
    {
      ok: !desc,
      label:
        desc?.kind === 'improve'
          ? `Descrição curta: explique para que serve a API e o que dá para fazer (mín. ${MIN_DESCRIPTION} caracteres)`
          : desc?.kind === 'translate'
            ? 'Descrição da API em inglês: escreva em português'
            : 'Escreva a descrição da API',
      target: 'description',
    },
  ]);
  const sum = gaps.get('summary');
  item('resumo', 'Resumo em português', 5, [{ ok: !sum, label: sum?.kind === 'translate' ? 'Resumo em inglês: escreva em português' : 'Escreva o resumo da API', target: 'summary' }]);
  item('contato', 'Contato do time responsável', 10, [
    { ok: !blank(api.owner), label: 'Informe o time responsável', target: 'owner' },
    { ok: /\S+@\S+\.\S+/.test(String(api.contactEmail || '')), label: 'Informe o e-mail de contato do time', target: 'contactEmail' },
  ]);

  item('titulos', 'Rotas com título em português', 15, [
    ...noEndpoints,
    ...eps.map((ep, i) => {
      const g = gaps.get(`endpoints[${i}].summary`);
      return { ok: !g, label: g?.kind === 'translate' ? `${route(ep)}: título em inglês ("${g.current}")` : `${route(ep)}: escreva o título`, target: `endpoints[${i}].summary` };
    }),
  ]);
  item('descricoes', 'Rotas com descrição', 15, [
    ...noEndpoints,
    ...eps.map((ep, i) => {
      const g = gaps.get(`endpoints[${i}].description`);
      return { ok: !g, label: g?.kind === 'translate' ? `${route(ep)}: descrição em inglês` : `${route(ep)}: escreva a descrição`, target: `endpoints[${i}].description` };
    }),
  ]);

  const params: QualityCheck[] = [];
  eps.forEach((ep, i) =>
    (ep.parameters || []).forEach((p, j) => {
      const t = `endpoints[${i}].parameters[${j}]`;
      const g = gaps.get(`${t}.description`);
      params.push({ ok: !g, label: g?.kind === 'translate' ? `${route(ep)}: descrição do parâmetro ${p.name} em inglês` : `${route(ep)}: descreva o parâmetro ${p.name}`, target: `${t}.description` });
      params.push({ ok: !blank(p.example), label: `${route(ep)}: dê um exemplo para o parâmetro ${p.name}`, target: `${t}.example` });
    })
  );
  item('parametros', 'Parâmetros com descrição e exemplo', 10, [...noEndpoints, ...params]);

  const success: QualityCheck[] = [];
  const errors: QualityCheck[] = [];
  eps.forEach((ep, i) => {
    const responses = ep.responses || [];
    const ok = responses.map((r, k) => [r, k] as const).filter(([r]) => isSuccess(r));
    if (!ok.length) success.push({ ok: false, label: `${route(ep)}: cadastre a resposta de sucesso (2xx)`, target: `endpoints[${i}].responses` });
    else {
      const [r, k] = ok.find(([x]) => !blank(x.body)) ?? ok[0];
      const generic = !blank(r.body) && isPlaceholderBody(r.body);
      success.push({
        ok: r.status === 204 || (!blank(r.body) && !generic),
        label: generic ? `${route(ep)}: troque o exemplo genérico da resposta ${r.status} ("string", 0…) por um real` : `${route(ep)}: dê um exemplo da resposta ${r.status}`,
        target: `endpoints[${i}].responses[${k}].body`,
      });
    }
    const bad = responses.map((r, k) => [r, k] as const).filter(([r]) => isError(r));
    if (!bad.length) errors.push({ ok: false, label: `${route(ep)}: documente os erros possíveis (4xx/5xx)`, target: `endpoints[${i}].responses` });
    responses.forEach((r, k) => {
      const g = gaps.get(`endpoints[${i}].responses[${k}].description`);
      if (!g && !isError(r)) return;
      const label = g?.kind === 'translate' ? `${route(ep)}: resposta ${r.status} com texto genérico ou em inglês ("${g.current}")` : `${route(ep)}: explique a resposta ${r.status}`;
      (isError(r) ? errors : success).push({ ok: !g, label, target: `endpoints[${i}].responses[${k}].description` });
    });
  });
  item('sucesso', 'Respostas de sucesso com exemplo', 10, [...noEndpoints, ...success]);
  item('erros', 'Erros documentados', 10, [...noEndpoints, ...errors]);

  // Older APIs have only `auth.type`: then only the instructions are checked.
  item(
    'credenciais',
    'Credenciais com instruções',
    10,
    hasAuth(api)
      ? [
          ...(api.auth?.schemes || []).map((s, i) => ({ ok: !blank(s.description), label: `Descreva a credencial ${s.name || s.key || s.type}`, target: `auth.schemes[${i}].description` })),
          { ok: !blank(api.auth?.instructions), label: 'Explique como obter as credenciais', target: 'auth.instructions' },
        ]
      : []
  );
  item('guias', 'Guia personalizado ou ReceAPIto', 5, [
    { ok: (api.guides?.length ?? 0) > 0 || (opts.recipes ?? 0) > 0, label: 'Escreva um guia personalizado ou crie um ReceAPIto que use a API', target: 'guides' },
  ]);

  const full = items.map((it) => {
    const pending = it.checks.filter((c) => !c.ok);
    const notApplicable = it.checks.length === 0;
    const points = notApplicable ? it.weight : (it.weight * (it.checks.length - pending.length)) / it.checks.length;
    return { ...it, pending, points, notApplicable };
  });
  const pendingCount = full.reduce((n, it) => n + it.pending.length, 0);
  const raw = Math.round(full.reduce((n, it) => n + it.points, 0));
  return { score: pendingCount ? Math.min(raw, 99) : 100, items: full, pendingCount };
}

/** Number of recipes whose steps call the API (by id, or slug for imported recipes). */
export function recipesUsing(api: { id?: string; slug?: string }, recipes: { steps?: { apiId?: string; apiSlug?: string }[] }[]): number {
  return recipes.filter((r) => (r.steps || []).some((s) => (api.id && s.apiId === api.id) || (api.slug && s.apiSlug === api.slug))).length;
}

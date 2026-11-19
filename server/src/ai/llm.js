/**
 * Client for an OpenAI-compatible API (LiteLLM). Configuration:
 * - LLM_BASE_URL: e.g. https://litellm.exemplo.gov.br/v1 (without it, AI features are off)
 * - LLM_API_KEY: LiteLLM key
 * - LLM_MODEL: chat model (default gpt-4o-mini)
 * - LLM_EMBEDDING_MODEL: embeddings model (default text-embedding-3-small; "none" turns embeddings off)
 * - LLM_TEMPERATURE / LLM_MAX_TOKENS: only sent when set (reasoning models reject them)
 * The key stays on the server; the browser never talks to the model.
 *
 * Providers differ in what they accept. When the provider rejects a parameter (temperature,
 * response_format, max_tokens…), the call is repeated without it and the parameter is not sent
 * again. When the embeddings model isn't available to the key, embeddings are turned off and the
 * catalog search uses words (plus AI-expanded terms) instead.
 */
const BASE_URL = normalizeBase(process.env.LLM_BASE_URL || '');
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const EMBEDDING_MODEL = process.env.LLM_EMBEDDING_MODEL || 'text-embedding-3-small';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 90_000;
const TEMPERATURE = process.env.LLM_TEMPERATURE !== undefined && process.env.LLM_TEMPERATURE !== '' ? Number(process.env.LLM_TEMPERATURE) : null;
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || null;

/** "https://host//v1/" → "https://host/v1" */
function normalizeBase(url) {
  const u = String(url).trim();
  if (!u) return '';
  const m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(u);
  if (!m) return u.replace(/\/+$/, '');
  return m[1] + (m[2] || '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}

const enabled = () => !!BASE_URL;

/** Parameters the provider rejected once (not sent again). */
const unsupported = new Set();
let embeddingsOff = /^(none|off|false|0)$/i.test(EMBEDDING_MODEL) ? `LLM_EMBEDDING_MODEL=${EMBEDDING_MODEL}` : '';
let toolsOff = false;
/** reasoning_effort sent with tools: LLM_REASONING_EFFORT, or "none" once the provider asks for it. */
let toolsEffort = process.env.LLM_REASONING_EFFORT || '';

/** Provider answers that usually pass if we wait a little (rate limit, overloaded gateway). */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const RETRIES = 2;

/** POST with up to 2 retries on rate limit / overload, honoring Retry-After (capped at 20s). */
async function post(path, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce(path, body);
    } catch (err) {
      if (!RETRY_STATUS.has(err.status) || attempt >= RETRIES) throw err;
      const wait = err.retryAfter ? Math.min(err.retryAfter * 1000, 20_000) : 1500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function postOnce(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 500);
    try {
      const d = JSON.parse(text);
      msg = d.error?.message || d.message || d.detail || msg;
    } catch {
      /* not JSON */
    }
    throw Object.assign(new Error(`O provedor de IA respondeu ${res.status}: ${String(msg).slice(0, 400)}`), {
      status: res.status,
      detail: String(msg),
      retryAfter: Number(res.headers.get('retry-after')) || 0,
    });
  }
  return JSON.parse(text);
}

const embeddingsEnabled = () => enabled() && !embeddingsOff;

/** Embeddings for a list of texts (in batches). Turns embeddings off when the model isn't available. */
async function embed(texts) {
  if (!embeddingsEnabled()) throw new Error(`Busca por significado desligada (${embeddingsOff || 'IA não configurada'}).`);
  const out = [];
  try {
    for (let i = 0; i < texts.length; i += 64) {
      const data = await post('/embeddings', { model: EMBEDDING_MODEL, input: texts.slice(i, i + 64) });
      const rows = [...data.data].sort((a, b) => a.index - b.index);
      out.push(...rows.map((r) => r.embedding));
    }
  } catch (err) {
    // The key can't use this model (403/404/400 "not allowed"): stop trying until restart.
    if ([400, 401, 403, 404].includes(err.status)) {
      embeddingsOff = `o modelo ${EMBEDDING_MODEL} não está disponível para a chave`;
      console.warn(`[aviso] Busca por significado desligada: ${embeddingsOff}. A busca usa palavras e a IA para ampliar os termos.`);
    }
    throw err;
  }
  return out;
}

/** Extracts a JSON object from a model answer (tolerates ```json fences and text around it). */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(String(text));
    if (m) return JSON.parse(m[0]);
    throw new Error('A resposta da IA não veio no formato esperado.');
  }
}

/** Which optional parameter an error complains about, if any. */
function rejectedParam(err, body) {
  if (err.status !== 400) return null;
  const msg = String(err.detail || err.message).toLowerCase();
  return ['temperature', 'response_format', 'max_tokens', 'tool_choice'].find((p) => p in body && (msg.includes(p) || msg.includes(p.replace('_', ' ')))) ?? null;
}

/** POST /chat/completions, dropping parameters the provider rejects (and remembering them). */
async function completion(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const req = { ...body };
    for (const p of unsupported) delete req[p];
    try {
      return await post('/chat/completions', req);
    } catch (err) {
      const p = rejectedParam(err, req);
      if (!p) throw err;
      unsupported.add(p);
      console.warn(`[aviso] O modelo ${MODEL} não aceita "${p}"; o catálogo deixa de enviar esse parâmetro.`);
    }
  }
  throw new Error('O provedor de IA recusou a chamada.');
}

/**
 * @param {any[]} messages
 * @param {{ json?: boolean, maxTokens?: number, temperature?: number }} [options]
 */
function baseBody(messages, { json, maxTokens, temperature } = {}) {
  const t = temperature ?? TEMPERATURE;
  const mt = MAX_TOKENS ?? maxTokens ?? null;
  return {
    model: MODEL,
    messages,
    ...(t != null && process.env.LLM_TEMPERATURE !== undefined ? { temperature: t } : {}),
    ...(mt && process.env.LLM_MAX_TOKENS ? { max_tokens: mt } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
}

/** Chat completion. With `json: true`, asks for (and parses) a JSON object. */
async function chat(messages, opts = {}) {
  const data = await completion(baseBody(messages, opts));
  const content = data.choices?.[0]?.message?.content ?? '';
  return opts.json ? parseJson(content) : content;
}

/**
 * One step of a tool-using conversation: returns the assistant message (content and/or
 * tool_calls). Throws `toolsUnsupported` when the provider doesn't take tools.
 */
async function chatWithTools(messages, tools) {
  if (toolsOff) {
    throw Object.assign(new Error('O modelo não aceita ferramentas.'), { toolsUnsupported: true });
  }
  for (;;) {
    try {
      const data = await completion({ ...baseBody(messages), tools, tool_choice: 'auto', ...(toolsEffort ? { reasoning_effort: toolsEffort } : {}) });
      return data.choices?.[0]?.message ?? { role: 'assistant', content: '' };
    } catch (err) {
      const detail = String(err.detail || err.message);
      // Reasoning models (e.g. via LiteLLM) may only take tools with reasoning_effort "none".
      if (err.status === 400 && /reasoning_effort/i.test(detail) && toolsEffort !== 'none') {
        toolsEffort = 'none';
        console.warn(`[aviso] O modelo ${MODEL} só aceita ferramentas com reasoning_effort "none"; o catálogo passa a enviar assim (ajuste com LLM_REASONING_EFFORT).`);
        continue;
      }
      if (err.status === 400 && /tool|function/i.test(detail)) {
        toolsOff = true;
        err.toolsUnsupported = true;
        console.warn(`[aviso] O modelo ${MODEL} não aceita ferramentas; o assistente usa só a busca do catálogo. Detalhe: ${detail.slice(0, 200)}`);
      }
      throw err;
    }
  }
}

/** Startup check: is the provider reachable, and does it list the configured models? */
async function check() {
  if (!enabled()) {
    console.log('[ia] LLM_BASE_URL não definido — recursos de IA desligados (a busca usa só palavras).');
    return;
  }
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`/models respondeu ${res.status}`);
    const ids = ((await res.json()).data || []).map((m) => m.id);
    console.log(`[ia] Conectado a ${BASE_URL} (modelo ${MODEL}; ${ids.length} modelo(s) disponível(is) para a chave).`);
    if (ids.length && !ids.includes(MODEL)) console.warn(`[aviso] O modelo ${MODEL} não aparece para esta chave. Disponíveis: ${ids.slice(0, 20).join(', ')}. Ajuste LLM_MODEL no .env.`);
    if (!embeddingsOff && ids.length && !ids.includes(EMBEDDING_MODEL)) {
      embeddingsOff = `o modelo ${EMBEDDING_MODEL} não está disponível para a chave`;
      console.log(`[ia] Busca por significado desligada (${embeddingsOff}). A busca usa palavras e a IA para ampliar os termos. Para ligar, defina LLM_EMBEDDING_MODEL com um modelo de embeddings da chave.`);
    }
  } catch (err) {
    console.warn(`[aviso] Não foi possível consultar o provedor de IA: ${err.message}`);
  }
}

module.exports = { enabled, embeddingsEnabled, embed, chat, chatWithTools, parseJson, check, MODEL, EMBEDDING_MODEL, BASE_URL };

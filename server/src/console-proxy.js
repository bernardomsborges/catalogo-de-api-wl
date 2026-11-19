/**
 * Proxy for the "Testar este endpoint" console.
 *
 * Browsers block most cross-origin API calls (CORS), so the console sends the
 * request through this server instead. To keep it from becoming an open proxy,
 * the target URL must start with one of the URLs registered on that API
 * (base URL or an environment), and only documented HTTP methods are allowed.
 */
const store = require('./store');
const { createLimiter } = require('./rate-limit');
const metrics = require('./metrics');

const TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 1024 * 1024;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
// Headers the browser-side user must not control or that make no sense to forward.
const BLOCKED_REQ_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding', 'origin', 'referer'];
// 60 test calls per minute for each IP.
const limiter = createLimiter(60, 60_000);

/** True when `target` is one of the API's registered URLs or a path below it. */
function isAllowedTarget(api, target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const bases = [api.baseUrl, ...(api.environments || []).map((e) => e.url)].filter(Boolean);
  return bases.some((base) => {
    try {
      const b = new URL(base);
      const basePath = b.pathname.replace(/\/+$/, '');
      return url.origin === b.origin && (url.pathname === basePath || url.pathname.startsWith(basePath + '/') || basePath === '');
    } catch {
      return false;
    }
  });
}

function friendlyNetworkError(err, target) {
  const host = (() => {
    try {
      return new URL(target).host;
    } catch {
      return target;
    }
  })();
  const code = err?.cause?.code || err?.code || err?.name;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `O endereço ${host} não foi encontrado. Confira a URL do ambiente ou use o modo Simulação.`;
  if (code === 'ECONNREFUSED') return `${host} recusou a conexão. O serviço pode estar fora do ar.`;
  if (code === 'TimeoutError' || code === 'AbortError') return `${host} não respondeu em ${TIMEOUT_MS / 1000} segundos.`;
  if (String(code).startsWith('CERT_') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `O certificado HTTPS de ${host} não é válido.`;
  }
  return `Não foi possível conectar a ${host}${code ? ` (${code})` : ''}.`;
}

async function readLimited(res) {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function handle(req, res) {
  if (limiter.hit(req.ip)) return res.status(429).json({ message: 'Muitas chamadas de teste. Aguarde um minuto.' });

  const { apiId, url, method, headers = {}, body } = req.body || {};
  const api = apiId && store.get(apiId);
  if (!api) return res.status(404).json({ message: 'API não encontrada no catálogo.' });
  if (!METHODS.includes(method)) return res.status(400).json({ message: 'Método HTTP inválido.' });
  if (!isAllowedTarget(api, url)) {
    return res.status(400).json({ message: 'O console só chama a URL base ou os ambientes cadastrados para esta API.' });
  }

  /** @type {Record<string, string>} */
  const outHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && !BLOCKED_REQ_HEADERS.includes(k.toLowerCase())) outHeaders[k] = v;
  }

  const started = Date.now();
  try {
    const upstream = await fetch(url, {
      method,
      headers: outHeaders,
      body: ['GET', 'DELETE'].includes(method) || body == null || body === '' ? undefined : String(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const { text, truncated } = await readLimited(upstream);
    if (req.countMetrics) metrics.consoleCall(api, req.body.endpointId, upstream.status < 400);
    res.json({
      status: upstream.status,
      statusText: upstream.statusText,
      ms: Date.now() - started,
      headers: Object.fromEntries(upstream.headers.entries()),
      body: text,
      truncated,
    });
  } catch (err) {
    if (req.countMetrics) metrics.consoleCall(api, req.body.endpointId, false);
    res.status(502).json({ message: friendlyNetworkError(err, url), ms: Date.now() - started });
  }
}

module.exports = { handle, isAllowedTarget };

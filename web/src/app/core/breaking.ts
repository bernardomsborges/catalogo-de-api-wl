import { load } from 'js-yaml';
import { ApiInput } from './catalog.service';
import { apiSchemes, endpointSchemes, HttpMethod, METHODS } from './models';

/**
 * Finds changes that can break whoever already uses an API, comparing two versions of it.
 *
 * Two sources: raw OpenAPI documents (precise: knows required fields and types) or catalog entries
 * (approximate: response/body shapes come from the JSON examples, without "required").
 */

type Obj = Record<string, any>;

/** Simplified JSON schema: type plus fields (objects) or items (arrays). */
interface Shape {
  type: string;
  props?: Record<string, { shape: Shape; required: boolean }>;
  items?: Shape;
}

interface ParamModel {
  in: string;
  name: string;
  required: boolean;
  type: string;
}

interface OpModel {
  params: ParamModel[];
  body?: Shape;
  bodyRequired: boolean;
  /** By status code. */
  responses: Record<string, Shape | undefined>;
  /** Accepted credential options: each one is a set of scheme keys sent together. [[]] = public. */
  security: string[][];
}

interface SchemeModel {
  type: string;
  name: string;
  in: string;
}

export interface ApiModel {
  ops: Map<string, OpModel>;
  schemes: Record<string, SchemeModel>;
  /** Whether "required" is known for body fields (raw documents only). */
  precise: boolean;
}

export interface Change {
  breaking: boolean;
  /** "GET /path", or empty for API-wide changes. */
  route: string;
  text: string;
}

export interface ChangeReport {
  breaking: Change[];
  compatible: Change[];
  /** Raw documents (precise) or catalog examples (approximate). */
  precise: boolean;
}

const MAX_DEPTH = 8;

// ----- models from a raw OpenAPI / Swagger document -----

function resolveRef(ref: string, root: Obj): Obj | undefined {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<any>((acc, k) => acc?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

const deref = (o: Obj | undefined, root: Obj): Obj | undefined => (o?.['$ref'] ? resolveRef(o['$ref'], root) : o);

function shapeFromSchema(raw: Obj | undefined, root: Obj, depth = 0, seen = new Set<string>()): Shape | undefined {
  if (!raw || depth > MAX_DEPTH) return undefined;
  if (raw['$ref']) {
    if (seen.has(raw['$ref'])) return { type: 'object' }; // recursive schema
    return shapeFromSchema(resolveRef(raw['$ref'], root), root, depth + 1, new Set(seen).add(raw['$ref']));
  }
  if (raw['allOf']) {
    const parts = raw['allOf'].map((s: Obj) => shapeFromSchema(s, root, depth + 1, seen)).filter(Boolean) as Shape[];
    const props = Object.assign({}, ...parts.map((p) => p.props ?? {}));
    return { type: 'object', props };
  }
  const variant = raw['oneOf'] ?? raw['anyOf'];
  if (variant?.length) return shapeFromSchema(variant[0], root, depth + 1, seen);
  let type = Array.isArray(raw['type']) ? raw['type'].find((t: string) => t !== 'null') : raw['type'];
  if (!type) type = raw['properties'] ? 'object' : raw['items'] ? 'array' : 'any';
  if (type === 'integer') type = 'number';
  if (type === 'object') {
    const required = new Set<string>(raw['required'] ?? []);
    const props: Shape['props'] = {};
    for (const [k, v] of Object.entries<Obj>(raw['properties'] ?? {})) {
      const s = shapeFromSchema(v, root, depth + 1, seen);
      if (s) props[k] = { shape: s, required: required.has(k) };
    }
    return { type, props };
  }
  if (type === 'array') return { type, items: shapeFromSchema(raw['items'], root, depth + 1, seen) };
  return { type };
}

function mediaSchema(content: Obj | undefined): Obj | undefined {
  const media = content?.['application/json'] ?? (content ? Object.values(content)[0] : undefined);
  return media?.schema;
}

/** FastAPI lists "A and B" as [{A}, {B}] (see openapi.ts). */
const isFastApi = (spec: Obj) => !!spec['components']?.schemas?.['HTTPValidationError'] && !!spec['components']?.schemas?.['ValidationError'];

function securityOptions(reqs: Obj[] | undefined, combined: boolean): string[][] | undefined {
  if (!Array.isArray(reqs)) return undefined;
  const options = reqs.map((r) => Object.keys(r ?? {}).sort());
  if (!options.length || options.some((o) => !o.length)) return [[]];
  return combined && options.every((o) => o.length === 1) ? [[...new Set(options.flat())].sort()] : options;
}

export function modelFromSpecText(text: string): ApiModel {
  const spec = load(text) as Obj;
  if (!spec || typeof spec !== 'object' || !spec['paths']) throw new Error('Especificação inválida (faltou "paths").');
  const combined = isFastApi(spec);
  const defs: Obj = spec['components']?.securitySchemes ?? spec['securityDefinitions'] ?? {};
  const schemes: ApiModel['schemes'] = {};
  for (const [k, raw] of Object.entries<Obj>(defs)) {
    const s = deref(raw, spec) ?? {};
    const httpScheme = String(s['scheme'] ?? '').toLowerCase();
    schemes[k] = { type: s['type'] === 'http' ? httpScheme || 'bearer' : s['type'], name: s['name'] ?? '', in: s['in'] ?? '' };
  }
  const globalSec = securityOptions(spec['security'], combined) ?? [[]];

  const ops = new Map<string, OpModel>();
  for (const [path, item] of Object.entries<Obj>(spec['paths'])) {
    for (const [m, op] of Object.entries<Obj>(item ?? {})) {
      const method = m.toUpperCase() as HttpMethod;
      if (!METHODS.includes(method)) continue;
      const params: ParamModel[] = [];
      let body: Shape | undefined;
      let bodyRequired = false;
      for (const rawP of [...(item['parameters'] ?? []), ...(op['parameters'] ?? [])]) {
        const p = deref(rawP, spec);
        if (!p) continue;
        if (p['in'] === 'body') {
          body = shapeFromSchema(p['schema'], spec);
          bodyRequired = !!p['required'];
          continue;
        }
        if (!['path', 'query', 'header', 'cookie'].includes(p['in'])) continue;
        const schema = deref(p['schema'], spec) ?? p;
        params.push({ in: p['in'], name: p['name'], required: p['in'] === 'path' || !!p['required'], type: normType(schema['type']) });
      }
      const rb = deref(op['requestBody'], spec);
      if (rb) {
        body = shapeFromSchema(mediaSchema(rb['content']), spec);
        bodyRequired = !!rb['required'];
      }
      const responses: OpModel['responses'] = {};
      for (const [code, r] of Object.entries<Obj>(op['responses'] ?? {})) {
        if (!/^\d+$/.test(code)) continue;
        const res = deref(r, spec) ?? {};
        responses[code] = shapeFromSchema(res['content'] ? mediaSchema(res['content']) : res['schema'], spec);
      }
      ops.set(`${method} ${path}`, { params, body, bodyRequired, responses, security: securityOptions(op['security'], combined) ?? globalSec });
    }
  }
  return { ops, schemes, precise: true };
}

const normType = (t: unknown) => (t === 'integer' ? 'number' : String(t || 'string'));

// ----- models from catalog entries (JSON examples) -----

function shapeFromExample(value: unknown, depth = 0): Shape {
  if (value === null || value === undefined || depth > MAX_DEPTH) return { type: 'any' };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? shapeFromExample(value[0], depth + 1) : undefined };
  if (typeof value === 'object') {
    const props: Shape['props'] = {};
    for (const [k, v] of Object.entries(value)) props[k] = { shape: shapeFromExample(v, depth + 1), required: false };
    return { type: 'object', props };
  }
  return { type: typeof value === 'number' ? 'number' : typeof value };
}

function shapeFromJsonText(text: string): Shape | undefined {
  if (!text?.trim()) return undefined;
  try {
    return shapeFromExample(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function modelFromApi(api: Pick<ApiInput, 'auth' | 'endpoints'>): ApiModel {
  const schemes: ApiModel['schemes'] = {};
  for (const s of apiSchemes(api)) schemes[s.key] = { type: s.type, name: s.type === 'apiKey' ? s.name : '', in: s.type === 'apiKey' ? s.in : '' };
  const ops = new Map<string, OpModel>();
  for (const ep of api.endpoints) {
    const { required, alternatives } = endpointSchemes(api, ep);
    const keys = [...required, ...alternatives].map((s) => s.key);
    const security = !keys.length ? [[]] : alternatives.length ? keys.map((k) => [k]) : [keys.sort()];
    ops.set(`${ep.method} ${ep.path}`, {
      params: ep.parameters.map((p) => ({ in: p.in, name: p.name, required: p.in === 'path' || !!p.required, type: normType(p.type) })),
      body: shapeFromJsonText(ep.requestBody),
      bodyRequired: false,
      responses: Object.fromEntries(ep.responses.map((r) => [String(r.status), shapeFromJsonText(r.body)])),
      security,
    });
  }
  return { ops, schemes, precise: false };
}

// ----- comparison -----

function compareShapes(
  before: Shape | undefined,
  after: Shape | undefined,
  where: string,
  label: string,
  side: 'request' | 'response',
  precise: boolean,
  out: (breaking: boolean, text: string) => void
) {
  if (!before || !after) return;
  if (before.type !== 'any' && after.type !== 'any' && before.type !== after.type) {
    out(true, `${where}${label ? `: campo \`${label}\`` : ''} mudou de tipo (${before.type} → ${after.type})`);
    return;
  }
  if (before.type === 'array' || after.type === 'array') {
    compareShapes(before.items, after.items, where, label + '[]', side, precise, out);
    return;
  }
  const bp = before.props ?? {};
  const ap = after.props ?? {};
  for (const [k, b] of Object.entries(bp)) {
    const name = label ? `${label}.${k}` : k;
    const a = ap[k];
    if (!a) {
      // Consumers may read any response field; a dropped request field is just ignored.
      if (side === 'response') out(true, `${where}: campo \`${name}\` removido`);
      else out(false, `${where}: campo \`${name}\` não é mais usado`);
      continue;
    }
    if (side === 'request' && precise && !b.required && a.required) out(true, `${where}: campo \`${name}\` passou a ser obrigatório`);
    if (side === 'response' && precise && b.required && !a.required) out(true, `${where}: campo \`${name}\` pode deixar de vir`);
    compareShapes(b.shape, a.shape, where, name, side, precise, out);
  }
  for (const [k, a] of Object.entries(ap)) {
    if (bp[k]) continue;
    const name = label ? `${label}.${k}` : k;
    if (side === 'request' && a.required) out(true, `${where}: novo campo obrigatório \`${name}\``);
    else if (side === 'request') out(false, `${where}: novo campo opcional \`${name}\``);
    else out(false, `${where}: novo campo \`${name}\``);
  }
}

const isSubset = (small: string[], big: string[]) => small.every((k) => big.includes(k));

/** Compares two versions of an API. Both models should come from the same kind of source. */
export function compareModels(before: ApiModel, after: ApiModel): ChangeReport {
  const precise = before.precise && after.precise;
  const changes: Change[] = [];
  const add = (breaking: boolean, route: string, text: string) => changes.push({ breaking, route, text });

  // Credentials redefined (same key, different type or name).
  for (const [k, b] of Object.entries(before.schemes)) {
    const a = after.schemes[k];
    if (!a) continue;
    if (a.type !== b.type || a.name !== b.name || a.in !== b.in) {
      const desc = (s: SchemeModel) => (s.name ? `${s.type} ${s.name}${s.in ? ` (${s.in})` : ''}` : s.type);
      add(true, '', `Credencial \`${k}\` trocada: ${desc(b)} → ${desc(a)}`);
    }
  }

  for (const [route, b] of before.ops) {
    const a = after.ops.get(route);
    if (!a) {
      add(true, route, 'Rota removida');
      continue;
    }
    const out = (breaking: boolean, text: string) => add(breaking, route, text);

    // Parameters.
    for (const bp of b.params) {
      const ap = a.params.find((p) => p.in === bp.in && p.name === bp.name);
      if (!ap) out(false, `parâmetro \`${bp.name}\` (${bp.in}) não é mais usado`);
      else {
        if (!bp.required && ap.required) out(true, `parâmetro \`${bp.name}\` (${bp.in}) passou a ser obrigatório`);
        if (bp.type !== ap.type) out(true, `parâmetro \`${bp.name}\` (${bp.in}) mudou de tipo (${bp.type} → ${ap.type})`);
      }
    }
    for (const ap of a.params) {
      if (b.params.some((p) => p.in === ap.in && p.name === ap.name)) continue;
      out(ap.required, `${ap.required ? 'novo parâmetro obrigatório' : 'novo parâmetro opcional'} \`${ap.name}\` (${ap.in})`);
    }

    // Request body.
    if (!b.body && a.body) out(a.bodyRequired, a.bodyRequired ? 'passou a exigir corpo na requisição' : 'aceita corpo na requisição');
    else if (!b.bodyRequired && a.bodyRequired && precise) out(true, 'corpo da requisição passou a ser obrigatório');
    compareShapes(b.body, a.body, 'corpo', '', 'request', precise, out);

    // Responses: a success status that disappears breaks whoever checks it.
    for (const [code, bs] of Object.entries(b.responses)) {
      if (!(code in a.responses)) {
        if (code.startsWith('2')) out(true, `resposta ${code} removida`);
        continue;
      }
      compareShapes(bs, a.responses[code], `resposta ${code}`, '', 'response', precise, out);
    }
    for (const code of Object.keys(a.responses)) if (!(code in b.responses)) out(false, `nova resposta ${code}`);

    // Credentials: every old way of calling must still be accepted.
    for (const option of b.security) {
      if (a.security.some((n) => isSubset(n, option))) continue;
      const extra = [...new Set(a.security.flat())].filter((k) => !option.includes(k));
      out(true, extra.length ? `passa a exigir a credencial ${extra.map((k) => `\`${k}\``).join(' + ')}` : 'credenciais exigidas mudaram');
      break;
    }
    if (b.security.some((o) => o.length) && a.security.some((o) => !o.length)) out(false, 'deixou de exigir credencial');
  }
  for (const route of after.ops.keys()) if (!before.ops.has(route)) add(false, route, 'Rota nova');

  return { breaking: changes.filter((c) => c.breaking), compatible: changes.filter((c) => !c.breaking), precise };
}

// ----- version and changelog suggestion -----

/** Next version: major when something breaks, minor otherwise ("2.3.1" → "3.0.0" / "2.4.0"). */
export function bumpVersion(version: string, breaking: boolean): string {
  const m = /^(\D*)(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version || '');
  if (!m) return breaking ? '2.0.0' : '1.1.0';
  const [maj, min] = [Number(m[2]), Number(m[3] ?? 0)];
  return `${m[1]}${breaking ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`}`;
}

/** Changelog text (Markdown) summarizing the report. */
export function changelogNotes(report: ChangeReport, limit = 15): string {
  const line = (c: Change) => `- ${c.route ? `\`${c.route}\`: ` : ''}${c.text}`;
  const block = (title: string, list: Change[]) =>
    !list.length ? [] : [`**${title}**`, ...list.slice(0, limit).map(line), ...(list.length > limit ? [`- … e mais ${list.length - limit}`] : [])];
  const parts = [...block('Quebra integrações', report.breaking), ...(report.breaking.length && report.compatible.length ? [''] : []), ...block('Compatível', report.compatible)];
  return parts.join('\n');
}

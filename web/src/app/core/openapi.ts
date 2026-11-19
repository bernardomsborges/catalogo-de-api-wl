import { load } from 'js-yaml';
import { Api, ApiParameter, ApiResponse, AuthConfig, AuthScheme, Endpoint, HttpMethod, METHODS, apiSchemes, emptyApi, emptyScheme } from './models';


type ApiDraft = ReturnType<typeof emptyApi>;
type Obj = Record<string, any>;

/** Builds an example JSON value from a JSON Schema (best effort). */
function sampleFromSchema(schema: Obj | undefined, root: Obj, depth = 0): unknown {
  if (!schema || depth > 6) return null;
  if (schema['$ref']) return sampleFromSchema(resolveRef(schema['$ref'], root), root, depth + 1);
  if (schema['example'] !== undefined) return schema['example'];
  if (schema['default'] !== undefined) return schema['default'];
  if (schema['enum']?.length) return schema['enum'][0];
  if (schema['allOf']) return Object.assign({}, ...schema['allOf'].map((s: Obj) => sampleFromSchema(s, root, depth + 1)));
  if (schema['oneOf'] || schema['anyOf']) return sampleFromSchema((schema['oneOf'] || schema['anyOf'])[0], root, depth + 1);
  switch (schema['type']) {
    case 'object':
    case undefined:
      if (!schema['properties']) return schema['type'] ? {} : null;
      return Object.fromEntries(
        Object.entries(schema['properties']).map(([k, v]) => [k, sampleFromSchema(v as Obj, root, depth + 1)])
      );
    case 'array':
      return [sampleFromSchema(schema['items'], root, depth + 1)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'string':
      if (schema['format'] === 'date-time') return '2026-01-01T00:00:00Z';
      if (schema['format'] === 'date') return '2026-01-01';
      if (schema['format'] === 'email') return 'usuario@exemplo.com';
      return 'string';
    default:
      return null;
  }
}

function resolveRef(ref: string, root: Obj): Obj | undefined {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<any>((acc, key) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function deref<T extends Obj>(obj: T | undefined, root: Obj): T | undefined {
  return obj?.['$ref'] ? (resolveRef(obj['$ref'], root) as T) : obj;
}

function toJson(value: unknown): string {
  return value === null || value === undefined ? '' : JSON.stringify(value, null, 2);
}

function exampleFromContent(content: Obj | undefined, root: Obj): string {
  const media = content?.['application/json'] ?? (content ? Object.values(content)[0] : undefined);
  if (!media) return '';
  if (media.example !== undefined) return toJson(media.example);
  if (media.examples) {
    const first = deref(Object.values(media.examples)[0] as Obj, root);
    if (first?.['value'] !== undefined) return toJson(first['value']);
  }
  return toJson(sampleFromSchema(media.schema, root));
}

/** Converts one OpenAPI/Swagger security scheme into ours. */
function schemeFromSpec(key: string, raw: Obj, spec: Obj): AuthScheme | null {
  const sc = deref(raw, spec);
  if (!sc) return null;
  const base = { ...emptyScheme(), key, name: '', description: sc['description'] ?? '' };
  switch (sc['type']) {
    case 'apiKey':
      return { ...base, type: 'apiKey', name: sc['name'] || key, in: ['query', 'cookie'].includes(sc['in']) ? sc['in'] : 'header' };
    case 'basic': // Swagger 2
      return { ...base, type: 'basic' };
    case 'http':
      if (String(sc['scheme']).toLowerCase() === 'basic') return { ...base, type: 'basic' };
      return { ...base, type: 'bearer', bearerFormat: sc['bearerFormat'] ?? '' };
    case 'oauth2': {
      // OpenAPI 3 has `flows`; Swagger 2 keeps tokenUrl/scopes on the scheme itself.
      const flow = sc['flows']?.clientCredentials ?? Object.values(sc['flows'] ?? {})[0] ?? sc;
      return { ...base, type: 'oauth2', tokenUrl: flow?.tokenUrl ?? '', scopes: Object.keys(flow?.scopes ?? {}).join(' ') };
    }
    case 'openIdConnect': {
      const url = sc['openIdConnectUrl'] ? `OpenID Connect: ${sc['openIdConnectUrl']}` : '';
      return { ...base, type: 'bearer', description: [base.description, url].filter(Boolean).join('\n\n') };
    }
    default:
      return null;
  }
}

/**
 * Reads an OpenAPI `security` list. Each item is one acceptable option; the keys inside an item
 * are used together. Returns the scheme keys and whether they are combined (all) or alternatives (any).
 */
function readRequirement(reqs: Obj[] | undefined, alternativesAreCombined = false): { keys: string[]; mode: 'all' | 'any' } | undefined {
  if (!Array.isArray(reqs)) return undefined;
  const options = reqs.map((r) => Object.keys(r ?? {})).filter((k) => k.length);
  if (!options.length) return { keys: [], mode: 'all' }; // security: [] or [{}] → public
  const combined = options.find((o) => o.length > 1);
  if (options.length === 1 || combined) return { keys: combined ?? options[0], mode: 'all' };
  return { keys: [...new Set(options.flat())], mode: alternativesAreCombined ? 'all' : 'any' };
}

/**
 * FastAPI writes every security dependency as its own item ([{A: []}, {B: []}]), which per OpenAPI
 * means "A or B", even when the route requires both. Its documents are recognizable by the
 * validation schemas it always adds.
 */
function isFastApi(spec: Obj): boolean {
  const schemas = spec['components']?.schemas ?? {};
  return !!schemas['HTTPValidationError'] && !!schemas['ValidationError'];
}

/** Finds the operation that issues the bearer token (its response has an access_token field). */
function tokenIssuer(spec: Obj): string | undefined {
  for (const [path, item] of Object.entries<Obj>(spec['paths'] ?? {})) {
    for (const [m, op] of Object.entries<Obj>(item)) {
      if (!METHODS.includes(m.toUpperCase() as HttpMethod)) continue;
      for (const [code, r] of Object.entries<Obj>(op?.['responses'] ?? {})) {
        if (!code.startsWith('2')) continue;
        const res = deref(r, spec);
        const media = res?.['content']?.['application/json'] ?? (res?.['content'] ? Object.values(res['content'])[0] : undefined);
        const schema = deref(media?.schema ?? res?.['schema'], spec);
        if (schema?.['properties']?.['access_token']) return `${m.toUpperCase()} ${path}`;
      }
    }
  }
  return undefined;
}

function authFromSpec(spec: Obj): { auth: AuthConfig; securityOf: (op: Obj) => string[] | undefined } {
  const auth: AuthConfig = { type: 'none', headerName: '', tokenUrl: '', scopes: '', instructions: '', schemes: [], mode: 'all' };
  const defs: Obj = spec['components']?.securitySchemes ?? spec['securityDefinitions'] ?? {};
  const all = Object.entries(defs)
    .map(([k, v]) => schemeFromSpec(k, v as Obj, spec))
    .filter((s): s is AuthScheme => !!s);
  if (!all.length) return { auth, securityOf: () => undefined };
  const fastApi = isFastApi(spec);
  const read = (reqs: Obj[] | undefined) => readRequirement(reqs, fastApi);

  // Say where the bearer token comes from, when the API itself issues it.
  const issuer = tokenIssuer(spec);
  if (issuer) {
    // Logout: a DELETE on the same path or below it (e.g. DELETE /v1/sessions/current).
    const issuerPath = issuer.split(' ')[1];
    const logoutPath = Object.entries<Obj>(spec['paths'] ?? {}).find(
      ([p, item]) => item?.['delete'] && (p === issuerPath || p.startsWith(issuerPath + '/'))
    )?.[0];
    for (const sc of all) {
      if (sc.type !== 'bearer') continue;
      if (!sc.description) sc.description = `Token de sessão obtido em \`${issuer}\` (campo \`access_token\` da resposta).`;
      sc.tokenEndpoint = issuer;
      if (logoutPath) sc.logoutEndpoint = `DELETE ${logoutPath}`;
    }
  }

  // API default: the global `security`, else the most common one among the operations, else every scheme.
  let def = read(spec['security']);
  if (!def) {
    const counts = new Map<string, number>();
    for (const item of Object.values<Obj>(spec['paths'] ?? {})) {
      for (const [m, op] of Object.entries<Obj>(item)) {
        if (!METHODS.includes(m.toUpperCase() as HttpMethod) || !op?.['security']) continue;
        const r = read(op['security']);
        if (r?.keys.length) counts.set(JSON.stringify(r), (counts.get(JSON.stringify(r)) ?? 0) + 1);
      }
    }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    def = top ? JSON.parse(top[0]) : { keys: all.map((s) => s.key), mode: 'all' };
  }
  const globalKeys = def!.keys;
  const used = new Set<string>(globalKeys);
  // Default schemes first, then the other declared ones (used only by some endpoints).
  auth.schemes = [...all.filter((s) => used.has(s.key)), ...all.filter((s) => !used.has(s.key))];
  auth.mode = def!.mode;
  if (used.size !== all.length) auth.defaults = [...globalKeys];
  auth.type = auth.schemes[0].type;
  auth.headerName = auth.schemes.find((s) => s.type === 'apiKey')?.name ?? '';
  auth.tokenUrl = auth.schemes.find((s) => s.type === 'oauth2')?.tokenUrl ?? '';
  auth.scopes = auth.schemes.find((s) => s.type === 'oauth2')?.scopes ?? '';

  // Endpoints without their own rule use the defaults, so only store differences.
  const isDefault = (keys: string[]) => keys.length === globalKeys.length && keys.every((k) => globalKeys.includes(k));
  const securityOf = (op: Obj) => {
    const keys = read(op['security'])?.keys ?? globalKeys;
    return isDefault(keys) ? undefined : [...keys];
  };
  return { auth, securityOf };
}

/** Parses an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) into a catalog API draft. */
export function importOpenApi(text: string): ApiDraft {
  const spec = load(text) as Obj;
  if (!spec || typeof spec !== 'object' || !spec['paths']) {
    throw new Error('O arquivo não parece ser uma especificação OpenAPI/Swagger válida (faltou "paths").');
  }
  const draft = emptyApi();
  const info = spec['info'] ?? {};
  draft.name = info.title ?? '';
  draft.summary = (info.summary ?? info.description ?? '').split('\n')[0].slice(0, 200);
  draft.description = info.description ?? '';
  draft.version = info.version ?? '1.0.0';
  draft.owner = info.contact?.name ?? '';
  draft.contactEmail = info.contact?.email ?? '';

  if (spec['servers']?.length) {
    draft.environments = spec['servers'].map((s: Obj, i: number) => ({
      name: s['description'] || (i === 0 ? 'Produção' : `Servidor ${i + 1}`),
      url: s['url'],
    }));
    draft.baseUrl = spec['servers'][0].url;
  } else if (spec['host']) {
    draft.baseUrl = `${(spec['schemes'] ?? ['https'])[0]}://${spec['host']}${spec['basePath'] ?? ''}`;
  }
  const { auth, securityOf } = authFromSpec(spec);
  draft.auth = auth;
  // Header params that just repeat a credential (e.g. "X-Client-Id" declared both ways) are left out:
  // the credential already documents and sends them.
  const credentialHeaders = new Set(
    (auth.schemes ?? []).flatMap((s) => (s.type === 'apiKey' ? (s.in === 'header' ? [s.name.toLowerCase()] : []) : ['authorization']))
  );
  draft.tags = (spec['tags'] ?? []).map((t: Obj) => t['name']).filter(Boolean);

  const endpoints: Endpoint[] = [];
  for (const [path, item] of Object.entries<Obj>(spec['paths'])) {
    const shared: Obj[] = item['parameters'] ?? [];
    for (const [method, op] of Object.entries<Obj>(item)) {
      const m = method.toUpperCase() as HttpMethod;
      if (!METHODS.includes(m)) continue;

      const params: ApiParameter[] = [];
      let requestBody = '';
      for (const raw of [...shared, ...(op['parameters'] ?? [])]) {
        const p = deref(raw, spec);
        if (!p) continue;
        if (p['in'] === 'body') {
          requestBody = toJson(sampleFromSchema(p['schema'], spec));
          continue;
        }
        if (!['path', 'query', 'header'].includes(p['in'])) continue;
        if (p['in'] === 'header' && credentialHeaders.has(String(p['name']).toLowerCase())) continue;
        const schema = deref(p['schema'], spec) ?? p;
        params.push({
          name: p['name'],
          in: p['in'],
          type: schema['type'] ?? 'string',
          required: !!p['required'],
          description: p['description'] ?? '',
          example: String(p['example'] ?? schema['example'] ?? ''),
        });
      }
      const body = deref(op['requestBody'], spec);
      if (body) requestBody = exampleFromContent(body['content'], spec);

      const responses: ApiResponse[] = Object.entries<Obj>(op['responses'] ?? {})
        .filter(([code]) => /^\d+$/.test(code))
        .map(([code, r]) => {
          const res = deref(r, spec) ?? {};
          return {
            status: Number(code),
            description: res['description'] ?? '',
            body: res['content'] ? exampleFromContent(res['content'], spec) : toJson(sampleFromSchema(res['schema'], spec)),
          };
        });

      endpoints.push({
        method: m,
        path,
        summary: op['summary'] ?? op['operationId'] ?? '',
        description: op['description'] ?? '',
        ...(op['tags']?.[0] ? { tag: String(op['tags'][0]) } : {}),
        parameters: params,
        requestBody,
        responses,
        ...(securityOf(op) ? { security: securityOf(op) } : {}),
      });
    }
  }
  draft.endpoints = endpoints;
  return draft;
}

function parseJsonOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Exports a catalog API as an OpenAPI 3.0 document. */
export function exportOpenApi(api: Api): Obj {
  const paths: Obj = {};
  for (const ep of api.endpoints) {
    const op: Obj = {
      tags: ep.tag ? [ep.tag] : undefined,
      summary: ep.summary || undefined,
      description: ep.description || undefined,
      parameters: ep.parameters.map((p) => ({
        name: p.name,
        in: p.in,
        required: p.in === 'path' ? true : p.required,
        description: p.description || undefined,
        schema: { type: p.type || 'string' },
        example: p.example || undefined,
      })),
      responses: Object.fromEntries(
        (ep.responses.length ? ep.responses : [{ status: 200, description: 'OK', body: '' }]).map((r) => [
          String(r.status),
          {
            description: r.description || 'Resposta',
            ...(r.body ? { content: { 'application/json': { example: parseJsonOr(r.body) } } } : {}),
          },
        ])
      ),
    };
    if (ep.requestBody?.trim()) {
      op['requestBody'] = { content: { 'application/json': { example: parseJsonOr(ep.requestBody) } } };
    }
    (paths[ep.path] ??= {})[ep.method.toLowerCase()] = op;
  }

  const securitySchemes: Obj = {};
  const schemes = apiSchemes(api);
  for (const sc of schemes) {
    const key = sc.key || sc.type;
    if (sc.type === 'apiKey') securitySchemes[key] = { type: 'apiKey', in: sc.in, name: sc.name || 'X-API-Key' };
    if (sc.type === 'bearer') securitySchemes[key] = { type: 'http', scheme: 'bearer', ...(sc.bearerFormat ? { bearerFormat: sc.bearerFormat } : {}) };
    if (sc.type === 'basic') securitySchemes[key] = { type: 'http', scheme: 'basic' };
    if (sc.type === 'oauth2') {
      securitySchemes[key] = {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: sc.tokenUrl, scopes: Object.fromEntries(sc.scopes.split(/\s+/).filter(Boolean).map((s) => [s, s])) } },
      };
    }
    if (sc.description) securitySchemes[key].description = sc.description;
  }
  const scopesOf = (key: string) => {
    const sc = schemes.find((s) => (s.key || s.type) === key);
    return sc?.type === 'oauth2' ? sc.scopes.split(/\s+/).filter(Boolean) : [];
  };
  // 'all' → one option holding every scheme; 'any' → one option per scheme.
  const requirement = (keys: string[]) =>
    !keys.length ? [] : api.auth.mode === 'any' ? keys.map((k) => ({ [k]: scopesOf(k) })) : [Object.fromEntries(keys.map((k) => [k, scopesOf(k)]))];
  const defaultKeys = api.auth.defaults ?? Object.keys(securitySchemes);
  for (const ep of api.endpoints) {
    if (ep.security) paths[ep.path][ep.method.toLowerCase()].security = requirement(ep.security);
  }

  return JSON.parse(
    JSON.stringify({
      openapi: '3.0.3',
      info: {
        title: api.name,
        version: api.version,
        description: api.description || api.summary,
        contact: { name: api.owner || undefined, email: api.contactEmail || undefined },
      },
      servers: (api.environments.length ? api.environments : [{ name: 'Produção', url: api.baseUrl }]).map((e) => ({
        url: e.url,
        description: e.name,
      })),
      paths,
      ...(Object.keys(securitySchemes).length ? { components: { securitySchemes }, security: requirement(defaultKeys) } : {}),
    })
  );
}

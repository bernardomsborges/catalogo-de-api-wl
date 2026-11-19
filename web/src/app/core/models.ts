export type ApiStatus = 'estavel' | 'beta' | 'depreciada' | 'em-desenvolvimento';
export type AuthType = 'none' | 'apiKey' | 'bearer' | 'oauth2' | 'basic';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ParamLocation = 'path' | 'query' | 'header';

export interface ApiParameter {
  name: string;
  in: ParamLocation;
  type: string;
  required: boolean;
  description: string;
  example: string;
}

export interface ApiResponse {
  status: number;
  description: string;
  body: string;
}

export interface Endpoint {
  id?: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  /** Group of routes (first OpenAPI tag), e.g. "Processos". Folders in the Postman collection. */
  tag?: string;
  parameters: ApiParameter[];
  requestBody: string;
  responses: ApiResponse[];
  /**
   * Which credentials this endpoint needs (keys of `auth.schemes`).
   * Missing = same as the API; empty list = public endpoint.
   */
  security?: string[];
}

export interface Environment {
  name: string;
  url: string;
}

export type SchemeType = Exclude<AuthType, 'none'>;
export type SchemeLocation = 'header' | 'query' | 'cookie';

/** One credential the API expects (an OpenAPI security scheme). */
export interface AuthScheme {
  /** Identifier, e.g. the securitySchemes key in OpenAPI ("ClientId"). */
  key: string;
  type: SchemeType;
  /** apiKey: header/query/cookie name, e.g. "X-Client-Id". */
  name: string;
  in: SchemeLocation;
  description: string;
  /** Placeholder shown in examples, e.g. "SEU_CLIENT_ID". */
  example: string;
  /** bearer: token format hint, e.g. "JWT". */
  bearerFormat: string;
  /** oauth2 */
  tokenUrl: string;
  scopes: string;
  /** bearer: route of this API that issues the token, e.g. "POST /v1/sessions". */
  tokenEndpoint?: string;
  /** bearer: route that ends the session, e.g. "DELETE /v1/sessions/current". */
  logoutEndpoint?: string;
}

export interface AuthConfig {
  /** Main type, kept for filters and older data. Derived from `schemes` when they exist. */
  type: AuthType;
  /** Legacy single-scheme fields (used when `schemes` is empty). */
  headerName: string;
  tokenUrl: string;
  scopes: string;
  instructions: string;
  /** All credentials. */
  schemes?: AuthScheme[];
  /** 'all' = every scheme in the same request; 'any' = pick one of them. */
  mode?: 'all' | 'any';
  /** Keys used by endpoints without their own rule. Missing = all schemes. */
  defaults?: string[];
}

export interface Guide {
  title: string;
  content: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string;
}

export interface Api {
  id: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  category: string;
  tags: string[];
  status: ApiStatus;
  /** Deprecated APIs: the day it is switched off (YYYY-MM-DD) and the id of the API that replaces it. */
  sunsetDate?: string;
  replacedBy?: string;
  version: string;
  owner: string;
  contactEmail: string;
  baseUrl: string;
  environments: Environment[];
  auth: AuthConfig;
  rateLimit: string;
  sla: string;
  endpoints: Endpoint[];
  guides: Guide[];
  changelog: ChangelogEntry[];
  createdAt: string;
  updatedAt: string;
  /** 'private': people outside `groups` only see the summary. */
  visibility?: 'public' | 'private';
  /** Groups whose members may access a private API. */
  groups?: string[];
  /** Set by the server when the API is private and the person has no access (summary only). */
  locked?: boolean;
  /** Published revision (history). Sent back on save so two editors don't overwrite each other. */
  revision?: number;
}

export const STATUS_LABELS: Record<ApiStatus, string> = {
  estavel: 'Estável',
  beta: 'Beta',
  depreciada: 'Depreciada',
  'em-desenvolvimento': 'Em desenvolvimento',
};

export const AUTH_LABELS: Record<AuthType, string> = {
  none: 'Pública (sem autenticação)',
  apiKey: 'Chave de API',
  bearer: 'Token Bearer',
  oauth2: 'OAuth 2.0 (client credentials)',
  basic: 'Basic Auth',
};

export const SCHEME_LABELS: Record<SchemeType, string> = {
  apiKey: 'Chave/identificador',
  bearer: 'Token Bearer',
  oauth2: 'OAuth 2.0 (client credentials)',
  basic: 'Basic Auth',
};

export const LOCATION_LABELS: Record<SchemeLocation, string> = { header: 'Cabeçalho', query: 'Query string', cookie: 'Cookie' };

export function emptyScheme(type: SchemeType = 'apiKey'): AuthScheme {
  return { key: '', type, name: type === 'apiKey' ? 'X-API-Key' : '', in: 'header', description: '', example: '', bearerFormat: '', tokenUrl: '', scopes: '' };
}

/** Placeholder value for a credential in examples ("SEU_CLIENT_ID", "Bearer SEU_TOKEN"…). */
export function schemePlaceholder(s: AuthScheme): string {
  if (s.example) return s.example;
  if (s.type === 'apiKey') {
    if (/^(x-)?api[-_]?key$/i.test(s.name)) return 'SUA_CHAVE_DE_API';
    const base = s.name.replace(/^x-/i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toUpperCase();
    return base ? `SEU_${base}` : 'SUA_CHAVE_DE_API';
  }
  return s.type === 'basic' ? 'BASE64(usuario:senha)' : 'SEU_TOKEN';
}

/** Where the credential travels: name + value as it appears in the request. */
export function schemeWire(s: AuthScheme): { in: SchemeLocation; name: string; value: string } {
  if (s.type === 'apiKey') return { in: s.in, name: s.name || 'X-API-Key', value: schemePlaceholder(s) };
  if (s.type === 'basic') return { in: 'header', name: 'Authorization', value: `Basic ${schemePlaceholder(s)}` };
  return { in: 'header', name: 'Authorization', value: `Bearer ${schemePlaceholder(s)}` };
}

/** Credentials of the API, converting the old single-scheme format when needed. */
export function apiSchemes(api: Pick<Api, 'auth'>): AuthScheme[] {
  const a = api.auth;
  if (a.schemes?.length) return a.schemes;
  if (a.type === 'none') return [];
  return [{ ...emptyScheme(a.type), key: a.type, name: a.type === 'apiKey' ? a.headerName || 'X-API-Key' : '', tokenUrl: a.tokenUrl, scopes: a.scopes }];
}

/**
 * Credentials one endpoint needs. For 'any' mode the first option is used in examples;
 * `alternatives` lists the others.
 */
export function endpointSchemes(api: Pick<Api, 'auth'>, ep?: Pick<Endpoint, 'security'>): { required: AuthScheme[]; alternatives: AuthScheme[] } {
  let all = apiSchemes(api);
  const keys = ep?.security ?? api.auth.defaults;
  if (keys) all = all.filter((s) => keys.includes(s.key));
  if (api.auth.mode === 'any' && all.length > 1) return { required: [all[0]], alternatives: all.slice(1) };
  return { required: all, alternatives: [] };
}

/** Credentials used by default (endpoints without their own rule). */
export function defaultSchemes(api: Pick<Api, 'auth'>): AuthScheme[] {
  const all = apiSchemes(api);
  const keys = api.auth.defaults;
  return keys ? all.filter((s) => keys.includes(s.key)) : all;
}

/** Credentials declared but only used by some endpoints. */
export function extraSchemes(api: Pick<Api, 'auth'>): AuthScheme[] {
  const def = new Set(defaultSchemes(api).map((s) => s.key));
  return apiSchemes(api).filter((s) => !def.has(s.key));
}

/** Distinct auth types of an API (for filters and labels). */
export function apiAuthTypes(api: Pick<Api, 'auth'>): AuthType[] {
  const types = [...new Set(apiSchemes(api).map((s) => s.type))];
  return types.length ? types : ['none'];
}

/** Short human summary, e.g. "2 cabeçalhos: X-Client-Id + X-Client-Secret". */
export function authSummary(api: Pick<Api, 'auth'>): string {
  const schemes = defaultSchemes(api);
  if (!schemes.length) return apiSchemes(api).length ? 'Pública na maioria dos endpoints' : AUTH_LABELS.none;
  if (schemes.length === 1) {
    const s = schemes[0];
    return s.type === 'apiKey' ? `${SCHEME_LABELS.apiKey} (${s.name})` : SCHEME_LABELS[s.type];
  }
  const names = schemes.map((s) => (s.type === 'apiKey' ? s.name : SCHEME_LABELS[s.type]));
  return api.auth.mode === 'any' ? `Uma destas: ${names.join(' ou ')}` : names.join(' + ');
}

export const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Finds an endpoint from a "METHOD /path" reference. */
export function findEndpoint(api: Pick<Api, 'endpoints'>, ref: string | undefined): Endpoint | undefined {
  const m = /^\s*([A-Z]+)\s+(\S+)\s*$/i.exec(ref || '');
  if (!m) return undefined;
  return api.endpoints.find((e) => e.method === m[1].toUpperCase() && e.path === m[2]);
}

function issuesToken(ep: Endpoint): boolean {
  return ep.responses.some((r) => r.status >= 200 && r.status < 300 && /"access_token"\s*:/.test(r.body || ''));
}

/**
 * Session routes for a bearer credential issued by the API itself: the configured ones, or else
 * the endpoint whose success response has `access_token` (and a DELETE under the same path).
 */
export function sessionFlow(api: Pick<Api, 'endpoints'>, s: AuthScheme): { login: Endpoint; logout?: Endpoint } | undefined {
  if (s.type !== 'bearer') return undefined;
  const login = findEndpoint(api, s.tokenEndpoint) ?? (s.tokenEndpoint ? undefined : api.endpoints.find(issuesToken));
  if (!login) return undefined;
  const logout =
    findEndpoint(api, s.logoutEndpoint) ??
    (s.logoutEndpoint ? undefined : api.endpoints.find((e) => e.method === 'DELETE' && (e.path === login.path || e.path.startsWith(login.path + '/'))));
  return { login, logout };
}

export function emptyApi(): Omit<Api, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    slug: '',
    name: '',
    summary: '',
    description: '',
    category: '',
    tags: [],
    status: 'beta',
    version: '1.0.0',
    owner: '',
    contactEmail: '',
    baseUrl: '',
    environments: [],
    auth: { type: 'none', headerName: '', tokenUrl: '', scopes: '', instructions: '', schemes: [], mode: 'all' },
    rateLimit: '',
    sla: '',
    endpoints: [],
    guides: [],
    changelog: [],
    visibility: 'public',
    groups: [],
  };
}

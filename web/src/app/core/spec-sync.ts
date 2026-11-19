import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiInput } from './catalog.service';
import { AuthScheme, Endpoint, emptyApi } from './models';

type ApiDraft = ReturnType<typeof emptyApi>;

/** How the catalog server authenticates to read the document. */
export type SyncAuthType = 'none' | 'bearer' | 'basic' | 'header' | 'query' | 'oauth2';

export const SYNC_AUTH_LABELS: Record<SyncAuthType, string> = {
  none: 'Nenhuma (documento público)',
  bearer: 'Token Bearer',
  basic: 'Basic (usuário e senha)',
  header: 'Cabeçalho personalizado',
  query: 'Parâmetro na URL',
  oauth2: 'OAuth 2.0 (client credentials)',
};

/** Label of the secret field of each type. */
export const SYNC_SECRET_LABELS: Record<SyncAuthType, string> = {
  none: '',
  bearer: 'Token',
  basic: 'Senha',
  header: 'Valor do cabeçalho',
  query: 'Valor do parâmetro',
  oauth2: 'Client secret',
};

/** Sync state of one API, as the server shows it (never includes the read credential). */
export interface SyncStatus {
  configured: boolean;
  intervalHours: number;
  url?: string;
  authType?: SyncAuthType;
  headerName?: string;
  paramName?: string;
  username?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  hasSecret?: boolean;
  lastCheckedAt?: string | null;
  lastError?: string;
  latestHash?: string | null;
  appliedHash?: string | null;
  appliedAt?: string | null;
  pending?: boolean;
  latestText?: string | null;
  appliedText?: string | null;
}

export interface SyncConfig {
  url: string;
  authType: SyncAuthType;
  headerName: string;
  paramName: string;
  username: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  /** New secret (token, password, client secret…); empty keeps the stored one. */
  secret?: string;
  clearSecret?: boolean;
}

@Injectable({ providedIn: 'root' })
export class SpecSyncService {
  private http = inject(HttpClient);

  /** Status of every API with sync configured, by API id. */
  all() {
    return firstValueFrom(this.http.get<Record<string, SyncStatus>>('/api/sync'));
  }
  get(id: string) {
    return firstValueFrom(this.http.get<SyncStatus>(`/api/apis/${id}/sync`));
  }
  /** Saves the settings and fetches the document right away. */
  configure(id: string, config: SyncConfig) {
    return firstValueFrom(this.http.put<SyncStatus>(`/api/apis/${id}/sync`, config));
  }
  check(id: string) {
    return firstValueFrom(this.http.post<SyncStatus>(`/api/apis/${id}/sync/check`, {}));
  }
  /** Downloads a document once for "Importar OpenAPI → Link" (nothing is saved). */
  /** `how`: 'direct' (the address was the document) or where it was found behind a docs page. */
  fetchForImport(config: SyncConfig, apiId?: string) {
    return firstValueFrom(
      this.http.post<{ text: string; source: string; how: 'direct' | 'embedded' | 'linked' | 'common' }>('/api/import/openapi', { ...config, apiId })
    );
  }
  markApplied(id: string, hash: string) {
    return firstValueFrom(this.http.post<SyncStatus>(`/api/apis/${id}/sync/applied`, { hash }));
  }
}

// ----- comparison -----

export interface ChangedEndpoint {
  method: string;
  path: string;
  /** What changed, e.g. ["parâmetros", "respostas"]. */
  what: string[];
}

export interface SpecDiff {
  added: { method: string; path: string; summary: string }[];
  removed: { method: string; path: string; summary: string }[];
  changed: ChangedEndpoint[];
  authChanged: boolean;
  version?: { from: string; to: string };
  hasChanges: boolean;
}

const key = (ep: Pick<Endpoint, 'method' | 'path'>) => `${ep.method} ${ep.path}`;

/** JSON compared by value, ignoring formatting. */
function sameJson(a: string, b: string): boolean {
  const norm = (t: string) => {
    try {
      return JSON.stringify(JSON.parse(t));
    } catch {
      return (t || '').trim();
    }
  };
  return norm(a) === norm(b);
}

const paramsShape = (ep: Endpoint) =>
  JSON.stringify(ep.parameters.map((p) => [p.in, p.name, !!p.required, p.type]).sort());
const responsesShape = (ep: Endpoint) => ep.responses.map((r) => Number(r.status)).sort().join(',');
const securityShape = (ep: Endpoint) => (ep.security ? [...ep.security].sort().join(',') : '*');
const schemesShape = (schemes: AuthScheme[] | undefined) =>
  JSON.stringify((schemes ?? []).map((s) => [s.key, s.type, s.name, s.in]).sort());

function endpointChanges(before: Endpoint, after: Endpoint, compareTexts: boolean): string[] {
  const what: string[] = [];
  if (paramsShape(before) !== paramsShape(after)) what.push('parâmetros');
  if (!sameJson(before.requestBody, after.requestBody)) what.push('corpo da requisição');
  const bodies = before.responses.some((r) => {
    const other = after.responses.find((x) => Number(x.status) === Number(r.status));
    return other && !sameJson(r.body, other.body);
  });
  if (responsesShape(before) !== responsesShape(after) || bodies) what.push('respostas');
  if (securityShape(before) !== securityShape(after)) what.push('credenciais');
  if (compareTexts && (before.summary !== after.summary || before.description !== after.description)) what.push('textos');
  return what;
}

/**
 * What changed in the API. The base is the last applied version of the document; on the first sync
 * (nothing applied yet) it is the catalog itself, comparing only structure since texts may have been
 * edited by hand.
 */
export function diffSpec(current: ApiInput, latest: ApiDraft, applied?: ApiDraft): SpecDiff {
  const base = applied ?? current;
  const baseMap = new Map(base.endpoints.map((e) => [key(e), e]));
  const latestMap = new Map(latest.endpoints.map((e) => [key(e), e]));
  const inCatalog = new Set(current.endpoints.map(key));

  const added = latest.endpoints.filter((e) => !baseMap.has(key(e))).map(({ method, path, summary }) => ({ method, path, summary }));
  // Only routes still in the catalog are really removed by applying.
  const removed = base.endpoints
    .filter((e) => !latestMap.has(key(e)) && inCatalog.has(key(e)))
    .map(({ method, path, summary }) => ({ method, path, summary }));
  const changed: ChangedEndpoint[] = [];
  for (const e of latest.endpoints) {
    const before = baseMap.get(key(e));
    if (!before) continue;
    const what = endpointChanges(before, e, !!applied);
    if (what.length) changed.push({ method: e.method, path: e.path, what });
  }
  const authChanged = !!latest.auth.schemes?.length && schemesShape(base.auth.schemes) !== schemesShape(latest.auth.schemes);
  const baseVersion = base.version;
  const version = latest.version && latest.version !== baseVersion ? { from: baseVersion, to: latest.version } : undefined;
  return { added, removed, changed, authChanged, version, hasChanges: !!(added.length || removed.length || changed.length || authChanged || version) };
}

// ----- merge -----

/**
 * Keeps hand-written text. With the last applied document as reference, a catalog value equal to
 * what the document said before was not edited, so the new document wins. Without it, any filled
 * catalog value counts as edited.
 */
function pick<T>(current: T | undefined, applied: T | undefined, latest: T, hasApplied: boolean): T {
  const empty = current === undefined || current === null || (current as unknown) === '';
  if (empty) return latest;
  if (hasApplied && JSON.stringify(current) === JSON.stringify(applied)) return latest;
  return current as T;
}

/**
 * Applies the latest document to the catalog entry. Routes, parameters, responses and credentials
 * follow the document; guides, category, status, environments, slug and edited texts are kept.
 */
export function mergeSpec(current: ApiInput, latest: ApiDraft, applied?: ApiDraft): ApiInput {
  const has = !!applied;
  const curMap = new Map(current.endpoints.map((e) => [key(e), e]));
  const appMap = new Map((applied?.endpoints ?? []).map((e) => [key(e), e]));
  const latestKeys = new Set(latest.endpoints.map(key));
  // Without credentials in the document, keep the ones registered by hand.
  const useLatestAuth = !!latest.auth.schemes?.length || !current.auth.schemes?.length;

  const endpoints: Endpoint[] = latest.endpoints.map((l) => {
    const c = curMap.get(key(l));
    if (!c) return structuredClone(l);
    const a = appMap.get(key(l));
    return {
      ...(c.id ? { id: c.id } : {}),
      method: l.method,
      path: l.path,
      summary: pick(c.summary, a?.summary, l.summary, has),
      description: pick(c.description, a?.description, l.description, has),
      ...((l.tag ?? c.tag) ? { tag: l.tag ?? c.tag } : {}),
      parameters: l.parameters.map((lp) => {
        const cp = c.parameters.find((p) => p.in === lp.in && p.name === lp.name);
        const ap = a?.parameters.find((p) => p.in === lp.in && p.name === lp.name);
        return { ...lp, description: pick(cp?.description, ap?.description, lp.description, has), example: pick(cp?.example, ap?.example, lp.example, has) };
      }),
      requestBody: pick(c.requestBody, a?.requestBody, l.requestBody, has),
      responses: l.responses.map((lr) => {
        const cr = c.responses.find((r) => Number(r.status) === lr.status);
        const ar = a?.responses.find((r) => Number(r.status) === lr.status);
        return { ...lr, description: pick(cr?.description, ar?.description, lr.description, has), body: pick(cr?.body, ar?.body, lr.body, has) };
      }),
      ...(useLatestAuth ? (l.security ? { security: l.security } : {}) : c.security ? { security: c.security } : {}),
    };
  });
  // Routes added by hand (never in the document) stay. Routes the document dropped are removed.
  for (const c of current.endpoints) {
    const k = key(c);
    if (latestKeys.has(k)) continue;
    const cameFromDoc = has ? appMap.has(k) : true;
    if (!cameFromDoc) endpoints.push(c);
  }

  const auth = useLatestAuth
    ? {
        ...latest.auth,
        instructions: current.auth.instructions || latest.auth.instructions,
        schemes: (latest.auth.schemes ?? []).map((ls) => {
          const cs = current.auth.schemes?.find((s) => s.key === ls.key);
          const as = applied?.auth.schemes?.find((s) => s.key === ls.key);
          return { ...ls, description: pick(cs?.description, as?.description, ls.description, has), example: cs?.example || ls.example };
        }),
      }
    : current.auth;

  return {
    ...current,
    name: pick(current.name, applied?.name, latest.name || current.name, has),
    summary: pick(current.summary, applied?.summary, latest.summary || current.summary, has),
    description: pick(current.description, applied?.description, latest.description, has),
    // The API version is data from the document, not hand-written text.
    version: latest.version || current.version,
    owner: pick(current.owner, applied?.owner, latest.owner, has),
    contactEmail: pick(current.contactEmail, applied?.contactEmail, latest.contactEmail, has),
    tags: pick(current.tags.length ? current.tags : undefined, applied?.tags, latest.tags.length ? latest.tags : current.tags, has),
    auth,
    endpoints,
  };
}

import { Api, Endpoint } from './models';

/** Lowercase, without accents: "Certidão" and "certidao" are the same word. */
export function normalizeText(s: string) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Id of a route's section on the API reference page (#ep-get-workflows). */
export function endpointAnchor(ep: Pick<Endpoint, 'method' | 'path'>) {
  return 'ep-' + (ep.method + ep.path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
}

/** Text of a route that the search looks at: path, title, description and tags. */
function routeText(e: Endpoint) {
  return normalizeText([e.method, e.path, e.summary, e.description, e.tag].filter(Boolean).join(' '));
}

/**
 * How an API matched a search (PRO-206): `routes` lists the routes that made it match, when the API's
 * own texts (name, summary, description, category, team, tags) were not enough; empty otherwise.
 */
export interface ApiMatch {
  routes: Endpoint[];
}

/**
 * Every word of the query must appear in the API's texts or, together with them, in one route.
 * APIs the person can't open come without description and routes, so nothing of them leaks here.
 * Returns null when the API doesn't match.
 */
export function matchApi(api: Api, query: string): ApiMatch | null {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return { routes: [] };
  const own = normalizeText([api.name, api.summary, api.description, api.category, api.owner, ...(api.tags ?? [])].filter(Boolean).join(' '));
  if (terms.every((t) => own.includes(t))) return { routes: [] };
  const routes = (api.endpoints ?? []).filter((e) => {
    const text = routeText(e);
    return terms.every((t) => own.includes(t) || text.includes(t));
  });
  return routes.length ? { routes } : null;
}

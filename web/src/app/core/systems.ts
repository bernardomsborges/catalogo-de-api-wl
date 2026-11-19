import { Change } from './breaking';

/** A system that consumes APIs of the catalog (PRO-166). `routes` empty = the whole API. */
export interface ConsumerSystem {
  id: string;
  name: string;
  owner: string;
  contactEmail: string;
  description: string;
  uses: { apiId: string; routes: string[] }[];
  updatedAt?: string;
  updatedBy?: string;
}

/** A system as the API page shows it: the routes it uses of that API. */
export interface Consumer {
  id: string;
  name: string;
  owner: string;
  contactEmail: string;
  description: string;
  routes: string[];
}

/** An approved access request not yet linked to a system: a system to register, maybe. */
export interface SystemSuggestion {
  requestId: string;
  person: { id: string; name: string; email: string };
  apis: { id: string; name: string }[];
  message: string;
  decidedAt: string;
}

export type SystemInput = Omit<ConsumerSystem, 'id' | 'updatedAt' | 'updatedBy'>;

/** A system hit by breaking changes, and which ones. */
export interface AffectedSystem {
  system: Consumer;
  changes: Change[];
}

/** "METHOD /path": how routes are referenced (same key as the breaking-change report). */
export const routeKey = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

/**
 * Systems affected by breaking changes: a system that uses the whole API is hit by any of them; one
 * that declared its routes, by API-wide changes and by changes to those routes.
 */
export function affectedSystems(breaking: Change[], consumers: Consumer[]): AffectedSystem[] {
  return consumers
    .map((system) => {
      const routes = new Set(system.routes);
      const changes = breaking.filter((c) => !system.routes.length || !c.route || routes.has(c.route));
      return { system, changes };
    })
    .filter((a) => a.changes.length);
}

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth';

/** Totals of a period, as GET /api/admin/metrics returns them (PRO-165). */
export interface MetricsReport {
  from: string;
  to: string;
  days: number;
  apiId: string | null;
  totals: { apiViews: number; guideViews: number; routeViews: number; searches: number; emptySearches: number; consoleCalls: number; consoleErrors: number; unanswered: number };
  apis: { apiId: string; apiName: string; apiSlug: string | null; views: number }[];
  guides: { apiId: string; apiName: string; apiSlug: string | null; guideId: string; views: number }[];
  routes: { apiId: string; apiName: string; apiSlug: string | null; endpointId: string; method: string | null; path: string | null; views: number }[];
  console: { apiId: string; apiName: string; apiSlug: string | null; endpointId: string; method: string | null; path: string | null; calls: number; errors: number }[];
  searches: { term: string; count: number; empty: number }[];
  emptySearches: { term: string; count: number }[];
  daily: { date: string; views: number; searches: number; consoleCalls: number }[];
}

/**
 * Tells the server what was read in the portal, for the usage metrics. Anonymous counters only; the
 * team's own visits (admins and editors) are not sent. Failures are ignored: metrics never get in the way.
 */
@Injectable({ providedIn: 'root' })
export class MetricsService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  view(api: string, detail: { guide?: string; endpoint?: string } = {}) {
    this.send({ type: 'view', api, ...detail });
  }

  search(q: string, results: number) {
    this.send({ type: 'search', q, results });
  }

  report(days: number, api: string | null) {
    const params: Record<string, string> = { days: String(days) };
    if (api) params['api'] = api;
    return firstValueFrom(this.http.get<MetricsReport>('/api/admin/metrics', { params }));
  }

  private send(body: object) {
    if (this.auth.isStaff()) return;
    this.http.post('/api/metrics', body).subscribe({ error: () => {} });
  }
}

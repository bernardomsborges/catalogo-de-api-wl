import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type HealthStatus = 'up' | 'degraded' | 'down' | 'pending';

export interface DayHealth {
  date: string;
  /** 0–100, or null when there was no check that day. */
  uptime: number | null;
  checks: number;
  avgMs: number | null;
}

export interface ApiHealth {
  apiId: string;
  slug: string;
  name: string;
  category: string;
  monitored: boolean;
  status?: HealthStatus;
  since?: string | null;
  latencyMs?: number | null;
  lastCheckedAt?: string | null;
  uptime90?: number | null;
  days?: DayHealth[];
  incidents?: { start: string; end: string | null }[];
}

export const HEALTH_LABELS: Record<HealthStatus | 'unmonitored', string> = {
  up: 'No ar',
  degraded: 'Instável',
  down: 'Fora do ar',
  pending: 'Verificando…',
  unmonitored: 'Sem monitoramento',
};

/** Health of every API (/api/status), shared by the status page, the cards and the API page. */
@Injectable({ providedIn: 'root' })
export class StatusService {
  private http = inject(HttpClient);
  readonly list = signal<ApiHealth[]>([]);
  readonly byApi = computed(() => new Map(this.list().map((h) => [h.apiId, h])));
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  /** Loads the status; reuses a result younger than `maxAgeMs`. */
  refresh(maxAgeMs = 30_000): Promise<void> {
    if (Date.now() - this.loadedAt < maxAgeMs) return Promise.resolve();
    this.inflight ??= firstValueFrom(this.http.get<ApiHealth[]>('/api/status'))
      .then((l) => {
        this.list.set(l);
        this.loadedAt = Date.now();
      })
      .catch(() => {})
      .finally(() => (this.inflight = null));
    return this.inflight;
  }
}

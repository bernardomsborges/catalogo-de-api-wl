import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Api } from './models';

export type ApiInput = Omit<Api, 'id' | 'createdAt' | 'updatedAt'>;

export interface DraftInfo {
  updatedAt: string;
  updatedBy: string;
  baseRevision: number;
}

export interface ApiVersion {
  revision: number;
  savedAt: string;
  savedBy: string;
  note: string;
  version: string;
  name: string;
  endpoints: number;
}

@Injectable({ providedIn: 'root' })
export class CatalogService {
  private http = inject(HttpClient);

  /** Cached list shared by the home, catalog and admin pages. */
  readonly apis = signal<Api[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');

  /** Resolves once the first catalog load finishes (success or failure); the splash screen waits on it. */
  readonly firstLoad: Promise<void>;
  private markFirstLoad!: () => void;

  constructor() {
    this.firstLoad = new Promise((resolve) => (this.markFirstLoad = resolve));
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.apis.set(await firstValueFrom(this.http.get<Api[]>('/api/apis')));
    } catch {
      this.error.set('Não foi possível carregar o catálogo. Verifique se o servidor está rodando.');
    } finally {
      this.loading.set(false);
      this.markFirstLoad();
    }
  }

  get(idOrSlug: string): Promise<Api> {
    return firstValueFrom(this.http.get<Api>(`/api/apis/${encodeURIComponent(idOrSlug)}`));
  }

  async create(input: ApiInput): Promise<Api> {
    const api = await firstValueFrom(this.http.post<Api>('/api/apis', input));
    this.apis.update((list) => [...list, api]);
    return api;
  }

  async update(id: string, input: ApiInput): Promise<Api> {
    const api = await firstValueFrom(this.http.put<Api>(`/api/apis/${id}`, input));
    this.apis.update((list) => list.map((a) => (a.id === id ? api : a)));
    return api;
  }

  /** Publishes the form content (drops the draft, records a revision). */
  async publish(id: string, input: ApiInput): Promise<Api> {
    const api = await firstValueFrom(this.http.post<Api>(`/api/apis/${id}/publish`, input));
    this.apis.update((list) => list.map((a) => (a.id === id ? api : a)));
    return api;
  }

  /** The API's draft, or null when there is none. */
  getDraft(id: string): Promise<(Api & { draft: DraftInfo }) | null> {
    return firstValueFrom(this.http.get<Api & { draft: DraftInfo }>(`/api/apis/${id}/draft`)).catch((e) => {
      if (e?.status === 404) return null;
      throw e;
    });
  }

  saveDraft(id: string, input: ApiInput) {
    return firstValueFrom(this.http.put<DraftInfo>(`/api/apis/${id}/draft`, input));
  }

  discardDraft(id: string) {
    return firstValueFrom(this.http.delete(`/api/apis/${id}/draft`));
  }

  drafts() {
    return firstValueFrom(this.http.get<Record<string, DraftInfo>>('/api/drafts'));
  }

  versions(id: string) {
    return firstValueFrom(this.http.get<ApiVersion[]>(`/api/apis/${id}/versions`));
  }

  version(id: string, revision: number) {
    return firstValueFrom(this.http.get<Api>(`/api/apis/${id}/versions/${revision}`));
  }

  async restore(id: string, revision: number): Promise<Api> {
    const api = await firstValueFrom(this.http.post<Api>(`/api/apis/${id}/versions/${revision}/restore`, {}));
    this.apis.update((list) => list.map((a) => (a.id === id ? api : a)));
    return api;
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/apis/${id}`));
    this.apis.update((list) => list.filter((a) => a.id !== id));
  }
}

export function errorMessage(err: unknown): string {
  const e = err as { error?: { message?: string }; status?: number };
  if (e?.error?.message) return e.error.message;
  if (e?.status === 0) return 'Servidor indisponível.';
  return 'Ocorreu um erro inesperado.';
}

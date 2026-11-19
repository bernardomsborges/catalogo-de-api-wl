import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface AskStep {
  kind: 'endpoint' | 'recipe';
  apiSlug: string | null;
  apiName: string;
  method: string | null;
  path: string | null;
  title: string;
  link: string;
  credentials: string[];
  credentialsMode: 'all' | 'any';
  why?: string;
}

export interface AskAnswer {
  found: boolean;
  answer: string;
  steps: AskStep[];
  main: AskStep | null;
  contacts: { api: string | null; slug: string | null; owner: string; email: string }[];
  mode: 'significado' | 'palavras' | 'palavras+ia' | 'agente';
  aiOff?: boolean;
  related?: AskStep[];
}

/** Opens the "Perguntar" panel from anywhere (header, home search, API page). */
@Injectable({ providedIn: 'root' })
export class AskService {
  private http = inject(HttpClient);
  readonly open = signal(false);
  /** API the questions focus on (API page), or null for the whole catalog. */
  readonly api = signal<{ slug: string; name: string } | null>(null);
  /** API of the page being read: the assistant button opens focused on it. */
  readonly pageApi = signal<{ slug: string; name: string } | null>(null);
  /** Question to start with (e.g. what was typed in the home search). */
  readonly draft = signal('');

  show(opts: { question?: string; api?: { slug: string; name: string } | null } = {}) {
    if (opts.api !== undefined) this.api.set(opts.api);
    if (opts.question !== undefined) this.draft.set(opts.question);
    this.open.set(true);
  }

  close() {
    this.open.set(false);
  }

  ask(question: string, api?: string, history: { role: 'user' | 'assistant'; content: string }[] = []) {
    return firstValueFrom(this.http.post<AskAnswer>('/api/ai/ask', { question, api, history }));
  }
}

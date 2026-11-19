import { HttpClient } from '@angular/common/http';
import { ArrowKeys } from '../../shared/arrow-keys';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CatalogService, errorMessage } from '../../core/catalog.service';

/** A question the assistant couldn't answer, with the same question asked again grouped together. */
export interface GapGroup {
  key: string;
  question: string;
  /** Times it was asked, and how many of those are still open. */
  count: number;
  open: number;
  firstAt: string;
  lastAt: string;
  /** Slugs of the API pages where it was asked. */
  apis: string[];
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** /admin/perguntas: questions without an answer — where the documentation is missing (PRO-198). */
@Component({
  selector: 'app-ai-gaps',
  imports: [ArrowKeys, RouterLink],
  template: `
    <div class="container page">
      <div class="row head">
        <div>
          <a routerLink="/admin" class="small">← Voltar ao painel</a>
          <h1>Perguntas sem resposta</h1>
          <p class="muted">O que as pessoas perguntaram ao assistente e ele não encontrou no catálogo. Cada uma aponta uma documentação que falta.</p>
        </div>
      </div>

      <div class="tabs" appArrowKeys role="tablist" aria-label="Situação">
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'abertas'" [class.on]="tab() === 'abertas'" (click)="tab.set('abertas')">Em aberto ({{ openGroups().length }})</button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'resolvidas'" [class.on]="tab() === 'resolvidas'" (click)="tab.set('resolvidas')">Resolvidas ({{ resolvedGroups().length }})</button>
      </div>

      @if (message()) { <div class="alert" [class.alert-ok]="!isError()" [class.alert-error]="isError()" role="status">{{ message() }}</div> }

      @if (loading()) {
        <p class="muted">Carregando…</p>
      } @else {
        <ul class="list">
          @for (g of shown(); track g.key) {
            <li class="card item">
              <div class="body">
                <p class="question">“{{ g.question }}”</p>
                <p class="small muted">
                  @if (g.count > 1) { <span class="tag tag-count">{{ g.count }} vezes</span> }
                  Última vez em {{ date(g.lastAt) }}@if (g.count > 1) { · primeira em {{ date(g.firstAt) }} }
                  @if (g.resolved && g.resolvedAt) { · resolvida em {{ date(g.resolvedAt) }}@if (g.resolvedBy) { por {{ g.resolvedBy }} } }
                </p>
                <p class="small">
                  @for (s of g.apis; track s) {
                    @if (apiBySlug()[s]; as a) {
                      <a class="tag tag-api" [routerLink]="['/admin/editar', a.id]" [title]="'Documentar na API ' + a.name">Perguntada na página de {{ a.name }} →</a>
                    } @else {
                      <span class="tag">Página de “{{ s }}” (removida)</span>
                    }
                  } @empty {
                    <span class="muted">Perguntada fora da página de uma API. Documente numa API existente ou <a routerLink="/admin/nova">cadastre uma nova</a>.</span>
                  }
                </p>
              </div>
              <div class="actions">
                @if (g.resolved) {
                  <button class="btn btn-sm" type="button" (click)="setResolved(g, false)" [disabled]="busy() === g.key">Reabrir</button>
                } @else {
                  <button class="btn btn-sm btn-primary" type="button" (click)="setResolved(g, true)" [disabled]="busy() === g.key" title="A documentação já responde a esta pergunta">Marcar como resolvida</button>
                }
              </div>
            </li>
          } @empty {
            <li class="empty muted">
              @if (tab() === 'abertas') { Nenhuma pergunta sem resposta em aberto. } @else { Nenhuma pergunta resolvida ainda. }
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); padding-bottom: 64px; display: flex; flex-direction: column; gap: 18px; }
    .head h1 { margin: 4px 0 0; }
    .head p { margin: 4px 0 0; max-width: 70ch; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 14px; font: inherit; font-weight: 600; color: var(--text-2); cursor: pointer; }
    .tabs button.on { color: var(--text); border-bottom-color: var(--brand); }
    .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .item { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; padding: 16px 18px; }
    .body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .body p { margin: 0; }
    .question { font-weight: 600; overflow-wrap: anywhere; }
    .tag-count { background: var(--warn-soft); color: var(--warn); margin-right: 4px; }
    .tag-api { text-decoration: none; margin-right: 4px; }
    .actions { flex-shrink: 0; }
    .empty { padding: 24px 0; text-align: center; }
    @media (max-width: 640px) {
      .item { flex-direction: column; }
    }
  `,
})
export class AiGaps implements OnInit {
  private http = inject(HttpClient);
  private catalog = inject(CatalogService);

  groups = signal<GapGroup[]>([]);
  tab = signal<'abertas' | 'resolvidas'>('abertas');
  loading = signal(true);
  busy = signal<string | null>(null);
  message = signal('');
  isError = signal(false);

  openGroups = computed(() => this.groups().filter((g) => !g.resolved));
  resolvedGroups = computed(() => this.groups().filter((g) => g.resolved));
  shown = computed(() => (this.tab() === 'abertas' ? this.openGroups() : this.resolvedGroups()));
  apiBySlug = computed(() => Object.fromEntries(this.catalog.apis().map((a) => [a.slug, a])));

  async ngOnInit() {
    this.catalog.refresh();
    try {
      this.groups.set(await firstValueFrom(this.http.get<GapGroup[]>('/api/ai/gaps')));
    } catch (e) {
      this.say(errorMessage(e), true);
    } finally {
      this.loading.set(false);
    }
  }

  async setResolved(g: GapGroup, resolved: boolean) {
    this.busy.set(g.key);
    try {
      const updated = await firstValueFrom(this.http.post<GapGroup>('/api/ai/gaps/resolve', { key: g.key, resolved }));
      this.groups.update((list) => list.map((x) => (x.key === g.key ? updated : x)));
      this.say(resolved ? 'Pergunta marcada como resolvida. Se alguém perguntar de novo, ela volta para “Em aberto”.' : 'Pergunta reaberta.');
    } catch (e) {
      this.say(errorMessage(e), true);
    } finally {
      this.busy.set(null);
    }
  }

  private say(text: string, error = false) {
    this.message.set(text);
    this.isError.set(error);
  }

  date(iso: string) {
    return new Date(iso).toLocaleDateString('pt-BR');
  }
}

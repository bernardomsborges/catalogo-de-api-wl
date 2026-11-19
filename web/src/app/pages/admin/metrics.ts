import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CatalogService, errorMessage } from '../../core/catalog.service';
import { buildGuides } from '../../core/guides';
import { HttpMethod } from '../../core/models';
import { MetricsReport, MetricsService } from '../../core/metrics.service';
import { MethodBadge } from '../../shared/ui';

/** /admin/metricas: how the portal is used — where to invest in the documentation (PRO-165). */
@Component({
  selector: 'app-metrics',
  imports: [FormsModule, RouterLink, MethodBadge],
  template: `
    <div class="container page">
      <div class="row head">
        <div>
          <a routerLink="/admin" class="small">← Voltar ao painel</a>
          <h1>Métricas de uso</h1>
          <p class="muted">Contadores anônimos por dia: nada de IP, conta, credencial ou corpo de requisição. As visitas de administradores e editores não entram.</p>
        </div>
      </div>

      <div class="filters card">
        <div class="field">
          <label for="m-days">Período</label>
          <select id="m-days" [ngModel]="days()" (ngModelChange)="days.set(+$event)">
            <option [value]="7">Últimos 7 dias</option>
            <option [value]="30">Últimos 30 dias</option>
            <option [value]="90">Últimos 90 dias</option>
          </select>
        </div>
        <div class="field">
          <label for="m-api">API</label>
          <select id="m-api" [ngModel]="apiId() ?? ''" (ngModelChange)="apiId.set($event || null)">
            <option value="">Todas as APIs</option>
            @for (a of apiOptions(); track a.id) { <option [value]="a.id">{{ a.name }}</option> }
          </select>
        </div>
        @if (report(); as r) { <p class="small muted period">De {{ date(r.from) }} a {{ date(r.to) }}</p> }
      </div>

      @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }

      @if (report(); as r) {
        <div class="stats" [attr.aria-busy]="loading()">
          <div class="card stat"><span>Páginas de API abertas</span><strong>{{ r.totals.apiViews }}</strong></div>
          <div class="card stat"><span>Guias lidos</span><strong>{{ r.totals.guideViews }}</strong></div>
          <div class="card stat"><span>Rotas abertas</span><strong>{{ r.totals.routeViews }}</strong></div>
          <div class="card stat">
            <span>Chamadas no console</span><strong>{{ r.totals.consoleCalls }}</strong>
            @if (r.totals.consoleCalls) { <small>{{ pct(r.totals.consoleErrors, r.totals.consoleCalls) }} com erro</small> }
          </div>
          @if (!r.apiId) {
            <div class="card stat">
              <span>Buscas</span><strong>{{ r.totals.searches }}</strong>
              @if (r.totals.searches) { <small>{{ r.totals.emptySearches }} sem resultado</small> }
            </div>
          }
          <a class="card stat link-stat" routerLink="/admin/perguntas"><span>Perguntas sem resposta</span><strong>{{ r.totals.unanswered }}</strong><small>Ver as perguntas →</small></a>
        </div>

        <div class="grid">
          @if (!r.apiId) {
            <section class="card block">
              <h2>APIs mais vistas</h2>
              <table class="table">
                <thead><tr><th>API</th><th class="num">Aberturas</th></tr></thead>
                <tbody>
                  @for (a of r.apis; track a.apiId) {
                    <tr><td><button type="button" class="linkish" (click)="apiId.set(a.apiId)" [title]="'Ver só ' + a.apiName">{{ a.apiName }}</button></td><td class="num">{{ a.views }}</td></tr>
                  } @empty { <tr><td colspan="2" class="empty">Nenhuma visita no período.</td></tr> }
                </tbody>
              </table>
            </section>
          }

          <section class="card block">
            <h2>Rotas mais vistas</h2>
            <table class="table">
              <thead><tr><th>Rota</th>@if (!r.apiId) { <th>API</th> }<th class="num">Aberturas</th></tr></thead>
              <tbody>
                @for (x of r.routes; track x.apiId + x.endpointId) {
                  <tr>
                    <td>@if (x.method) { <app-method [method]="asMethod(x.method)" /> }<code>{{ x.path }}</code></td>
                    @if (!r.apiId) { <td class="small">{{ x.apiName }}</td> }
                    <td class="num">{{ x.views }}</td>
                  </tr>
                } @empty { <tr><td [attr.colspan]="r.apiId ? 2 : 3" class="empty">Nenhuma rota aberta no período.</td></tr> }
              </tbody>
            </table>
          </section>

          <section class="card block">
            <h2>Guias mais lidos</h2>
            <table class="table">
              <thead><tr><th>Guia</th>@if (!r.apiId) { <th>API</th> }<th class="num">Leituras</th></tr></thead>
              <tbody>
                @for (g of r.guides; track g.apiId + g.guideId) {
                  <tr>
                    <td>{{ guideTitle(g.apiId, g.guideId) }}</td>
                    @if (!r.apiId) { <td class="small">{{ g.apiName }}</td> }
                    <td class="num">{{ g.views }}</td>
                  </tr>
                } @empty { <tr><td [attr.colspan]="r.apiId ? 2 : 3" class="empty">Nenhum guia lido no período.</td></tr> }
              </tbody>
            </table>
          </section>

          <section class="card block wide">
            <h2>Console de testes por rota</h2>
            <p class="small muted">Só chamadas reais (a simulação não passa pelo servidor). Erro: a API respondeu com status 400 ou maior, ou não respondeu.</p>
            <table class="table">
              <thead><tr><th>Rota</th>@if (!r.apiId) { <th>API</th> }<th class="num">Chamadas</th><th class="num">Erros</th><th class="num">Taxa de erro</th></tr></thead>
              <tbody>
                @for (c of r.console; track c.apiId + c.endpointId) {
                  <tr>
                    <td>
                      @if (c.method) { <app-method [method]="asMethod(c.method)" /><code>{{ c.path }}</code> }
                      @else { <span class="muted">{{ c.path || 'Rota não identificada' }}</span> }
                    </td>
                    @if (!r.apiId) { <td class="small">{{ c.apiName }}</td> }
                    <td class="num">{{ c.calls }}</td>
                    <td class="num">{{ c.errors }}</td>
                    <td class="num" [class.bad]="c.errors / c.calls >= 0.5">{{ pct(c.errors, c.calls) }}</td>
                  </tr>
                } @empty { <tr><td [attr.colspan]="r.apiId ? 4 : 5" class="empty">Nenhuma chamada no período.</td></tr> }
              </tbody>
            </table>
          </section>

          @if (!r.apiId) {
            <section class="card block">
              <h2>Buscas sem resultado</h2>
              <p class="small muted">O que as pessoas procuraram e o catálogo ainda não tem.</p>
              <table class="table">
                <thead><tr><th>Busca</th><th class="num">Vezes</th></tr></thead>
                <tbody>
                  @for (s of r.emptySearches; track s.term) {
                    <tr><td>“{{ s.term }}”</td><td class="num">{{ s.count }}</td></tr>
                  } @empty { <tr><td colspan="2" class="empty">Nenhuma busca sem resultado no período.</td></tr> }
                </tbody>
              </table>
            </section>

            <section class="card block">
              <h2>Buscas mais feitas</h2>
              <table class="table">
                <thead><tr><th>Busca</th><th class="num">Vezes</th><th class="num">Sem resultado</th></tr></thead>
                <tbody>
                  @for (s of r.searches; track s.term) {
                    <tr><td>“{{ s.term }}”</td><td class="num">{{ s.count }}</td><td class="num">{{ s.empty }}</td></tr>
                  } @empty { <tr><td colspan="3" class="empty">Nenhuma busca no período.</td></tr> }
                </tbody>
              </table>
            </section>
          } @else {
            <p class="small muted wide">As buscas valem para o catálogo inteiro: escolha “Todas as APIs” para vê-las.</p>
          }
        </div>
      } @else if (loading()) {
        <p class="muted">Carregando…</p>
      }
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); padding-bottom: 64px; display: flex; flex-direction: column; gap: 18px; }
    .head h1 { margin: 4px 0 0; }
    .head p { margin: 4px 0 0; max-width: 75ch; }
    .filters { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; padding: 14px 18px; }
    .filters .field { min-width: 200px; }
    .period { margin: 0 0 8px auto; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .stat { padding: 16px 18px; display: flex; flex-direction: column; gap: 2px; }
    .stat span { font-size: 0.8rem; color: var(--text-3); }
    .stat strong { font-size: 1.6rem; color: var(--text); }
    .stat small { font-size: 0.78rem; color: var(--text-2); }
    .link-stat { text-decoration: none; }
    .link-stat:hover { border-color: var(--brand); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 18px; align-items: start; }
    .wide { grid-column: 1 / -1; }
    .block { padding: 18px 0 6px; overflow-x: auto; }
    .block h2 { margin: 0 18px 4px; font-size: 1.05rem; }
    .block > p { margin: 0 18px 8px; }
    .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .bad { color: var(--danger); font-weight: 600; }
    td code { margin-left: 6px; overflow-wrap: anywhere; }
    .empty { color: var(--text-3); text-align: center; padding: 18px; }
    .linkish { background: none; border: 0; padding: 0; font: inherit; color: var(--link); cursor: pointer; text-align: left; }
    .linkish:hover { text-decoration: underline; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class Metrics {
  private service = inject(MetricsService);
  private catalog = inject(CatalogService);

  days = signal(30);
  apiId = signal<string | null>(null);
  report = signal<MetricsReport | null>(null);
  loading = signal(true);
  error = signal('');

  apiOptions = computed(() => [...this.catalog.apis()].sort((a, b) => a.name.localeCompare(b.name)));
  /** Guide titles by API (the server only keeps the guide's id). */
  private guideTitles = computed(() => new Map(this.catalog.apis().map((a) => [a.id, new Map(buildGuides(a).map((g) => [g.id, g.title]))])));

  constructor() {
    this.catalog.refresh();
    effect((onCleanup) => {
      const days = this.days();
      const api = this.apiId();
      let current = true;
      onCleanup(() => (current = false));
      this.loading.set(true);
      this.service.report(days, api).then(
        (r) => current && (this.report.set(r), this.error.set('')),
        (e) => current && this.error.set(errorMessage(e))
      ).finally(() => current && this.loading.set(false));
    });
  }

  guideTitle(apiId: string, guideId: string) {
    return this.guideTitles().get(apiId)?.get(guideId) ?? guideId;
  }

  asMethod(m: string) {
    return m as HttpMethod;
  }

  pct(part: number, total: number) {
    return total ? `${Math.round((part / total) * 100)}%` : '—';
  }

  date(iso: string) {
    return new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR');
  }
}

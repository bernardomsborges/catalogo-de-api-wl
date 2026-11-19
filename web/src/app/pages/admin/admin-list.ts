import { HttpClient } from '@angular/common/http';
import { AppDialog } from '../../shared/dialog';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth';
import { CatalogService, errorMessage } from '../../core/catalog.service';
import { Api } from '../../core/models';
import { SpecSyncService, SyncStatus } from '../../core/spec-sync';
import { StatusBadge } from '../../shared/ui';
import { QualityScore } from '../../shared/quality-score';
import { RecipeService } from '../../core/recipe.service';
import { AccessService } from '../../core/access.service';
import { Recipe } from '../../core/recipes';
import { docQuality, recipesUsing } from '../../../../../shared/doc-quality';
import { downloadText, TransferService } from '../../core/transfer.service';

@Component({
  selector: 'app-admin-list',
  imports: [AppDialog, FormsModule, RouterLink, StatusBadge, QualityScore],
  template: `
    <div class="container page">
      <div class="row head">
        <div>
          <h1>Painel admin</h1>
          <p class="muted">Conectado como <strong>{{ auth.user() }}</strong> · <a routerLink="/conta">Minha conta</a></p>
        </div>
        <span class="spacer"></span>
        @if (auth.isAdmin()) {
          <a class="btn" routerLink="/admin/pessoas">Pessoas e acesso @if (pendingRequests()) { <span class="count" [attr.aria-label]="pendingRequests() + ' pedidos aguardando'">{{ pendingRequests() }}</span> }</a>
        }
        <a class="btn" routerLink="/admin/receapitos">ReceAPItos</a>
        <a class="btn" routerLink="/admin/sistemas" title="Quais sistemas usam cada API, e o mapa de dependências">Sistemas</a>
        <a class="btn" routerLink="/admin/metricas" title="APIs, rotas e guias mais vistos, buscas sem resultado e uso do console">Métricas</a>
        <a class="btn" routerLink="/admin/perguntas" title="O que o assistente não soube responder: documentação que falta">Perguntas sem resposta @if (openGaps()) { <span class="count" [attr.aria-label]="openGaps() + ' em aberto'">{{ openGaps() }}</span> }</a>
        <button class="btn" type="button" (click)="openExport()" title="Levar APIs para outro catálogo, por exemplo de homologação para produção">Exportar</button>
        <a class="btn" routerLink="/admin/importar" title="Trazer APIs exportadas de outro catálogo">Importar</a>
        <a class="btn btn-primary" routerLink="/admin/nova">+ Nova API</a>
        <button class="btn" type="button" (click)="auth.logout()">Sair</button>
      </div>

      <div class="stats">
        <div class="card stat"><span>APIs</span><strong>{{ catalog.apis().length }}</strong></div>
        <div class="card stat"><span>Endpoints</span><strong>{{ endpoints() }}</strong></div>
        <div class="card stat"><span>Estáveis</span><strong>{{ count('estavel') }}</strong></div>
        <div class="card stat"><span>Depreciadas</span><strong>{{ count('depreciada') }}</strong></div>
        <div class="card stat"><span>Nota média da documentação</span><strong>{{ averageScore() ?? '—' }}</strong></div>
      </div>

      @if (message()) {
        <div class="alert" [class.alert-ok]="!isError()" [class.alert-error]="isError()" role="status">{{ message() }}</div>
      }

      <div class="card">
        <div class="toolbar">
          <label class="sr-only" for="filtro">Filtrar</label>
          <input id="filtro" [(ngModel)]="filter" placeholder="Filtrar por nome, categoria ou time…" />
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th [attr.aria-sort]="sortBy() === 'nome' ? 'ascending' : null"><button type="button" class="sort" (click)="sortBy.set('nome')">Nome{{ sortBy() === 'nome' ? ' ↑' : '' }}</button></th>
                <th>Categoria</th><th>Status</th>
                <th [attr.aria-sort]="sortBy() === 'nota' ? 'ascending' : null"><button type="button" class="sort" (click)="sortBy.set('nota')" title="Ordenar pelas piores notas primeiro">Nota{{ sortBy() === 'nota' ? ' ↑' : '' }}</button></th>
                <th>Endpoints</th><th>Atualizada</th><th class="right">Ações</th>
              </tr>
            </thead>
            <tbody>
              @for (a of visible(); track a.id) {
                <tr>
                  <td>
                    <strong>{{ a.name }}</strong>
                    @if (a.visibility === 'private') { <span class="tag tag-private" [title]="'Privada: ' + (groupNames(a) || 'só administradores e editores')">🔒 Privada</span> }
                    @if (drafts()[a.id]) { <a class="tag tag-draft" [routerLink]="['/admin/editar', a.id]" title="Há mudanças salvas como rascunho, ainda não publicadas">Rascunho</a> }
                    @if (sync()[a.id]; as s) {
                      @if (s.lastError) {
                        <a class="tag tag-err" [routerLink]="['/admin/editar', a.id]" fragment="sincronizacao" [title]="s.lastError">OpenAPI: erro na busca</a>
                      } @else if (s.pending) {
                        <a class="tag tag-new" [routerLink]="['/admin/editar', a.id]" fragment="sincronizacao">OpenAPI: revisar mudanças</a>
                      }
                    }
                    @if (a.status === 'depreciada' && a.sunsetDate) {
                      <span class="tag tag-sunset" [title]="(followers()[a.id] || 0) + ' pessoa(s) ainda acompanham esta API'">Desliga em {{ brDay(a.sunsetDate) }}</span>
                    }
                    <div class="small muted">{{ a.owner || '—' }}@if (followers()[a.id]; as n) { · {{ n }} {{ n === 1 ? 'pessoa acompanha' : 'pessoas acompanham' }} }@else if (a.status === 'depreciada') { · ninguém acompanha }</div>
                  </td>
                  <td>{{ a.category }}</td>
                  <td><app-status-badge [status]="a.status" /></td>
                  <td><a [routerLink]="['/admin/editar', a.id]" fragment="qualidade" class="score-link" [attr.aria-label]="'Nota ' + scores()[a.id] + ': ver o que falta'"><app-quality-score [score]="scores()[a.id]" /></a></td>
                  <td>{{ a.endpoints.length }}</td>
                  <td class="small muted">{{ a.updatedAt.slice(0, 10).split('-').reverse().join('/') }}</td>
                  <td class="right actions">
                    <a class="btn btn-sm btn-ghost" [routerLink]="['/apis', a.slug]">Ver</a>
                    <a class="btn btn-sm" [routerLink]="['/admin/editar', a.id]">Editar</a>
                    <button class="btn btn-sm btn-danger" type="button" (click)="toDelete.set(a)">Excluir</button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="empty">Nenhuma API encontrada.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    @if (exporting()) {
      <div class="backdrop" (click)="exporting.set(false)">
        <div class="card dialog dialog-wide" appDialog (dismiss)="exporting.set(false)" role="dialog" aria-modal="true" aria-labelledby="exp-title" (click)="$event.stopPropagation()">
          <h2 id="exp-title">Exportar APIs</h2>
          <p class="muted small">Gera um arquivo para levar estas APIs a outro catálogo, por exemplo de homologação para produção. No outro sistema, use <strong>Importar</strong> no painel. Vai só o que está publicado: rascunhos, histórico, quem acompanha, verificações de saúde e a sincronização do OpenAPI ficam aqui.</p>
          <div class="row pick-head">
            <strong class="small">{{ picked().size }} de {{ catalog.apis().length }} APIs</strong>
            <span class="spacer"></span>
            <button class="btn btn-sm btn-ghost" type="button" (click)="pickAll(true)">Marcar todas</button>
            <button class="btn btn-sm btn-ghost" type="button" (click)="pickAll(false)">Desmarcar todas</button>
          </div>
          <ul class="pick">
            @for (a of sortedApis(); track a.id) {
              <li><label><input type="checkbox" [checked]="picked().has(a.id)" (change)="togglePick(a.id)" /> {{ a.name }} @if (a.visibility === 'private') { <span class="tag tag-private">🔒 Privada</span> }</label></li>
            }
          </ul>
          <label class="small"><input type="checkbox" [(ngModel)]="exportRecipes" /> Levar os ReceAPItos que usam só estas APIs</label>
          @if (exportMessage()) { <div class="alert" [class.alert-ok]="!exportError()" [class.alert-error]="exportError()" role="status">{{ exportMessage() }}</div> }
          <div class="row end">
            <button class="btn" type="button" (click)="exporting.set(false)">Fechar</button>
            <button class="btn" type="button" (click)="runExport('copy')" [disabled]="!picked().size || exportBusy()">Copiar</button>
            <button class="btn btn-primary" type="button" (click)="runExport('file')" [disabled]="!picked().size || exportBusy()">{{ exportBusy() ? 'Gerando…' : 'Baixar arquivo' }}</button>
          </div>
        </div>
      </div>
    }

    @if (toDelete(); as a) {
      <div class="backdrop" (click)="toDelete.set(null)">
        <div class="card dialog" appDialog (dismiss)="toDelete.set(null)" role="alertdialog" aria-modal="true" aria-labelledby="del-title" (click)="$event.stopPropagation()">
          <h2 id="del-title">Excluir “{{ a.name }}”?</h2>
          <p class="muted">A API e toda a sua documentação serão removidas do catálogo. Essa ação não pode ser desfeita.</p>
          <div class="row end">
            <button class="btn" type="button" (click)="toDelete.set(null)">Cancelar</button>
            <button class="btn btn-primary danger" type="button" (click)="confirmDelete(a)" [disabled]="deleting()">{{ deleting() ? 'Excluindo…' : 'Excluir' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); display: flex; flex-direction: column; gap: 20px; }
    .head h1 { margin: 0; }
    .head p { margin: 0; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .stat { padding: 16px 18px; display: flex; flex-direction: column; }
    .stat span { font-size: 0.8rem; color: var(--text-3); }
    .stat strong { font-size: 1.6rem; }
    .toolbar { padding: 14px; border-bottom: 1px solid var(--border); }
    .right { text-align: right; }
    .actions { white-space: nowrap; }
    .actions .btn { margin-left: 4px; }
    .backdrop { position: fixed; inset: 0; background: var(--overlay); display: grid; place-items: center; padding: 16px; z-index: 50; }
    .dialog { max-width: 440px; width: 100%; padding: 24px; }
    .end { justify-content: flex-end; }
    .dialog-wide { max-width: 560px; display: flex; flex-direction: column; gap: 12px; }
    .dialog-wide h2, .dialog-wide p { margin: 0; }
    .pick { list-style: none; margin: 0; padding: 4px 12px; max-height: 300px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); }
    .pick li { padding: 6px 0; }
    .pick label { display: flex; gap: 8px; align-items: center; cursor: pointer; }
    .danger { background: var(--danger); border-color: var(--danger); }
    .tag { margin-left: 6px; text-decoration: none; font-weight: 600; }
    .tag-new { background: var(--warn-soft); color: var(--warn); }
    .tag-err { background: var(--danger-soft); color: var(--danger); }
    .tag-draft { background: var(--brand-soft); color: var(--brand); }
    .tag-private { background: var(--surface-2); color: var(--text-2); }
    .tag-sunset { background: var(--danger-soft); color: var(--danger); margin-left: 6px; }
    .count { background: var(--danger); color: #fff; border-radius: 999px; font-size: 0.72rem; padding: 1px 7px; margin-left: 4px; }
    .sort { background: none; border: 0; padding: 0; font: inherit; font-weight: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; cursor: pointer; }
    th[aria-sort] .sort { color: var(--text); }
    .sort:hover { color: var(--text); }
    .score-link { text-decoration: none; }
  `,
})
export class AdminList implements OnInit {
  catalog = inject(CatalogService);
  auth = inject(AuthService);
  private specSync = inject(SpecSyncService);
  private http = inject(HttpClient);
  private recipeService = inject(RecipeService);
  private access = inject(AccessService);
  pendingRequests = signal(0);
  /** Questions the assistant couldn't answer, still open. */
  openGaps = signal(0);
  private groupsById = signal<Record<string, string>>({});
  groupNames(a: Api) {
    return (a.groups || []).map((g) => this.groupsById()[g]).filter(Boolean).join(', ');
  }
  /** OpenAPI sync status by API id. */
  sync = signal<Record<string, SyncStatus>>({});
  /** Active e-mail subscriptions by API id. */
  brDay(d: string) {
    return d.split('-').reverse().join('/');
  }
  followers = signal<Record<string, number>>({});
  /** APIs with an unpublished draft. */
  drafts = signal<Record<string, unknown>>({});

  filter = '';
  toDelete = signal<Api | null>(null);
  deleting = signal(false);
  message = signal(history.state?.message ?? '');
  isError = signal(false);

  recipes = signal<Recipe[]>([]);
  sortBy = signal<'nome' | 'nota'>('nome');
  /** Documentation score (PRO-164) of each published API, by id. */
  scores = computed(() => Object.fromEntries(this.catalog.apis().map((a) => [a.id, docQuality(a, { recipes: recipesUsing(a, this.recipes()) }).score])));
  averageScore = computed(() => {
    const all = Object.values(this.scores());
    return all.length ? Math.round(all.reduce((n, s) => n + s, 0) / all.length) : null;
  });

  endpoints = computed(() => this.catalog.apis().reduce((n, a) => n + a.endpoints.length, 0));

  visible() {
    const f = this.filter.toLowerCase();
    return [...this.catalog.apis()]
      .filter((a) => !f || [a.name, a.category, a.owner].join(' ').toLowerCase().includes(f))
      .sort((a, b) => (this.sortBy() === 'nota' ? this.scores()[a.id] - this.scores()[b.id] : 0) || a.name.localeCompare(b.name));
  }

  count(status: string) {
    return this.catalog.apis().filter((a) => a.status === status).length;
  }

  // ----- export -----
  private transfer = inject(TransferService);
  exporting = signal(false);
  picked = signal(new Set<string>());
  exportRecipes = true;
  exportBusy = signal(false);
  exportMessage = signal('');
  exportError = signal(false);
  sortedApis = computed(() => [...this.catalog.apis()].sort((a, b) => a.name.localeCompare(b.name)));

  openExport() {
    this.pickAll(true);
    this.exportMessage.set('');
    this.exporting.set(true);
  }

  pickAll(on: boolean) {
    this.picked.set(new Set(on ? this.catalog.apis().map((a) => a.id) : []));
  }

  togglePick(id: string) {
    const next = new Set(this.picked());
    if (!next.delete(id)) next.add(id);
    this.picked.set(next);
  }

  async runExport(to: 'file' | 'copy') {
    this.exportBusy.set(true);
    this.exportMessage.set('');
    try {
      const all = this.picked().size === this.catalog.apis().length;
      const bundle = await this.transfer.export(all ? null : [...this.picked()], this.exportRecipes);
      const text = JSON.stringify(bundle, null, 2);
      const what = `${bundle.apis.length} API(s)` + (bundle.recipes.length ? ` e ${bundle.recipes.length} ReceAPIto(s)` : '');
      if (to === 'file') {
        downloadText(text, `catalogo-apis-${new Date().toISOString().slice(0, 10)}.json`);
        this.exportMessage.set(`Arquivo gerado com ${what}.`);
      } else {
        await navigator.clipboard.writeText(text);
        this.exportMessage.set(`Copiado: ${what}. No outro catálogo, cole em Importar.`);
      }
      this.exportError.set(false);
    } catch (e) {
      this.exportError.set(true);
      this.exportMessage.set(e instanceof Error && e.name === 'NotAllowedError' ? 'O navegador bloqueou a cópia. Use Baixar arquivo.' : errorMessage(e));
    } finally {
      this.exportBusy.set(false);
    }
  }

  ngOnInit() {
    this.catalog.refresh();
    this.specSync.all().then((s) => this.sync.set(s), () => {});
    if (this.auth.isAdmin()) this.access.requests('pending').then((r) => this.pendingRequests.set(r.length), () => {});
    this.access.groups().then((g) => this.groupsById.set(Object.fromEntries(g.map((x) => [x.id, x.name]))), () => {});
    this.recipeService.list().then((r) => this.recipes.set(r), () => {});
    firstValueFrom(this.http.get<{ resolved: boolean }[]>('/api/ai/gaps')).then((g) => this.openGaps.set(g.filter((x) => !x.resolved).length), () => {});
    this.catalog.drafts().then((d) => this.drafts.set(d), () => {});
    firstValueFrom(this.http.get<Record<string, number>>('/api/subscriptions/counts')).then((c) => this.followers.set(c), () => {});
  }

  async confirmDelete(a: Api) {
    this.deleting.set(true);
    try {
      await this.catalog.remove(a.id);
      this.isError.set(false);
      this.message.set(`“${a.name}” foi excluída.`);
    } catch (e) {
      this.isError.set(true);
      this.message.set(errorMessage(e));
    } finally {
      this.deleting.set(false);
      this.toDelete.set(null);
    }
  }
}

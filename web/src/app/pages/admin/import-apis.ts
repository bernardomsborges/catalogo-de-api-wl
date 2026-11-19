import { Component, computed, inject, signal, WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CatalogService, errorMessage } from '../../core/catalog.service';
import { PlanAction, PlanRow, TransferPlan, TransferResult, TransferService } from '../../core/transfer.service';

const LABEL: Record<PlanAction, string> = { create: 'Nova', update: 'Será atualizada', same: 'Sem mudanças', invalid: 'Com erro' };
const RESULT: Record<TransferResult['action'], string> = { created: 'Criada', updated: 'Atualizada', unchanged: 'Sem mudanças', error: 'Erro' };

/** /admin/importar: brings APIs exported from another catalog (e.g. homologação → produção). */
@Component({
  selector: 'app-import-apis',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="container page">
      <div>
        <a routerLink="/admin" class="small">← Voltar ao painel</a>
        <h1>Importar APIs</h1>
        <p class="muted">Traga as APIs exportadas de outro catálogo, por exemplo da homologação. Elas são reconhecidas pelo identificador (o fim do endereço, como <code>/apis/workflows</code>): as que já existem aqui são atualizadas, e as outras são criadas. Antes de gravar, você vê o que vai mudar.</p>
      </div>

      @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }

      @if (results(); as rs) {
        <div class="card section">
          <h2>Importação concluída</h2>
          <p class="muted">{{ summary(rs) }}</p>
          <ul class="results">
            @for (r of rs; track r.kind + r.slug) {
              <li>
                <span class="tag" [class.t-ok]="r.action === 'created' || r.action === 'updated'" [class.t-err]="r.action === 'error'">{{ resultLabel(r) }}</span>
                {{ kindLabel(r.kind) }} <strong>{{ r.name }}</strong>
                @if (r.message) { <div class="small err">{{ r.message }}</div> }
              </li>
            }
          </ul>
          <p class="small muted">Cada API atualizada ganhou uma versão nova no histórico, com a nota "Importada". Para desfazer, restaure a versão anterior em Editar → Histórico.</p>
          <div class="row">
            <a class="btn btn-primary" routerLink="/admin">Ir para o painel</a>
            <button class="btn" type="button" (click)="reset()">Importar outro arquivo</button>
          </div>
        </div>
      } @else if (plan(); as p) {
        <div class="card section">
          <div class="row">
            <h2>O que vai mudar</h2>
            <span class="spacer"></span>
            <button class="btn btn-sm btn-ghost" type="button" (click)="reset()">Trocar arquivo</button>
          </div>
          @if (p.source || p.exportedAt) {
            <p class="small muted">Exportado@if (p.source) { de <strong>{{ p.source }}</strong>}@if (p.exportedAt) { em {{ date(p.exportedAt) }}}.</p>
          }

          <h3>APIs <span class="muted small">({{ chosenApis().size }} de {{ p.apis.length }} marcadas)</span></h3>
          <ul class="rows">
            @for (a of p.apis; track a.slug + $index) {
              <li [class.off]="!selectable(a)">
                <label>
                  <input type="checkbox" [disabled]="!selectable(a)" [checked]="chosenApis().has(a.slug)" (change)="toggle(chosenApis, a.slug)" />
                  <span class="tag" [class]="'a-' + a.action">{{ label(a.action) }}</span>
                  <strong>{{ a.name }}</strong> <code class="small muted">{{ a.slug }}</code>
                </label>
                @for (m of a.errors; track m) { <div class="small err">{{ m }}</div> }
                @for (m of a.warnings; track m) { <div class="small warn">⚠ {{ m }}</div> }
                @if (a.missingGroups?.length) { <div class="small warn">⚠ Grupo(s) que não existem aqui: {{ a.missingGroups!.join(', ') }}</div> }
              </li>
            } @empty {
              <li class="muted small">O arquivo não tem APIs.</li>
            }
          </ul>

          @if (p.recipes.length) {
            <h3>ReceAPItos <span class="muted small">({{ chosenRecipes().size }} de {{ p.recipes.length }} marcados)</span></h3>
            <ul class="rows">
              @for (r of p.recipes; track r.slug + $index) {
                <li [class.off]="!selectable(r)">
                  <label>
                    <input type="checkbox" [disabled]="!selectable(r)" [checked]="chosenRecipes().has(r.slug)" (change)="toggle(chosenRecipes, r.slug)" />
                    <span class="tag" [class]="'a-' + r.action">{{ label(r.action, true) }}</span>
                    <strong>{{ r.name }}</strong>
                  </label>
                  @for (m of r.errors; track m) { <div class="small err">{{ m }}</div> }
                  @if (missingFor(r); as miss) { <div class="small err">Usa API(s) que não estão marcadas e não existem aqui: {{ miss }}. Marque-as ou o ReceAPIto não será importado.</div> }
                </li>
              }
            </ul>
          }

          @if (groupsNeeded().length) {
            @if (p.canCreateGroups) {
              <label class="alert alert-warn groups">
                <input type="checkbox" [(ngModel)]="createGroups" />
                <span>Criar os grupos que faltam: <strong>{{ groupsNeeded().join(', ') }}</strong>. Depois, coloque as pessoas neles em Pessoas e acesso. Sem eles, essas APIs privadas ficam visíveis só para administradores e editores.</span>
              </label>
            } @else {
              <div class="alert alert-warn">Os grupos <strong>{{ groupsNeeded().join(', ') }}</strong> não existem aqui, e só administradores podem criá-los. Até alguém criar, as APIs privadas que dependem deles ficam visíveis só para administradores e editores.</div>
            }
          }

          @if (hasUpdates()) {
            <p class="small muted">As APIs atualizadas ganham uma versão nova no histórico, então dá para desfazer. Quem acompanha essas APIs recebe e-mail se houver uma novidade nova ou se a API for marcada como depreciada.</p>
          }
          <div class="row">
            <button class="btn btn-primary" type="button" (click)="run()" [disabled]="busy() || !total()">{{ busy() ? 'Importando…' : 'Importar ' + total() + (total() === 1 ? ' item' : ' itens') }}</button>
          </div>
        </div>
      } @else {
        <div class="card section">
          <div class="field">
            <label for="arquivo">Arquivo exportado (.json)</label>
            <input id="arquivo" type="file" accept=".json,application/json" (change)="readFile($event)" />
          </div>
          <div class="field">
            <label for="colar">Ou cole aqui o conteúdo copiado</label>
            <textarea id="colar" class="code" rows="10" [(ngModel)]="text" placeholder='{ "format": "catalogo-de-apis", ... }'></textarea>
          </div>
          <div class="row">
            <button class="btn btn-primary" type="button" (click)="check()" [disabled]="busy() || !text.trim()">{{ busy() ? 'Lendo…' : 'Ver o que vai mudar' }}</button>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); display: flex; flex-direction: column; gap: 20px; max-width: 860px; }
    h1 { margin: 4px 0 8px; }
    .section { padding: 20px 22px; display: flex; flex-direction: column; gap: 14px; }
    .section h2, .section h3, .section p { margin: 0; }
    h3 { font-size: 1rem; margin-top: 6px !important; }
    .rows, .results { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); }
    .rows li, .results li { padding: 10px 14px; border-top: 1px solid var(--border); }
    .rows li:first-child, .results li:first-child { border-top: 0; }
    .rows label { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; cursor: pointer; }
    .rows li.off label { cursor: default; }
    .rows li.off strong { color: var(--text-2); }
    .a-create, .t-ok { background: var(--ok-soft); color: var(--ok); }
    .a-update { background: var(--brand-soft); color: var(--brand); }
    .a-invalid, .t-err { background: var(--danger-soft); color: var(--danger); }
    .err { color: var(--danger); margin: 4px 0 0 26px; }
    .warn { color: var(--warn); margin: 4px 0 0 26px; }
    .results .err { margin-left: 0; }
    .groups { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
    .groups input { margin-top: 3px; }
  `,
})
export class ImportApis {
  private transfer = inject(TransferService);
  private catalog = inject(CatalogService);

  text = '';
  private bundle: unknown = null;
  plan = signal<TransferPlan | null>(null);
  results = signal<TransferResult[] | null>(null);
  chosenApis = signal(new Set<string>());
  chosenRecipes = signal(new Set<string>());
  createGroups = true;
  busy = signal(false);
  error = signal('');

  total = computed(() => this.chosenApis().size + this.chosenRecipes().size);
  hasUpdates = computed(() => (this.plan()?.apis || []).some((a) => a.action === 'update' && this.chosenApis().has(a.slug)));
  /** Missing groups used by the chosen private APIs. */
  groupsNeeded = computed(() => {
    const p = this.plan();
    if (!p) return [];
    const names = p.apis.filter((a) => this.chosenApis().has(a.slug)).flatMap((a) => a.missingGroups || []);
    return [...new Set(names)];
  });

  label(a: PlanAction, recipe = false) {
    return recipe && a === 'create' ? 'Novo' : recipe && a === 'update' ? 'Será atualizado' : LABEL[a];
  }
  resultLabel(r: TransferResult) {
    if (r.kind !== 'api' && r.action === 'created') return 'Criado';
    if (r.kind !== 'api' && r.action === 'updated') return 'Atualizado';
    return RESULT[r.action];
  }
  kindLabel(kind: TransferResult['kind']) {
    return kind === 'api' ? 'API' : kind === 'recipe' ? 'ReceAPIto' : 'Grupo';
  }
  date(iso: string) {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }
  selectable(r: PlanRow) {
    return r.action === 'create' || r.action === 'update';
  }
  missingFor(r: PlanRow) {
    if (!this.chosenRecipes().has(r.slug)) return '';
    return (r.needsApis || []).filter((s) => !this.chosenApis().has(s)).join(', ');
  }
  toggle(set: WritableSignal<Set<string>>, slug: string) {
    const next = new Set(set());
    if (!next.delete(slug)) next.add(slug);
    set.set(next);
  }

  async readFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.text = await file.text();
    await this.check();
  }

  async check() {
    this.error.set('');
    let bundle: unknown;
    try {
      bundle = JSON.parse(this.text);
    } catch {
      this.error.set('O conteúdo não é um JSON válido. Copie de novo no outro catálogo, ou use o arquivo baixado.');
      return;
    }
    this.busy.set(true);
    try {
      const plan = await this.transfer.preview(bundle);
      this.bundle = bundle;
      this.plan.set(plan);
      this.chosenApis.set(new Set(plan.apis.filter((a) => this.selectable(a)).map((a) => a.slug)));
      this.chosenRecipes.set(new Set(plan.recipes.filter((r) => this.selectable(r)).map((r) => r.slug)));
      this.createGroups = true;
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async run() {
    this.busy.set(true);
    this.error.set('');
    try {
      const { results } = await this.transfer.import(this.bundle, {
        apis: [...this.chosenApis()],
        recipes: [...this.chosenRecipes()],
        createGroups: this.createGroups,
      });
      this.results.set(results);
      this.catalog.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  summary(rs: TransferResult[]) {
    const n = (k: TransferResult['action']) => rs.filter((r) => r.action === k).length;
    const parts = [
      n('created') && `${n('created')} criado(s)`,
      n('updated') && `${n('updated')} atualizado(s)`,
      n('unchanged') && `${n('unchanged')} sem mudanças`,
      n('error') && `${n('error')} com erro`,
    ].filter(Boolean);
    return parts.join(' · ') || 'Nada foi importado.';
  }

  reset() {
    this.text = '';
    this.bundle = null;
    this.plan.set(null);
    this.results.set(null);
    this.error.set('');
  }
}

import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CatalogService, errorMessage } from '../../core/catalog.service';
import { RecipeService } from '../../core/recipe.service';
import { analyze, Recipe } from '../../core/recipes';

/** /admin/receapitos */
@Component({
  selector: 'app-recipe-admin-list',
  imports: [RouterLink],
  template: `
    <div class="container page">
      <div class="row head">
        <div>
          <a routerLink="/admin" class="small">← Voltar ao painel</a>
          <h1>ReceAPItos</h1>
        </div>
        <span class="spacer"></span>
        <a class="btn btn-primary" routerLink="/admin/receapitos/novo">+ Novo ReceAPIto</a>
      </div>
      @if (message()) { <div class="alert" [class.alert-ok]="!isError()" [class.alert-error]="isError()" role="status">{{ message() }}</div> }
      <div class="card table-wrap">
        <table class="table">
          <thead><tr><th>ReceAPIto</th><th>Passos</th><th>APIs</th><th class="right">Ações</th></tr></thead>
          <tbody>
            @for (r of rows(); track r.recipe.id) {
              <tr>
                <td>
                  <strong>{{ r.recipe.title }}</strong>
                  @if (r.missing) { <span class="tag warn">⚠ {{ r.missing }} rota(s) removida(s)</span> }
                  <div class="small muted">{{ r.recipe.goal }}</div>
                </td>
                <td>{{ r.recipe.steps.length }}</td>
                <td class="small">{{ r.apis }}</td>
                <td class="right actions">
                  <a class="btn btn-sm btn-ghost" [routerLink]="['/receapitos', r.recipe.slug]">Ver</a>
                  <a class="btn btn-sm" [routerLink]="['/admin/receapitos/editar', r.recipe.id]">Editar</a>
                  <button class="btn btn-sm btn-danger" type="button" (click)="remove(r.recipe)">Excluir</button>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="empty">Nenhum ReceAPIto ainda.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); display: flex; flex-direction: column; gap: 18px; }
    .head h1 { margin: 4px 0 0; }
    .right { text-align: right; }
    .actions { white-space: nowrap; }
    .actions .btn { margin-left: 4px; }
    .warn { background: var(--warn-soft); color: var(--warn); margin-left: 6px; }
  `,
})
export class RecipeAdminList implements OnInit {
  private service = inject(RecipeService);
  private catalog = inject(CatalogService);
  recipes = signal<Recipe[]>([]);
  message = signal(history.state?.message ?? '');
  isError = signal(false);

  rows = computed(() =>
    this.recipes().map((recipe) => {
      const a = analyze(recipe, this.catalog.apis());
      return { recipe, missing: a.missingCount, apis: a.apis.map((x) => x.name).join(', ') || '—' };
    })
  );

  async ngOnInit() {
    this.catalog.refresh();
    this.recipes.set(await this.service.list().catch(() => []));
  }

  async remove(r: Recipe) {
    if (!confirm(`Excluir o ReceAPIto “${r.title}”?`)) return;
    try {
      await this.service.remove(r.id);
      this.recipes.update((list) => list.filter((x) => x.id !== r.id));
      this.isError.set(false);
      this.message.set(`“${r.title}” foi excluída.`);
    } catch (e) {
      this.isError.set(true);
      this.message.set(errorMessage(e));
    }
  }
}

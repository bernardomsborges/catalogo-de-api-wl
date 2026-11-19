import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CatalogService } from '../../core/catalog.service';
import { RecipeService } from '../../core/recipe.service';
import { analyze, Recipe } from '../../core/recipes';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** /receapitos: every recipe, with search and an API filter (both kept in the URL). */
@Component({
  selector: 'app-recipes-list',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="container page">
      <header class="head">
        <h1>ReceAPItos</h1>
        <p class="muted">Tarefas reais feitas com várias rotas, passo a passo, com o código completo em cURL, Python e Go.</p>
      </header>
      <div class="toolbar">
        <label class="sr-only" for="rq">Buscar ReceAPItos</label>
        <input id="rq" [ngModel]="query()" (ngModelChange)="setQuery($event)" placeholder="Buscar ReceAPItos…" autocomplete="off" />
        <label class="sr-only" for="rapi">Filtrar por API</label>
        <select id="rapi" [ngModel]="apiFilter()" (ngModelChange)="setApi($event)">
          <option value="">Todas as APIs</option>
          @for (a of usedApis(); track a.id) { <option [value]="a.slug">{{ a.name }}</option> }
        </select>
      </div>
      @if (error()) {
        <div class="alert alert-error">{{ error() }}</div>
      }
      <p class="small muted">{{ filtered().length }} de {{ recipes().length }} ReceAPItos</p>
      <div class="grid">
        @for (r of filtered(); track r.recipe.id) {
          <a class="card recipe" [routerLink]="['/receapitos', r.recipe.slug]">
            <h2>{{ r.recipe.title }}</h2>
            <p class="muted">{{ r.recipe.goal }}</p>
            <div class="meta small">
              <span class="tag">{{ r.recipe.steps.length }} passos</span>
              @for (a of r.apis; track a.id) { <span class="tag">{{ a.name }}</span> }
              @if (r.missing) { <span class="tag warn">⚠ rota removida</span> }
            </div>
          </a>
        } @empty {
          @if (!loading()) { <p class="muted">Nenhum ReceAPIto encontrado.</p> }
        }
      </div>
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); display: flex; flex-direction: column; gap: 14px; }
    .head h1 { margin: 0; }
    .head p { margin: 4px 0 0; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; }
    .toolbar input { flex: 1 1 260px; }
    .toolbar select { flex: 0 1 280px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
    .recipe { padding: 18px; display: flex; flex-direction: column; gap: 8px; color: inherit; text-decoration: none; }
    .recipe:hover { border-color: var(--brand); }
    .recipe h2 { margin: 0; font-size: 1.05rem; }
    .recipe p { margin: 0; }
    .meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; }
    .warn { background: var(--warn-soft); color: var(--warn); }
  `,
})
export class RecipesList implements OnInit {
  private service = inject(RecipeService);
  private catalog = inject(CatalogService);
  private router = inject(Router);
  /** Query params. */
  q = input<string>();
  api = input<string>();

  recipes = signal<Recipe[]>([]);
  loading = signal(true);
  error = signal('');
  query = signal('');
  apiFilter = signal('');

  private enriched = computed(() =>
    this.recipes().map((recipe) => {
      const a = analyze(recipe, this.catalog.apis());
      return { recipe, apis: a.apis, missing: a.missingCount > 0 };
    })
  );
  usedApis = computed(() => {
    const seen = new Map<string, { id: string; slug: string; name: string }>();
    for (const r of this.enriched()) for (const a of r.apis) seen.set(a.id, a);
    return [...seen.values()].sort((x, y) => x.name.localeCompare(y.name));
  });
  filtered = computed(() => {
    const q = norm(this.query());
    const api = this.apiFilter();
    return this.enriched().filter(
      (r) =>
        (!api || r.apis.some((a) => a.slug === api)) &&
        (!q || norm([r.recipe.title, r.recipe.goal, ...r.recipe.tags, ...r.apis.map((a) => a.name)].join(' ')).includes(q))
    );
  });

  async ngOnInit() {
    this.query.set(this.q() ?? '');
    this.apiFilter.set(this.api() ?? '');
    this.catalog.refresh();
    try {
      this.recipes.set(await this.service.list());
    } catch {
      this.error.set('Não foi possível carregar os ReceAPItos.');
    } finally {
      this.loading.set(false);
    }
  }

  setQuery(v: string) {
    this.query.set(v);
    this.syncUrl();
  }

  setApi(v: string) {
    this.apiFilter.set(v);
    this.syncUrl();
  }

  private syncUrl() {
    this.router.navigate([], { queryParams: { q: this.query() || null, api: this.apiFilter() || null }, replaceUrl: true });
  }
}

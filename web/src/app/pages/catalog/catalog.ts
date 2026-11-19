import { Component, computed, effect, inject, input, OnInit, signal, WritableSignal } from '@angular/core';
import { BrandService } from '../../core/brand';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CatalogService } from '../../core/catalog.service';
import { MetricsService } from '../../core/metrics.service';
import { matchApi } from '../../core/catalog-search';
import { apiAuthTypes, ApiStatus, AUTH_LABELS, AuthType, STATUS_LABELS } from '../../core/models';
import { ApiCard } from '../../shared/api-card';


@Component({
  selector: 'app-catalog',
  imports: [FormsModule, ApiCard],
  template: `
    <div class="container page">
      <header class="head">
        <h1>APIs</h1>
        <p class="muted">Todas as APIs disponíveis para integração@if (brand.brand.org) { com {{ brand.brand.org }} }.</p>
      </header>

      <div class="layout">
        <aside id="catalog-filters" class="filters" [class.open]="filtersOpen()" aria-label="Filtros">
          <div class="filter-group">
            <span class="label">Categoria</span>
            @for (c of categories(); track c) {
              <label class="check"><input type="checkbox" [checked]="selCategories().has(c)" (change)="toggle(selCategories, c)" /> {{ c }}</label>
            }
          </div>
          <div class="filter-group">
            <span class="label">Status</span>
            @for (s of statuses; track s) {
              <label class="check"><input type="checkbox" [checked]="selStatus().has(s)" (change)="toggle(selStatus, s)" /> {{ statusLabels[s] }}</label>
            }
          </div>
          <div class="filter-group">
            <span class="label">Autenticação</span>
            @for (t of authTypes(); track t) {
              <label class="check"><input type="checkbox" [checked]="selAuth().has(t)" (change)="toggle(selAuth, t)" /> {{ authLabels[t] }}</label>
            }
          </div>
          @if (hasLocked()) {
            <div class="filter-group">
              <span class="label">Acesso</span>
              <label class="check"><input type="checkbox" [checked]="selAccess().has('open')" (change)="toggle(selAccess, 'open')" /> Liberadas para você</label>
              <label class="check"><input type="checkbox" [checked]="selAccess().has('locked')" (change)="toggle(selAccess, 'locked')" /> Precisa pedir acesso</label>
            </div>
          }
          @if (hasFilters()) {
            <button class="btn btn-sm" type="button" (click)="clear()">Limpar filtros</button>
          }
        </aside>

        <section>
          <div class="toolbar">
            <label class="sr-only" for="q">Buscar</label>
            <input id="q" [ngModel]="query()" (ngModelChange)="setQuery($event)" placeholder="Buscar APIs…" autocomplete="off" />
            <button class="btn filters-toggle" type="button" aria-controls="catalog-filters" [attr.aria-expanded]="filtersOpen()" (click)="filtersOpen.set(!filtersOpen())">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M4 6h16M7 12h10M10 18h4" />
              </svg>
              Filtros
              @if (activeCount()) { <span class="badge-n">{{ activeCount() }}</span> }
              <svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <label class="sr-only" for="sort">Ordenar</label>
            <select id="sort" [ngModel]="sort()" (ngModelChange)="sort.set($event)">
              <option value="name">Nome (A–Z)</option>
              <option value="updated">Atualização mais recente</option>
            </select>
          </div>
          <div class="count small muted">
            <span>{{ filtered().length }} de {{ catalog.apis().length }} APIs</span>
            @if (hasLocked()) {
              <div class="access" role="group" aria-label="Mostrar APIs por acesso">
                <button type="button" [attr.aria-pressed]="accessMode() === 'all'" (click)="setAccess('all')">
                  Todas <span class="n">{{ catalog.apis().length }}</span>
                </button>
                <button type="button" [attr.aria-pressed]="accessMode() === 'open'" (click)="setAccess('open')"
                        title="APIs públicas e as privadas que você já pode abrir.">
                  Liberadas para você <span class="n">{{ catalog.apis().length - lockedCount() }}</span>
                </button>
                <button type="button" class="restricted" [attr.aria-pressed]="accessMode() === 'locked'" (click)="setAccess('locked')"
                        title="APIs privadas que você ainda não pode abrir. Abra o card para pedir acesso.">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                  Precisa pedir acesso <span class="n">{{ lockedCount() }}</span>
                </button>
              </div>
            }
          </div>

          @if (catalog.error()) {
            <div class="alert alert-error">{{ catalog.error() }}</div>
          } @else {
            <h2 class="sr-only">Resultados</h2>
            <div class="grid">
              @for (a of filtered(); track a.id) {
                <app-api-card [api]="a" [routes]="matches().get(a.id)?.routes ?? []" />
              } @empty {
                <div class="empty card">Nenhuma API encontrada com esses filtros.</div>
              }
            </div>
          }
        </section>
      </div>
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); }
    .head p { margin-top: 0; }
    .layout { display: grid; grid-template-columns: 220px 1fr; gap: 32px; margin-top: 24px; }
    .filters { display: flex; flex-direction: column; gap: 22px; position: sticky; top: 100px; align-self: start; }
    .filter-group { display: flex; flex-direction: column; gap: 6px; }
    .filter-group .label { margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.72rem; color: var(--text-3); }
    .check { display: flex; gap: 8px; align-items: center; font-size: 0.9rem; cursor: pointer; color: var(--text-2); }
    .toolbar { display: flex; gap: 10px; }
    /* Only on small screens: the filters fold behind this button. */
    .filters-toggle { display: none; align-items: center; justify-content: center; gap: 8px; }
    .filters-toggle .chev { transition: transform 0.15s; }
    .filters-toggle[aria-expanded='true'] .chev { transform: rotate(180deg); }
    .badge-n { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; display: inline-grid; place-items: center; background: var(--brand); color: var(--on-brand); font-size: 0.72rem; font-weight: 700; }
    .toolbar select { width: auto; }
    .count { margin: 10px 0 14px; display: flex; justify-content: space-between; align-items: center; gap: 6px 16px; flex-wrap: wrap; }
    /* Three-way switch next to the count: every API, the ones the person can open, the ones they must ask for. */
    .access { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); }
    .access button { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; border: 1px solid transparent; background: none; font: inherit; font-size: 0.8rem; font-weight: 600; color: var(--text-2); cursor: pointer; white-space: nowrap; }
    .access button:hover { color: var(--text); }
    .access button[aria-pressed='true'] { background: var(--surface); color: var(--text); border-color: var(--border-strong); box-shadow: var(--shadow); }
    /* Dashed like a restricted card (api-card.ts), so the switch doubles as the legend. */
    .access .restricted { border: 1px dashed var(--border-strong); }
    .access .restricted[aria-pressed='true'] { border-style: dashed; border-color: var(--text-3); }
    .n { font-weight: 500; color: var(--text-3); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 16px; }
    .empty { grid-column: 1 / -1; }
    @media (max-width: 820px) {
      /* One column: search and the "Filtros" button first, the folded filters right below, then the list. */
      .layout { grid-template-columns: 1fr; gap: 0; }
      .layout > section { display: contents; }
      .toolbar { order: 1; flex-wrap: wrap; }
      .toolbar input { flex: 1 1 100%; }
      .toolbar select, .filters-toggle { flex: 1 1 0; min-width: 0; width: auto; }
      .filters-toggle { display: inline-flex; }
      .filters { order: 2; display: none; position: static; margin-top: 10px; padding: 16px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
      .filters.open { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 18px 24px; }
      .filters .btn { grid-column: 1 / -1; justify-self: start; }
      .count { order: 3; }
      .access { border-radius: 18px; }
      .layout > section > .alert, .grid { order: 4; }
    }
  `,
})
export class Catalog implements OnInit {
  catalog = inject(CatalogService);
  brand = inject(BrandService);
  private router = inject(Router);
  private metrics = inject(MetricsService);
  private lastSearch = '';

  /** Bound from the URL (?q=…&categoria=…) so filtered views can be shared. */
  q = input<string>();
  categoria = input<string>();

  statuses = Object.keys(STATUS_LABELS) as ApiStatus[];
  statusLabels = STATUS_LABELS;
  authLabels = AUTH_LABELS;

  query = signal('');
  sort = signal<'name' | 'updated'>('name');
  selCategories = signal(new Set<string>());
  selStatus = signal(new Set<ApiStatus>());
  selAuth = signal(new Set<AuthType>());
  /** "locked": private APIs the person can't open; "open": everything else. */
  selAccess = signal(new Set<'open' | 'locked'>());

  constructor() {
    effect(() => this.query.set(this.q() ?? ''));
    effect(() => {
      const c = this.categoria();
      this.selCategories.set(new Set(c ? [c] : []));
    });
    // Usage metrics: a search counts once the text stops changing, with how many APIs it found.
    effect((onCleanup) => {
      const q = this.query().trim();
      if (q.length < 2 || !this.catalog.apis().length) return;
      const timer = setTimeout(() => {
        if (q === this.lastSearch) return;
        this.lastSearch = q;
        this.metrics.search(q, this.filtered().length);
      }, 1500);
      onCleanup(() => clearTimeout(timer));
    });
  }

  categories = computed(() => [...new Set(this.catalog.apis().map((a) => a.category))].sort());
  authTypes = computed(() => [...new Set(this.catalog.apis().flatMap((a) => apiAuthTypes(a)))]);
  /** The access filter and the legend only show when there is something restricted to tell apart. */
  lockedCount = computed(() => this.catalog.apis().filter((a) => a.locked).length);
  hasLocked = computed(() => this.lockedCount() > 0);
  /** Small screens: whether the folded filters are showing. */
  filtersOpen = signal(false);
  /** How many filter boxes are ticked (shown on the "Filtros" button while it is folded). */
  activeCount = computed(() => this.selCategories().size + this.selStatus().size + this.selAuth().size + this.selAccess().size);
  hasFilters = computed(() => !!(this.selCategories().size || this.selStatus().size || this.selAuth().size || this.selAccess().size || this.query()));

  /** How each API matched the search: the routes that matched, when it was by them (PRO-206). */
  matches = computed(() => {
    const q = this.query().trim();
    return new Map(this.catalog.apis().map((a) => [a.id, q ? matchApi(a, q) : { routes: [] }]));
  });

  filtered = computed(() => {
    const matches = this.matches();
    const cats = this.selCategories();
    const sts = this.selStatus();
    const auths = this.selAuth();
    const access = this.selAccess();
    const list = this.catalog.apis().filter((a) => {
      if (cats.size && !cats.has(a.category)) return false;
      if (sts.size && !sts.has(a.status)) return false;
      if (auths.size && !apiAuthTypes(a).some((t) => auths.has(t))) return false;
      if (access.size && !access.has(a.locked ? 'locked' : 'open')) return false;
      return !!matches.get(a.id);
    });
    // APIs the person can't open always come after the ones they can.
    const byName = this.sort() === 'name';
    return list.sort(
      (a, b) => Number(!!a.locked) - Number(!!b.locked) || (byName ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt))
    );
  });

  ngOnInit() {
    this.catalog.refresh();
  }

  setQuery(value: string) {
    this.query.set(value);
    this.router.navigate([], { queryParams: { q: value || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  toggle<T>(sel: WritableSignal<Set<T>>, value: T) {
    sel.update((s) => {
      const next = new Set(s);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  }

  /** The switch next to the count shows the access filter as one choice out of three. */
  accessMode = computed<'all' | 'open' | 'locked'>(() => {
    const sel = this.selAccess();
    return sel.size === 1 ? [...sel][0] : 'all';
  });

  setAccess(mode: 'all' | 'open' | 'locked') {
    this.selAccess.set(new Set(mode === 'all' ? [] : [mode]));
  }

  clear() {
    this.selCategories.set(new Set());
    this.selStatus.set(new Set());
    this.selAuth.set(new Set());
    this.selAccess.set(new Set());
    this.query.set('');
    this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }
}

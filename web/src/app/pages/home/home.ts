import { Component, computed, ElementRef, HostListener, inject, OnInit, viewChild } from '@angular/core';
import { AskService } from '../../core/ask.service';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CatalogService } from '../../core/catalog.service';
import { ApiCard } from '../../shared/api-card';

type Icon = 'braces' | 'bell' | 'lock' | 'doc' | 'flow' | 'terminal' | 'chart' | 'search' | 'book' | 'shield' | null;

/** Decorative tile grid (5 x 4). The brand tile spans 2 x 2 at columns 3-4, rows 1-2. */
const TILES: Icon[] = [
  'braces', null, /* brand */ null,
  null, 'bell', 'lock',
  null, 'doc', null, 'chart', 'flow',
  'terminal', null, null, null, null,
];
const COLS = 5;
const ROWS = 4;

@Component({
  selector: 'app-home',
  imports: [FormsModule, RouterLink, ApiCard, NgTemplateOutlet],
  template: `
    <section class="hero">
      <div class="container hero-grid">
        <div class="hero-text">
          <span class="eyebrow">Portal do desenvolvedor</span>
          <h1>Integre-se ao Automatiza.MG <span class="dim">com APIs bem documentadas</span></h1>
          <p class="lead">Encontre a API certa, entenda como ela funciona e faça sua primeira chamada em minutos — com guias, exemplos de código em 7 linguagens e console de testes.</p>
          <div class="stats">
            <div><strong>{{ catalog.apis().length }}</strong><span>APIs</span></div>
            <div><strong>{{ endpointCount() }}</strong><span>endpoints</span></div>
            <div><strong>{{ categories().length }}</strong><span>categorias</span></div>
          </div>
        </div>

        <div class="tiles" aria-hidden="true">
          @for (t of tiles.slice(0, 2); track $index) {
            <span class="tile" [class.lit]="t" [style.--i]="$index"><ng-container *ngTemplateOutlet="icon; context: { $implicit: t }" /></span>
          }
          <span class="tile tile-brand">
            <span class="tile-label">AUTOMATIZA.MG</span>
            <span class="brand-mark brand-symbol tile-symbol"></span>
          </span>
          @for (t of tiles.slice(2); track $index) {
            <span class="tile" [class.lit]="t" [style.--i]="$index + 3"><ng-container *ngTemplateOutlet="icon; context: { $implicit: t }" /></span>
          }
          @for (k of ticks; track $index) {
            <span class="tick" [class.tick-hot]="k.hot" [style.left]="k.left" [style.top]="k.top"></span>
          }
        </div>
      </div>

      <div class="container search-wrap">
        <form class="search" (ngSubmit)="search()" role="search">
          <svg class="search-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
          <label class="sr-only" for="busca">Buscar APIs</label>
          <input #busca id="busca" name="q" [(ngModel)]="q" placeholder="Buscar por nome, assunto ou tag… ex.: notificações" autocomplete="off" />
          <button class="search-btn" type="submit">Buscar <span aria-hidden="true">→</span></button>
        </form>
        <button type="button" class="ask-btn" (click)="askAi()">✨ Ou descreva o que precisa e pergunte ao assistente</button>
        @if (categories().length) {
          <div class="chips">
            <span class="chips-label">Populares:</span>
            @for (c of categories().slice(0, 5); track c.name) {
              <a class="chip" [routerLink]="['/apis']" [queryParams]="{ categoria: c.name }">{{ c.name }}</a>
            }
          </div>
        }
      </div>
    </section>

    <section class="container section">
      <div class="section-head">
        <h2 class="big">Quatro passos até a produção. <span class="dim">Cada etapa tem guias e ferramentas prontos.</span></h2>
        <a class="pill" routerLink="/apis">Explorar o catálogo</a>
      </div>
      <div class="steps">
        @for (s of steps; track s.title; let i = $index) {
          <article class="step">
            <span class="step-label">{{ s.label }}</span>
            <div class="step-head">
              <span class="step-icon"><ng-container *ngTemplateOutlet="icon; context: { $implicit: s.icon }" /></span>
              <div><h3>{{ s.title }}</h3><span class="step-num">Passo {{ i + 1 }}</span></div>
            </div>
            <p>{{ s.text }}</p>
          </article>
        }
      </div>
    </section>

    @if (categories().length) {
      <section class="container section">
        <h2>Categorias</h2>
        <div class="cats">
          @for (c of categories(); track c.name) {
            <a class="card cat" [routerLink]="['/apis']" [queryParams]="{ categoria: c.name }">
              <strong>{{ c.name }}</strong>
              <span class="muted small">{{ c.count }} API{{ c.count === 1 ? '' : 's' }}</span>
            </a>
          }
        </div>
      </section>
    }

    <section class="container section">
      <div class="row"><h2>Atualizadas recentemente</h2><span class="spacer"></span><a routerLink="/apis">Ver todas →</a></div>
      @if (catalog.error()) {
        <div class="alert alert-error">{{ catalog.error() }}</div>
      } @else if (catalog.loading() && !catalog.apis().length) {
        <p class="muted">Carregando…</p>
      } @else {
        <div class="grid">
          @for (a of recent(); track a.id) {
            <app-api-card [api]="a" />
          } @empty {
            <div class="empty card">Nenhuma API cadastrada ainda.</div>
          }
        </div>
      }
    </section>

    <ng-template #icon let-name>
      @if (name) {
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
          @switch (name) {
            @case ('braces') { <path d="M8 4C6 4 5 5 5 7v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3" /> }
            @case ('bell') { <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21a2 2 0 0 0 4 0" /> }
            @case ('lock') { <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /> }
            @case ('doc') { <path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /> }
            @case ('flow') { <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5" /> }
            @case ('terminal') { <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9l3 3-3 3M13 15h4" /> }
            @case ('chart') { <path d="M5 20v-7M12 20V5M19 20v-10" /> }
            @case ('search') { <circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /> }
            @case ('book') { <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5V5.5M20 18v3H6.5" /> }
            @case ('shield') { <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /> }
          }
        </svg>
      }
    </ng-template>
  `,
  styles: `
    /* ---------- Hero ---------- */
    .hero {
      position: relative; overflow: hidden;
      background: radial-gradient(1100px 460px at 15% -10%, var(--hero-glow), transparent), var(--surface);
      border-bottom: 1px solid var(--border);
      padding: calc(var(--header-space) + 56px) 0 56px;
    }
    .hero-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 56px; align-items: center; }
    .eyebrow { font-family: var(--mono); font-size: 0.82rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); }
    h1 { font-size: clamp(2rem, 3.6vw, 2.75rem); line-height: 1.08; letter-spacing: -0.03em; margin: 14px 0 18px; }
    .dim { display: block; color: var(--text-3); }
    .lead { font-size: 1.08rem; line-height: 1.7; color: var(--text-2); max-width: 560px; margin: 0; }
    .stats { display: flex; gap: 0; margin-top: 32px; }
    .stats div { display: flex; flex-direction: column; padding: 0 28px; border-left: 1px solid var(--border); }
    .stats div:first-child { padding-left: 0; border-left: 0; }
    .stats strong { font-size: 1.7rem; letter-spacing: -0.02em; }
    .stats span { color: var(--text-3); font-size: 0.85rem; }

    /* Tile grid */
    .tiles {
      --gap: 8px;
      position: relative; display: grid; gap: var(--gap);
      grid-template-columns: repeat(5, 1fr); grid-template-rows: repeat(4, 1fr);
      aspect-ratio: 5 / 4; width: 100%; max-width: 560px; justify-self: end;
    }
    .tile {
      display: grid; place-items: center; border-radius: 4px; background: var(--surface-2); color: var(--text-3);
      animation: tile-in 0.5s ease both; animation-delay: calc(var(--i, 0) * 35ms);
    }
    .tile .ico { width: 42%; height: 42%; opacity: 0.85; }
    .tile.lit { animation: tile-in 0.5s ease both, tile-glow 7s ease-in-out infinite; animation-delay: calc(var(--i, 0) * 35ms), calc(var(--i, 0) * 0.9s + 1s); }
    .tile-brand {
      grid-column: 3 / span 2; grid-row: 1 / span 2; position: relative; border-radius: 4px;
      background: linear-gradient(135deg, var(--grad-stops)); background-size: 200% 200%;
      color: var(--on-grad); animation: brand-shift 10s ease-in-out infinite;
    }
    .tile-label {
      position: absolute; top: 8px; left: 8px; padding: 3px 7px; border-radius: 3px;
      font-family: var(--mono); font-size: 0.68rem; font-weight: 600; letter-spacing: 0.05em;
      background: rgba(0, 0, 0, 0.72); color: #fff;
    }
    .tile-symbol { width: 40%; }
    .tick {
      position: absolute; width: 7px; height: 7px; transform: translate(-50%, -50%); pointer-events: none;
      background: repeating-linear-gradient(135deg, var(--text-3) 0 1px, transparent 1px 3px); opacity: 0.6;
    }
    .tick-hot { background: repeating-linear-gradient(135deg, var(--accent) 0 1px, transparent 1px 3px); opacity: 1; }
    .ico { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }

    @keyframes tile-in { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: none; } }
    @keyframes tile-glow { 0%, 12%, 100% { color: var(--text-3); background: var(--surface-2); } 5% { color: var(--brand); background: var(--brand-soft); } }
    @keyframes brand-shift { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
    @media (prefers-reduced-motion: reduce) { .tile, .tile.lit, .tile-brand { animation: none; } }

    /* Search */
    .search-wrap { display: flex; flex-direction: column; align-items: center; margin-top: 56px; }
    .ask-btn { margin-top: 12px; background: none; border: 0; color: var(--brand); font: inherit; font-weight: 600; cursor: pointer; padding: 6px 10px; border-radius: 8px; }
    .ask-btn:hover { background: var(--brand-soft); }
    .search {
      display: flex; align-items: center; gap: 10px; width: 100%; max-width: 760px; height: 64px;
      padding: 0 8px 0 22px; border-radius: 999px; background: var(--bg);
      border: 1px solid var(--border-strong);
      box-shadow: 0 0 0 6px var(--brand-soft), 0 24px 48px -24px var(--brand);
      transition: box-shadow 0.2s, border-color 0.2s;
    }
    .search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 6px var(--brand-soft), 0 0 0 1px var(--brand), 0 28px 56px -22px var(--brand); }
    .search-ico { width: 22px; height: 22px; flex-shrink: 0; fill: none; stroke: var(--text-3); stroke-width: 2.2; stroke-linecap: round; }
    .search input { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; box-shadow: none; padding: 0; font-size: 1.05rem; color: var(--text); outline: none; }
    .search input:focus { box-shadow: none; border: 0; }
    .search-btn {
      height: 48px; padding: 0 26px; border: 0; border-radius: 999px; cursor: pointer; flex-shrink: 0;
      font: inherit; font-weight: 700; color: var(--on-grad);
      background: linear-gradient(90deg, var(--grad-stops)); background-size: 160% 100%; background-position: 0 0;
      transition: transform 0.15s, background-position 0.4s ease;
    }
    .search-btn:hover { transform: scale(1.03); background-position: 100% 0; }
    .chips { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 8px; margin-top: 18px; }
    .chips-label { font-size: 0.85rem; color: var(--text-3); }
    .chip { font-size: 0.85rem; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); text-decoration: none !important; transition: border-color 0.15s, color 0.15s; }
    .chip:hover { border-color: var(--brand); color: var(--brand); }

    /* ---------- Steps ---------- */
    .section { margin-top: 56px; }
    .section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
    .big { font-size: clamp(1.6rem, 2.8vw, 2.2rem); line-height: 1.12; letter-spacing: -0.03em; max-width: 720px; margin: 0; }
    .pill {
      display: inline-flex; align-items: center; height: 48px; padding: 0 24px; border-radius: 999px; flex-shrink: 0;
      background: var(--text); color: var(--bg); font-weight: 700; font-size: 0.92rem; text-decoration: none !important;
      transition: transform 0.15s;
    }
    .pill:hover { transform: scale(1.04); }
    .steps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .step {
      display: flex; flex-direction: column; min-height: 250px; padding: 28px; border-radius: 22px;
      background: var(--surface); border: 1px solid var(--border);
      transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
    }
    .step:hover { transform: translateY(-3px); border-color: var(--border-strong); box-shadow: var(--shadow-lg); }
    .step-label { font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
    .step-head { display: flex; align-items: center; gap: 18px; margin-top: 26px; }
    .step-icon {
      display: grid; place-items: center; width: 64px; height: 64px; border-radius: 16px; flex-shrink: 0;
      background: linear-gradient(135deg, var(--grad-stops)); color: var(--on-grad);
    }
    .step-icon .ico { width: 30px; height: 30px; stroke-width: 2.4; }
    .step h3 { margin: 0; font-size: 1.25rem; letter-spacing: -0.02em; }
    .step-num { color: var(--text-3); font-size: 0.95rem; }
    .step p { margin: auto 0 0; padding-top: 28px; color: var(--text-2); }

    .cats { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .cat { padding: 16px 18px; display: flex; flex-direction: column; color: var(--text); text-decoration: none !important; }
    .cat:hover { border-color: var(--brand); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }

    @media (max-width: 900px) {
      .hero-grid { grid-template-columns: minmax(0, 1fr); gap: 40px; }
      .tiles { justify-self: center; max-width: 480px; }
    }
    @media (max-width: 700px) {
      .steps { grid-template-columns: minmax(0, 1fr); }
      .section-head { flex-direction: column; align-items: flex-start; }
      .step { min-height: 0; }
    }
    @media (max-width: 560px) {
      .hero { padding: calc(var(--header-space) + 36px) 0 40px; }
      .search { height: 56px; padding-left: 16px; }
      .search-btn { height: 42px; padding: 0 16px; }
      .stats div { padding: 0 18px; }
      .search-wrap { margin-top: 36px; }
      .tiles { display: none; }
    }
  `,
})
export class Home implements OnInit {
  private askService = inject(AskService);

  /** Opens the assistant with what was typed in the search box. */
  askAi() {
    this.askService.show({ question: (this.q || '').trim().length >= 3 ? this.q : '', api: null });
  }

  catalog = inject(CatalogService);
  private router = inject(Router);
  private searchInput = viewChild<ElementRef<HTMLInputElement>>('busca');
  q = '';

  readonly tiles = TILES;
  /** Hatched marks at every gap crossing, like a blueprint. Skips the one hidden under the brand tile. */
  readonly ticks = (() => {
    const out: { left: string; top: string; hot: boolean }[] = [];
    for (let x = 0; x <= COLS; x++) {
      for (let y = 0; y <= ROWS; y++) {
        if (x === 3 && y === 1) continue;
        out.push({
          left: `calc((100% + var(--gap)) * ${x} / ${COLS} - var(--gap) / 2)`,
          top: `calc((100% + var(--gap)) * ${y} / ${ROWS} - var(--gap) / 2)`,
          hot: (x === 2 || x === 4) && (y === 0 || y === 2),
        });
      }
    }
    return out;
  })();

  readonly steps: { label: string; title: string; icon: Icon; text: string }[] = [
    { label: 'Descoberta', title: 'Descubra', icon: 'search', text: 'Navegue pelo catálogo, filtre por categoria e veja o status e o dono de cada API.' },
    { label: 'Documentação', title: 'Entenda', icon: 'book', text: 'Siga o início rápido e os guias gerados para cada API, com exemplos prontos em 7 linguagens.' },
    { label: 'Testes', title: 'Teste', icon: 'terminal', text: 'Faça chamadas pelo console direto na documentação, em modo real ou simulado.' },
    { label: 'Produção', title: 'Integre', icon: 'shield', text: 'Use o checklist de produção e o guia de erros para colocar sua integração no ar com segurança.' },
  ];

  endpointCount = computed(() => this.catalog.apis().reduce((n, a) => n + a.endpoints.length, 0));
  categories = computed(() => {
    const counts = new Map<string, number>();
    this.catalog.apis().forEach((a) => counts.set(a.category, (counts.get(a.category) ?? 0) + 1));
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  });
  /** Latest updates first, but APIs the person can't open go after the ones they can. */
  recent = computed(() =>
    [...this.catalog.apis()].sort((a, b) => Number(!!a.locked) - Number(!!b.locked) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6)
  );

  ngOnInit() {
    this.catalog.refresh();
  }

  /** "/" focuses the search, unless the user is already typing somewhere. */
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (e.key !== '/' || t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    e.preventDefault();
    this.searchInput()?.nativeElement.focus();
  }

  search() {
    this.router.navigate(['/apis'], { queryParams: this.q.trim() ? { q: this.q.trim() } : {} });
  }
}

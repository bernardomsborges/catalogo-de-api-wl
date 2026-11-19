import { afterNextRender, Component, computed, DestroyRef, effect, ElementRef, inject, Injector, input, signal, untracked, viewChild } from '@angular/core';
import { BrandService } from '../../core/brand';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { CatalogService } from '../../core/catalog.service';
import { RecipeService } from '../../core/recipe.service';
import { Recipe } from '../../core/recipes';
import { COMPLETE_SCORE, docQuality } from '../../../../../shared/doc-quality';
import { buildGuides } from '../../core/guides';
import { Api, apiSchemes, defaultSchemes, extraSchemes, AUTH_LABELS, AuthScheme, authSummary, Endpoint, endpointSchemes, LOCATION_LABELS, SCHEME_LABELS, schemeWire } from '../../core/models';
import { exportOpenApi } from '../../core/openapi';
import { generateSnippets } from '../../core/snippets';
import { MarkdownPipe } from '../../shared/markdown.pipe';
import { CodeTabs, MethodBadge, StatusBadge } from '../../shared/ui';
import { HealthBadge } from '../../shared/health-badge';
import { StatusService } from '../../core/status.service';
import { DownloadCollection } from './download-collection';
import { LockedApi } from './locked-api';
import { AuthService } from '../../core/auth';
import { FollowApi } from './follow-api';
import { AskService } from '../../core/ask.service';
import { ToastService } from '../../shared/toast';
import { TryIt } from './try-it';
import { MetricsService } from '../../core/metrics.service';
import { endpointAnchor } from '../../core/catalog-search';
import { Consumer } from '../../core/systems';
import { SystemsService } from '../../core/systems.service';

@Component({
  selector: 'app-api-detail',
  imports: [RouterLink, MarkdownPipe, CodeTabs, MethodBadge, StatusBadge, TryIt, FollowApi, HealthBadge, DownloadCollection, LockedApi],
  templateUrl: './api-detail.html',
  styleUrl: './api-detail.scss',
})
export class ApiDetail {
  private catalog = inject(CatalogService);
  private toast = inject(ToastService);
  private titleService = inject(Title);
  private brand = inject(BrandService);
  private injector = inject(Injector);
  private fragment = toSignal(inject(ActivatedRoute).fragment);

  slug = input.required<string>();
  tab = input<string>();
  /** ?testar=<endpoint anchor>: opens that endpoint's console (links from recipes). */
  testar = input<string>();
  private recipeService = inject(RecipeService);
  private askService = inject(AskService);
  private metrics = inject(MetricsService);
  private systemsService = inject(SystemsService);
  /** Systems that use this API (PRO-166); null = not shown (logged out, or the API is locked). */
  consumers = signal<Consumer[] | null>(null);
  canManageSystems = computed(() => this.auth.isStaff());
  private auth = inject(AuthService);
  private status = inject(StatusService);
  /** The health pill only shows for APIs that have a health check. */
  monitored = computed(() => {
    const a = this.api();
    return !!a && !!this.status.byApi().get(a.id)?.monitored;
  });
  /** Recipes that use this API. */
  recipes = signal<Recipe[]>([]);
  /** Documentation score (PRO-164): the portal shows "Documentação completa" from 90 up. */
  quality = computed(() => {
    const a = this.api();
    return a ? docQuality(a, { recipes: this.recipes().length }).score : 0;
  });
  completeScore = COMPLETE_SCORE;

  api = signal<Api | null>(null);
  notFound = signal(false);
  openTry = signal<Set<string>>(new Set());
  menuOpen = signal(false);
  private navOpenGroups = signal<Set<string>>(new Set());
  /** Endpoint currently on screen in the reference (scroll spy), or null above the first one. */
  activeEp = signal<string | null>(null);
  private sidenav = viewChild<ElementRef<HTMLElement>>('sidenav');
  /** While a clicked link smooth-scrolls, keep it highlighted instead of flashing the ones in between. */
  private lockedUntil = 0;
  /** When the user last scrolled the side menu by hand; auto-follow waits a bit after that. */
  private navTouchedAt = 0;
  authLabels = AUTH_LABELS;
  schemeLabels = SCHEME_LABELS;
  locationLabels = LOCATION_LABELS;
  schemes = computed(() => {
    const a = this.api();
    return a ? defaultSchemes(a) : [];
  });
  extraSchemes = computed(() => {
    const a = this.api();
    return a ? extraSchemes(a) : [];
  });
  hasAuth = computed(() => {
    const a = this.api();
    return !!a && apiSchemes(a).length > 0;
  });
  authText = computed(() => {
    const a = this.api();
    return a ? authSummary(a) : '';
  });

  guides = computed(() => {
    const a = this.api();
    return a ? buildGuides(a) : [];
  });
  current = computed(() => this.tab() || 'visao-geral');
  /** Deprecated API (PRO-205): switch-off day with the days left, and the API that replaces it. */
  sunset = computed(() => {
    const day = this.api()?.sunsetDate;
    if (!day) return null;
    const [y, m, d] = day.split('-').map(Number);
    const now = new Date();
    const daysLeft = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
    return { label: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`, daysLeft };
  });
  replacement = computed(() => {
    const id = this.api()?.replacedBy;
    return id ? this.catalog.apis().find((a) => a.id === id) ?? null : null;
  });
  currentGuide = computed(() => this.guides().find((g) => g.id === this.current()));
  snippets = computed(() => {
    const a = this.api();
    const map = new Map<Endpoint, ReturnType<typeof generateSnippets>>();
    a?.endpoints.forEach((ep) => map.set(ep, generateSnippets(a, ep)));
    return map;
  });
  endpointGroups = computed(() => {
    const a = this.api();
    if (!a) return [];

    const groups = new Map<string, Endpoint[]>();
    for (const ep of a.endpoints) {
      const name = this.endpointGroupName(ep);
      const endpoints = groups.get(name) ?? [];
      endpoints.push(ep);
      groups.set(name, endpoints);
    }

    // Follow the order declared in OpenAPI, then append undeclared tags in endpoint order.
    const names = [...new Set([...a.tags.map((tag) => tag.trim()).filter(Boolean), ...groups.keys()])].filter((name) => groups.has(name));
    return names.map((name) => ({ name, endpoints: groups.get(name)! }));
  });

  constructor() {
    effect(() => {
      const slug = this.slug();
      // Logging in or out (or getting a new group) changes what the page may show.
      this.auth.account();
      this.api.set(null);
      this.askService.pageApi.set(null);
      this.navOpenGroups.set(new Set());
      this.activeEp.set(null);
      this.notFound.set(false);
      this.catalog
        .get(slug)
        .then((a) => {
          this.api.set(a);
          this.metrics.view(a.id);
          this.consumers.set(null);
          if (this.auth.current() && !a.locked) this.systemsService.consumersOf(a.id).then((c) => this.consumers.set(c), () => this.consumers.set(null));
          this.status.refresh();
          // The assistant button opens focused on the API being read.
          this.askService.pageApi.set(a.locked ? null : { slug: a.slug, name: a.name });
          this.titleService.setTitle(this.brand.title(a.name));
          this.recipeService.list({ api: a.id }).then((r) => this.recipes.set(r), () => this.recipes.set([]));
        })
        .catch(() => this.notFound.set(true));
    });
    effect(() => {
      const key = this.testar();
      if (this.api() && key) untracked(() => this.openTry.update((s) => new Set(s).add(key)));
    });
    // Usage metrics: each guide opened.
    effect(() => {
      const a = this.api();
      const g = this.currentGuide();
      if (a && g) untracked(() => this.metrics.view(a.id, { guide: g.id }));
    });
    // Close the mobile menu after navigating.
    effect(() => {
      this.current();
      this.menuOpen.set(false);
    });
    // Scroll to #fragment only after the target section has rendered.
    effect(() => {
      const api = this.api();
      const ready = api && this.current();
      const fragment = this.fragment();
      if (ready && fragment) {
        untracked(() => {
          const endpoint = api.endpoints.find((ep) => this.epAnchor(ep) === fragment);
          if (endpoint) {
            this.openNavGroupForEndpoint(endpoint);
            if (endpoint.id) this.metrics.view(api.id, { endpoint: endpoint.id });
          }
        });
        afterNextRender(() => this.scrollToAnchor(fragment, 'instant'), { injector: this.injector });
      }
    });

    // Scroll spy: highlight in the side menu the endpoint being read.
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), this.updateActiveEp(), this.fitSidenav()));
    };
    const unlock = () => ((this.lockedUntil = 0), this.updateActiveEp());
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    window.addEventListener('scrollend', unlock);
    inject(DestroyRef).onDestroy(() => {
      this.askService.pageApi.set(null);
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scrollend', unlock);
    });
    effect(() => {
      this.api();
      this.current();
      afterNextRender(() => (this.updateActiveEp(), this.fitSidenav(), this.revealActive('instant')), { injector: this.injector });
    });
    // Keep the highlighted link visible inside the side menu (without moving the page).
    effect(() => {
      this.activeEp();
      untracked(() => this.revealActive('smooth'));
    });
    // The menu scrolls on its own; note when the user does it, and update the edge fades.
    effect((onCleanup) => {
      const nav = this.sidenav()?.nativeElement;
      if (!nav) return;
      const touched = () => (this.navTouchedAt = Date.now());
      const fades = () => this.updateFades(nav);
      nav.addEventListener('wheel', touched, { passive: true });
      nav.addEventListener('touchmove', touched, { passive: true });
      nav.addEventListener('pointerdown', touched, { passive: true });
      nav.addEventListener('scroll', fades, { passive: true });
      fades();
      onCleanup(() => {
        nav.removeEventListener('wheel', touched);
        nav.removeEventListener('touchmove', touched);
        nav.removeEventListener('pointerdown', touched);
        nav.removeEventListener('scroll', fades);
      });
    });
  }

  /**
   * Centers the highlighted endpoint inside the side menu (scrolling the menu, not the page).
   * Skipped for a few seconds after the user scrolled the menu by hand, so it doesn't fight them.
   */
  private revealActive(behavior: ScrollBehavior) {
    const id = this.activeEp();
    const nav = this.sidenav()?.nativeElement;
    const link = id && nav?.querySelector<HTMLElement>(`[data-ep="${id}"]`);
    if (!nav || !link || nav.scrollHeight <= nav.clientHeight) return;
    if (Date.now() - this.navTouchedAt < 2500) return;
    const offset = link.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
    nav.scrollTo({ top: offset - nav.clientHeight / 2 + link.offsetHeight / 2, behavior });
  }

  /**
   * The menu is sticky with its own scroll. Near the end of the page the footer would push it
   * off screen, so it shrinks to the space left above the end of the docs instead.
   */
  private fitSidenav() {
    const nav = this.sidenav()?.nativeElement;
    if (!nav) return;
    if (window.innerWidth <= 820) return void (nav.style.maxHeight = '');
    const top = 100;
    const docsBottom = nav.parentElement!.getBoundingClientRect().bottom;
    const available = Math.min(window.innerHeight - top - 16, docsBottom - top);
    const next = `${Math.max(Math.floor(available), 160)}px`;
    if (nav.style.maxHeight !== next) {
      nav.style.maxHeight = next;
      this.updateFades(nav);
    }
  }

  /** Fades the top/bottom edge of the menu when there is more to scroll that way. */
  private updateFades(nav: HTMLElement) {
    nav.classList.toggle('more-above', nav.scrollTop > 2);
    nav.classList.toggle('more-below', nav.scrollTop + nav.clientHeight < nav.scrollHeight - 2);
  }

  private updateActiveEp() {
    if (this.current() !== 'referencia') return this.activeEp.set(null);
    if (Date.now() < this.lockedUntil) return;
    const sections = document.querySelectorAll<HTMLElement>('article.endpoint');
    // The section whose top has passed a line just below the header is the one being read.
    const line = 140;
    let active: string | null = null;
    for (const el of Array.from(sections)) {
      if (el.getBoundingClientRect().top <= line) active = el.id;
      else break;
    }
    this.activeEp.set(active);
    const endpoint = active && this.api()?.endpoints.find((ep) => this.epAnchor(ep) === active);
    if (endpoint) this.openNavGroupForEndpoint(endpoint);
  }

  private scrollToAnchor(id: string, behavior: ScrollBehavior = 'smooth') {
    document.getElementById(id)?.scrollIntoView({ behavior, block: 'start' });
  }

  /** Handles clicks on a link to the anchor we're already on (the router ignores those). */
  goToEndpoint(ep: Endpoint) {
    this.activeEp.set(this.epAnchor(ep));
    this.openNavGroupForEndpoint(ep);
    this.lockedUntil = Date.now() + 1200;
    if (this.current() === 'referencia') this.scrollToAnchor(this.epAnchor(ep));
  }

  isGroupOpen(name: string) {
    return this.navOpenGroups().has(name);
  }

  toggleGroup(name: string) {
    this.navOpenGroups.update((open) => {
      const next = new Set(open);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  private endpointGroupName(ep: Endpoint) {
    return ep.tag?.trim() || 'Outros';
  }

  private openNavGroupForEndpoint(ep: Endpoint) {
    const name = this.endpointGroupName(ep);
    this.navOpenGroups.update((open) => open.has(name) ? open : new Set(open).add(name));
  }

  securityOf(ep: Endpoint) {
    return endpointSchemes(this.api()!, ep);
  }

  wire(s: AuthScheme) {
    return schemeWire(s);
  }

  epAnchor(ep: Endpoint) {
    return endpointAnchor(ep);
  }

  responseSnippet(body: string, status: number) {
    return [{ lang: 'json', label: `Resposta ${status}`, code: body }];
  }

  toggleTry(key: string) {
    this.openTry.update((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  downloadOpenApi() {
    const a = this.api();
    if (!a) return;
    const blob = new Blob([JSON.stringify(exportOpenApi(a), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${a.slug}-openapi.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async copy(text: string) {
    await this.toast.copy(text, 'URL copiada');
  }
}

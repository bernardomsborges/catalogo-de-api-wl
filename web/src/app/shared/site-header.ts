import { Component, computed, ElementRef, HostListener, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AskService } from '../core/ask.service';
import { filter } from 'rxjs';
import { CatalogService } from '../core/catalog.service';
import { ThemeMode, ThemeService } from '../core/theme';
import { AuthService } from '../core/auth';

type Menu = 'apis' | 'novidades' | 'tema' | 'conta' | 'mobile';

/** Floating dark top bar with dropdown menus, in the style of Spotify's Backstage site. */
@Component({
  selector: 'app-site-header',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './site-header.html',
  styleUrl: './site-header.scss',
})
export class SiteHeader implements OnInit {
  askService = inject(AskService);
  private host = inject(ElementRef<HTMLElement>);
  private router = inject(Router);
  catalog = inject(CatalogService);
  theme = inject(ThemeService);
  auth = inject(AuthService);

  initials(name: string) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
  }
  firstName(name: string) {
    return name.trim().split(/\s+/)[0];
  }
  /** Where to come back after logging in (not the login pages themselves). */
  currentUrl() {
    const u = this.router.url;
    return u.startsWith('/entrar') || u.startsWith('/cadastro') || u === '/' ? null : u;
  }
  logout() {
    this.open.set(null);
    this.auth.logout();
  }

  open = signal<Menu | null>(null);
  /** After scrolling down, the bar collapses to just the CTA + menu button (Backstage-style). */
  scrolled = signal(false);
  private closeTimer?: ReturnType<typeof setTimeout>;

  themeOptions: { mode: ThemeMode; label: string }[] = [
    { mode: 'light', label: 'Claro' },
    { mode: 'dark', label: 'Escuro' },
    { mode: 'system', label: 'Sistema' },
  ];
  themeLabel = computed(() => this.themeOptions.find((o) => o.mode === this.theme.mode())!.label);

  apis = computed(() => [...this.catalog.apis()].sort((a, b) => a.name.localeCompare(b.name)));
  categories = computed(() => {
    const counts = new Map<string, number>();
    this.catalog.apis().forEach((a) => counts.set(a.category, (counts.get(a.category) ?? 0) + 1));
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  });
  /** Latest changelog entries across every API. */
  news = computed(() =>
    this.catalog
      .apis()
      .flatMap((a) => a.changelog.map((c) => ({ ...c, api: a.name, slug: a.slug })))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5)
  );

  constructor() {
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => this.open.set(null));
  }

  ngOnInit() {
    if (!this.catalog.apis().length) this.catalog.refresh();
  }

  toggle(menu: Menu) {
    clearTimeout(this.closeTimer);
    // A click that lands right after hover opened the menu should keep it open, not close it.
    const justHovered = this.open() === menu && Date.now() - this.hoverOpenedAt < 500;
    this.open.update((m) => (m === menu && !justHovered ? null : menu));
  }

  private hoverOpenedAt = 0;

  /** Hover opens dropdowns on devices with a mouse; touch uses click. */
  hoverOpen(menu: Menu) {
    if (!matchMedia('(hover: hover)').matches) return;
    clearTimeout(this.closeTimer);
    if (this.open() !== menu) this.hoverOpenedAt = Date.now();
    this.open.set(menu);
  }

  hoverClose() {
    if (!matchMedia('(hover: hover)').matches) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.open.set(null), 150);
  }

  /** Header search: opens the catalog filtered by what was typed (empty shows every API). */
  search(input: HTMLInputElement, e: Event) {
    e.preventDefault();
    const q = input.value.trim();
    input.value = '';
    input.blur();
    this.router.navigate(['/apis'], { queryParams: q ? { q } : {} });
  }

  setTheme(mode: ThemeMode) {
    this.theme.setMode(mode);
    this.open.set(null);
  }

  formatDate(d: string) {
    return d.split('-').reverse().join('/');
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(e: MouseEvent) {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(null);
  }

  @HostListener('window:scroll')
  onScroll() {
    const scrolled = window.scrollY > 48;
    if (scrolled === this.scrolled()) return;
    this.scrolled.set(scrolled);
    // Dropdowns belong to the full bar; close them when it collapses.
    if (scrolled && this.open() !== 'mobile') this.open.set(null);
  }

  /** Esc closes the open menu and, if the focus was in the header, puts it back on the menu's button. */
  @HostListener('document:keydown.escape')
  onEscape() {
    const menu = this.open();
    if (!menu) return;
    this.open.set(null);
    const root = this.host.nativeElement as HTMLElement;
    if (root.contains(document.activeElement)) root.querySelector<HTMLElement>(`[data-menu="${menu}"]`)?.focus();
  }

  /** Tabbing out of a dropdown closes it, so it doesn't stay open over the page. */
  focusLeft(e: FocusEvent, menu: Menu) {
    const next = e.relatedTarget as Node | null;
    if (this.open() === menu && next && !(e.currentTarget as HTMLElement).contains(next)) this.open.set(null);
  }
}

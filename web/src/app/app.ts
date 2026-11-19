import { ViewportScroller } from '@angular/common';
import { afterNextRender, Component, inject } from '@angular/core';
import { Event, NavigationCancel, NavigationEnd, NavigationError, Router, RouterOutlet } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import { CatalogService } from './core/catalog.service';
import { SiteFooter } from './shared/site-footer';
import { SiteHeader } from './shared/site-header';
import { AskPanel } from './shared/ask-panel';
import { Toast } from './shared/toast';

const SPLASH_MAX_MS = 5000;

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SiteHeader, SiteFooter, AskPanel, Toast],
  template: `
    <a class="sr-only" href="#conteudo">Pular para o conteúdo</a>
    <app-site-header />
    <main id="conteudo">
      <router-outlet />
    </main>
    <app-site-footer />
    <app-ask-panel />
    <app-toast />
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 100vh; }
    main { flex: 1; }
  `,
})
export class App {
  private router = inject(Router);
  private catalog = inject(CatalogService);

  constructor() {
    // Anchor scrolling must leave room for the floating header (12px gap + 64px bar).
    inject(ViewportScroller).setOffset([0, 96]);
    afterNextRender(() => this.hideSplashWhenReady());
  }

  /**
   * The splash in index.html covers the page until the web font, the first route
   * and the first catalog load are ready, so nothing shows half-styled.
   */
  private async hideSplashWhenReady() {
    const firstRoute = firstValueFrom(
      this.router.events.pipe(
        filter((e: Event) => e instanceof NavigationEnd || e instanceof NavigationCancel || e instanceof NavigationError)
      )
    );
    const ready = Promise.all([document.fonts?.ready, firstRoute, this.catalog.firstLoad]);
    await Promise.race([ready, new Promise((r) => setTimeout(r, SPLASH_MAX_MS))]);
    // Let the page paint once with real content before fading out.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('splash-done');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  }
}

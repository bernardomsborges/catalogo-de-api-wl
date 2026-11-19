import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CatalogService } from '../core/catalog.service';
import { BrandService } from '../core/brand';
import { BrandLogo } from './brand-logo';

/** Dark footer (matches the header bar), with the portal's brand (whitelabel, see core/brand.ts). */
@Component({
  selector: 'app-site-footer',
  imports: [RouterLink, BrandLogo],
  template: `
    <footer class="foot">
      <div class="top">
        <div class="about">
          <app-brand-logo class="logo" [size]="30" />
          <p>{{ brand.brand.description }}</p>
        </div>
        <nav class="cols" aria-label="Rodapé">
          <div class="col">
            <span class="col-title">Explorar</span>
            <a routerLink="/">Início</a>
            <a routerLink="/apis">Todas as APIs</a>
          </div>
          @if (categories().length) {
            <div class="col">
              <span class="col-title">Categorias</span>
              @for (c of categories(); track c) {
                <a [routerLink]="['/apis']" [queryParams]="{ categoria: c }">{{ c }}</a>
              }
            </div>
          }
        </nav>
      </div>
      <div class="bottom">
        @if (brand.brand.org) { <span class="by">Publicado por {{ brand.brand.org }}</span> } @else { <span></span> }
        <span class="copy">© {{ year }} {{ brand.brand.org || brand.brand.name }}</span>
      </div>
    </footer>
  `,
  styles: `
    :host { display: block; padding: 0 16px 16px; max-width: 1440px; margin: 64px auto 0; width: 100%; }
    .foot {
      background: #18181b; color: #ffffff; border-radius: 24px; padding: 40px 40px 28px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    :host-context([data-theme='dark']) .foot { background: #141416; border-color: #27272a; }
    @media (prefers-color-scheme: dark) { :host-context(html:not([data-theme='light'])) .foot { background: #141416; border-color: #27272a; } }
    .foot { position: relative; overflow: hidden; }
    .top { display: flex; gap: 48px; justify-content: space-between; flex-wrap: wrap; padding-bottom: 32px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
    .about { max-width: 380px; }
    .logo { color: #ffffff; }
    .about p { color: #a1a1aa; font-size: 0.9rem; margin: 16px 0 0; }
    .cols { display: flex; gap: 56px; flex-wrap: wrap; }
    .col { display: flex; flex-direction: column; gap: 8px; min-width: 140px; }
    .col-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a1a1aa; margin-bottom: 4px; }
    .col a { color: #ffffff; font-size: 0.9rem; font-weight: 600; text-decoration: none; }
    .col a:hover { text-decoration: underline; }
    .bottom { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding-top: 24px; }
    .by { font-size: 0.75rem; color: #a1a1aa; }
    .copy { font-size: 0.82rem; color: #a1a1aa; }
    @media (max-width: 560px) {
      :host { padding: 0 8px 8px; }
      .foot { padding: 28px 22px 22px; border-radius: 20px; }
      .top { gap: 28px; }
    }
  `,
})
export class SiteFooter {
  private catalog = inject(CatalogService);
  brand = inject(BrandService);
  year = new Date().getFullYear();
  categories = computed(() => [...new Set(this.catalog.apis().map((a) => a.category))].sort().slice(0, 5));
}

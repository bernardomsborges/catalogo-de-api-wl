import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CatalogService } from '../core/catalog.service';

/**
 * Dark footer (matches the header bar). The brand files are white, so they are
 * used as plain <img> here: dark surface in both themes keeps contrast high.
 */
@Component({
  selector: 'app-site-footer',
  imports: [RouterLink],
  template: `
    <footer class="foot">
      <div class="top">
        <div class="about">
          <img src="brand/logo.webp" alt="Automatiza.MG" class="logo" width="164" height="33" />
          <p>O catálogo oficial de APIs do Automatiza.MG. Encontre, teste e integre serviços com documentação padronizada.</p>
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
        <div class="office">
          <span class="by">Uma iniciativa do</span>
          <img src="brand/logo-escritorio.png" alt="Escritório Central de Inovação e Automatização" class="office-logo" width="176" height="48" />
        </div>
        <span class="copy">© {{ year }} Automatiza.MG</span>
      </div>
    </footer>
  `,
  styles: `
    :host { display: block; padding: 0 16px 16px; max-width: 1440px; margin: 64px auto 0; width: 100%; }
    .foot {
      background: #00183b; color: #ffffff; border-radius: 24px; padding: 40px 40px 28px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    :host-context([data-theme='dark']) .foot { background: #04204a; }
    @media (prefers-color-scheme: dark) { :host-context(html:not([data-theme='light'])) .foot { background: #04204a; } }
    /* Thin brand gradient along the top edge. */
    .foot { position: relative; overflow: hidden; }
    .foot::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: linear-gradient(90deg, #00183b, #59a1ba, #6a4d9f); }
    .top { display: flex; gap: 48px; justify-content: space-between; flex-wrap: wrap; padding-bottom: 32px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
    .about { max-width: 380px; }
    .logo { height: 32px; width: auto; display: block; }
    .about p { color: #a9b8cf; font-size: 0.9rem; margin: 16px 0 0; }
    .cols { display: flex; gap: 56px; flex-wrap: wrap; }
    .col { display: flex; flex-direction: column; gap: 8px; min-width: 140px; }
    .col-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a9b8cf; margin-bottom: 4px; }
    .col a { color: #ffffff; font-size: 0.9rem; font-weight: 600; text-decoration: none; }
    .col a:hover { text-decoration: underline; }
    .bottom { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding-top: 24px; }
    .office { display: flex; flex-direction: column; gap: 10px; }
    .by { font-size: 0.75rem; color: #a9b8cf; }
    .office-logo { height: 48px; width: auto; display: block; }
    .copy { font-size: 0.82rem; color: #a9b8cf; }
    @media (max-width: 560px) {
      :host { padding: 0 8px 8px; }
      .foot { padding: 28px 22px 22px; border-radius: 20px; }
      .top { gap: 28px; }
      .office-logo { height: 42px; }
    }
  `,
})
export class SiteFooter {
  private catalog = inject(CatalogService);
  year = new Date().getFullYear();
  categories = computed(() => [...new Set(this.catalog.apis().map((a) => a.category))].sort().slice(0, 5));
}

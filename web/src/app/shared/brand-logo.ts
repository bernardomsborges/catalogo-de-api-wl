import { Component, inject, input } from '@angular/core';
import { BrandService } from '../core/brand';

/**
 * The portal's logo (whitelabel): the organization's image when LOGO_URL is set; otherwise a neutral
 * symbol next to the portal's name. Takes the text color of where it sits (light or dark surfaces).
 */
@Component({
  selector: 'app-brand-logo',
  template: `
    @let b = brand.brand;
    @if (b.logoUrl) {
      <img class="img" [src]="b.logoUrl" [alt]="b.name" [style.height.px]="size()" />
    } @else {
      <span class="mark brand-mark brand-symbol" aria-hidden="true" [style.width.px]="size()"></span>
      @if (showName()) { <span class="name" [style.font-size.px]="size() * 0.56">{{ b.name }}</span> }
    }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: 10px; min-width: 0; color: inherit; }
    .img { width: auto; display: block; max-width: 220px; object-fit: contain; }
    .name { font-weight: 700; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `,
})
export class BrandLogo {
  brand = inject(BrandService);
  /** Height in px. */
  size = input(28);
  showName = input(true);
}

import { inject, Injectable } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

/** Who the portal belongs to (whitelabel). Set on the server by PORTAL_NAME, ORG_NAME, PORTAL_DESCRIPTION and LOGO_URL. */
export interface Brand {
  name: string;
  org: string;
  description: string;
  logoUrl: string;
}

export const DEFAULT_BRAND: Brand = {
  name: 'Catálogo de APIs',
  org: '',
  description: 'Encontre, entenda e integre as APIs disponíveis.',
  logoUrl: '',
};

/** Reads the brand the server writes in index.html (<meta name="portal-brand">); defaults when absent (ng serve). */
export function readBrand(doc: Document | null = typeof document === 'undefined' ? null : document): Brand {
  const raw = doc?.querySelector('meta[name="portal-brand"]')?.getAttribute('content');
  if (!raw) return DEFAULT_BRAND;
  try {
    const b = JSON.parse(raw) as Partial<Brand>;
    return {
      name: b.name || DEFAULT_BRAND.name,
      org: b.org || '',
      description: b.description || DEFAULT_BRAND.description,
      logoUrl: b.logoUrl || '',
    };
  } catch {
    return DEFAULT_BRAND;
  }
}

@Injectable({ providedIn: 'root' })
export class BrandService {
  readonly brand = readBrand();

  /** "Página · Nome do portal", or just the portal's name. */
  title(page?: string) {
    return page ? `${page} · ${this.brand.name}` : this.brand.name;
  }
}

/** Route titles name only the page; the portal's name is added here. */
@Injectable()
export class BrandTitleStrategy extends TitleStrategy {
  private titleService = inject(Title);
  private brand = inject(BrandService);

  override updateTitle(snapshot: RouterStateSnapshot) {
    this.titleService.setTitle(this.brand.title(this.buildTitle(snapshot)));
  }
}

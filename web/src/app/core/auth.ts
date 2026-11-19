import { HttpClient, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom, tap } from 'rxjs';
import { CatalogService } from './catalog.service';

export type Role = 'admin' | 'editor' | 'consumer';

export interface Account {
  id: string;
  email: string;
  name: string;
  role: Role;
  groups: { id: string; name: string }[];
  /** False for accounts that only entered through SSO. */
  hasPassword?: boolean;
}

/** Ways of logging in the server offers (SSO and/or e-mail and password). */
export interface LoginOptions {
  password: boolean;
  sso: { label: string } | null;
}

export const ROLE_LABELS: Record<Role, string> = { admin: 'Administrador', editor: 'Editor', consumer: 'Consumidor' };

const STORAGE_KEY = 'catalogo-sessao';

interface Session {
  token: string;
  user: Account;
}

function readSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return s?.token && s?.user?.email ? s : null;
  } catch {
    return null;
  }
}

/**
 * The person using the portal. Everybody can browse; logging in shows private APIs they have access
 * to (admins and editors see all and use the admin panel).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private catalog = inject(CatalogService);
  private session = signal<Session | null>(readSession());

  readonly account = this.session.asReadonly();
  readonly current = computed(() => this.session()?.user ?? null);
  readonly user = computed(() => this.current()?.name ?? '');
  readonly isLoggedIn = computed(() => !!this.session());
  readonly isStaff = computed(() => ['admin', 'editor'].includes(this.current()?.role ?? ''));
  readonly isAdmin = computed(() => this.current()?.role === 'admin');

  /** Until the server answers, assume the password login (the usual case). */
  readonly options = signal<LoginOptions>({ password: true, sso: null });
  private optionsLoaded: Promise<void> | null = null;

  get token() {
    return this.session()?.token ?? '';
  }

  /** Asks the server once which ways of logging in exist. */
  loadOptions(): Promise<void> {
    this.optionsLoaded ??= firstValueFrom(this.http.get<LoginOptions>('/api/auth/options')).then(
      (o) => this.options.set(o),
      () => {
        this.optionsLoaded = null; // try again next time
      }
    );
    return this.optionsLoaded;
  }

  /** Where the SSO login starts (a full page navigation to the provider). */
  ssoUrl(back?: string): string {
    return `/api/auth/sso/start${back ? `?voltar=${encodeURIComponent(back)}` : ''}`;
  }

  /** Session token brought back by the SSO login: checks it and keeps it. */
  async acceptToken(token: string): Promise<void> {
    const { user } = await firstValueFrom(this.http.get<{ user: Account }>('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }));
    this.setSession({ token, user });
  }

  constructor() {
    // Role or groups may have changed since the last visit.
    if (this.token) this.refreshMe();
  }

  async login(email: string, password: string): Promise<void> {
    this.setSession(await firstValueFrom(this.http.post<Session>('/api/auth/login', { email, password })));
  }

  async register(input: { email: string; name: string; password: string }): Promise<void> {
    this.setSession(await firstValueFrom(this.http.post<Session>('/api/auth/register', input)));
  }

  /** Sends the "esqueci minha senha" link; returns the message to show (same for any e-mail). */
  async forgotPassword(email: string): Promise<string> {
    const r = await firstValueFrom(this.http.post<{ message: string }>('/api/auth/forgot', { email }));
    return r.message;
  }

  async resetPassword(token: string, password: string): Promise<void> {
    this.setSession(await firstValueFrom(this.http.post<Session>('/api/auth/reset', { token, password })));
  }

  async changePassword(current: string, next: string): Promise<void> {
    this.setSession(await firstValueFrom(this.http.post<Session>('/api/auth/password', { current, next })));
  }

  /** Ends every session of this account on every device, then forgets this one. */
  async logoutEverywhere(): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/logout-all', {}));
    this.logout(false);
    this.router.navigate(['/entrar'], { queryParams: { saiu: 'todos' } });
  }

  async refreshMe(): Promise<void> {
    try {
      const { user } = await firstValueFrom(this.http.get<{ user: Account }>('/api/auth/me'));
      const s = this.session();
      if (s && JSON.stringify(s.user) !== JSON.stringify(user)) this.setSession({ token: s.token, user });
    } catch {
      /* 401 is handled by the interceptor */
    }
  }

  logout(redirect = true): void {
    this.setSession(null);
    if (redirect) this.router.navigate(['/']);
  }

  /** Drops a session the server no longer accepts (expired, password changed, account disabled). */
  expire(): void {
    this.setSession(null);
    const url = this.router.url;
    if (url.startsWith('/admin') || url.startsWith('/conta')) this.router.navigate(['/entrar'], { queryParams: { expirou: 1, voltar: url } });
  }

  private setSession(s: Session | null) {
    const changedPerson = this.session()?.user.id !== s?.user.id || JSON.stringify(this.session()?.user.groups) !== JSON.stringify(s?.user.groups) || this.session()?.user.role !== s?.user.role;
    this.session.set(s);
    try {
      if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: session lives only in memory */
    }
    // What the catalog shows depends on who is looking.
    if (changedPerson) this.catalog.refresh();
  }
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  // A request that already brings its own token (the one just returned by SSO) keeps it.
  const authed = auth.token && req.url.startsWith('/api/') && !req.headers.has('Authorization') ? req.clone({ setHeaders: { Authorization: `Bearer ${auth.token}` } }) : req;
  return next(authed).pipe(
    tap({
      error: (err) => {
        if (err?.status === 401 && auth.isLoggedIn() && !req.url.includes('/auth/')) auth.expire();
        if (err?.status === 401 && auth.isLoggedIn() && req.url.endsWith('/auth/me')) auth.expire();
      },
    })
  );
};

const toLogin = (router: Router, url: string) => router.createUrlTree(['/entrar'], { queryParams: { voltar: url } });

/** Logged in. */
export const loginGuard: CanActivateFn = (_r, state) => {
  const auth = inject(AuthService);
  return auth.isLoggedIn() ? true : toLogin(inject(Router), state.url);
};

/** Admin panel: admins and editors. */
export const adminGuard: CanActivateFn = (_r, state) => {
  const auth = inject(AuthService);
  if (!auth.isLoggedIn()) return toLogin(inject(Router), state.url);
  return auth.isStaff() ? true : inject(Router).createUrlTree(['/conta']);
};

/** People and access: admins only. */
export const adminRoleGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAdmin() ? true : inject(Router).createUrlTree(['/admin']);
};

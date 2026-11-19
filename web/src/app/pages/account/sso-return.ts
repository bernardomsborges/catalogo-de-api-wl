import { Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth';

/**
 * /entrar/sso: where the SSO login comes back. The server puts the session token in the URL fragment
 * (#token=…&voltar=…), which never reaches a server or a log; this page keeps it and moves on.
 */
@Component({
  selector: 'app-sso-return',
  imports: [RouterLink],
  template: `
    <div class="container page">
      @if (error()) {
        <div class="alert alert-error" role="alert">{{ error() }}</div>
        <p><a routerLink="/entrar">Voltar para o login</a></p>
      } @else {
        <p class="muted" role="status">Entrando…</p>
      }
    </div>
  `,
  styles: `
    .page { max-width: 520px; padding-top: calc(var(--header-space) + 48px); }
  `,
})
export class SsoReturn implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  error = signal('');

  async ngOnInit() {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get('token');
    const back = params.get('voltar') || '';
    // Take the token out of the address bar and the history right away.
    history.replaceState(null, '', location.pathname);
    if (!token) {
      this.error.set('O login pela organização não trouxe a sessão. Tente de novo.');
      return;
    }
    try {
      await this.auth.acceptToken(token);
      const safe = back.startsWith('/') && !back.startsWith('//') ? back : this.auth.isStaff() ? '/admin' : '/';
      this.router.navigateByUrl(safe, { replaceUrl: true });
    } catch {
      this.error.set('A sessão do login pela organização não é válida. Tente de novo.');
    }
  }
}

import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { BrandLogo } from '../../shared/brand-logo';
import { BrandService } from '../../core/brand';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth';
import { CatalogService, errorMessage } from '../../core/catalog.service';

/** /entrar and /cadastro: log in or create an account. `voltar`: where to go afterwards. */
@Component({
  selector: 'app-login',
  imports: [BrandLogo, FormsModule, RouterLink],
  template: `
    <div class="wrap">
     <div class="card shell">
      <aside class="side">
        <div class="side-top">
          <span class="chip">{{ brand.brand.name }}</span>
          <span class="brand-mark brand-symbol side-symbol" aria-hidden="true"></span>
        </div>
        <div class="side-text">
          <span class="eyebrow">Portal do desenvolvedor</span>
          <h2>{{ signup() ? 'Crie sua conta e peça acesso às APIs privadas' : 'Que bom ver você de volta' }}</h2>
          <ul class="perks">
            <li>
              <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></svg>
              <span>Veja a documentação das APIs privadas liberadas para você</span>
            </li>
            <li>
              <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>
              <span>Peça acesso às que ainda estão restritas</span>
            </li>
            <li>
              <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></svg>
              <span>Acompanhe os seus pedidos em Minha conta</span>
            </li>
          </ul>
        </div>
        <div class="side-foot">
          <div class="mini" aria-hidden="true">
            @for (t of tiles; track $index) {
              <span class="mini-tile" [style.--i]="$index">
                <svg class="ico" viewBox="0 0 24 24">
                  @switch (t) {
                    @case ('braces') { <path d="M8 4C6 4 5 5 5 7v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3" /> }
                    @case ('terminal') { <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9l3 3-3 3M13 15h4" /> }
                    @case ('flow') { <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5" /> }
                    @case ('chart') { <path d="M5 20v-7M12 20V5M19 20v-10" /> }
                    @case ('bell') { <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21a2 2 0 0 0 4 0" /> }
                  }
                </svg>
              </span>
            }
          </div>
          @if (catalog.apis().length) {
            <p class="numbers"><strong>{{ catalog.apis().length }}</strong> APIs · <strong>{{ endpointCount() }}</strong> endpoints no catálogo</p>
          }
        </div>
      </aside>

      <form class="box" (ngSubmit)="submit()">
        <app-brand-logo class="login-logo" [size]="28" />
        <h1>{{ signup() ? 'Criar conta' : 'Entrar' }}</h1>
        <p class="muted">
          @if (signup()) {
            Com uma conta você pode pedir acesso às APIs privadas e acompanhar os seus pedidos.
          } @else {
            Entre para ver as APIs privadas às quais você tem acesso.
          }
        </p>
        @if (expirou()) {
          <div class="alert alert-warn">Sua sessão expirou. Entre novamente.</div>
        }
        @if (saiu() === 'todos') {
          <div class="alert alert-ok" role="status">Você saiu de todos os dispositivos. Entre novamente para continuar.</div>
        }
        @if (error() || sso_erro()) {
          <div class="alert alert-error" role="alert">{{ error() || sso_erro() }}</div>
        }
        @if (opts().sso; as sso) {
          <a class="btn sso" [href]="auth.ssoUrl(voltar() || undefined)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" />
            </svg>
            {{ sso.label }}
          </a>
          @if (opts().password) {
            <div class="or" aria-hidden="true"><span>ou</span></div>
          } @else if (signup()) {
            <p class="small muted">A conta é criada no primeiro login pela organização.</p>
          }
        }
        @if (opts().password) {
        @if (signup()) {
          <div class="field">
            <label for="name">Nome</label>
            <input id="name" name="name" [(ngModel)]="name" autocomplete="name" required />
          </div>
        }
        <div class="field">
          <label for="user">E-mail</label>
          <input id="user" name="email" type="text" inputmode="email" [(ngModel)]="email" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="pass">Senha</label>
          <div class="pass">
            <input id="pass" name="password" [type]="show() ? 'text' : 'password'" [(ngModel)]="password" [attr.autocomplete]="signup() ? 'new-password' : 'current-password'" required />
            <button type="button" class="eye" (click)="show.set(!show())" [attr.aria-pressed]="show()"
                    [attr.aria-label]="show() ? 'Ocultar senha' : 'Exibir senha'" [attr.title]="show() ? 'Ocultar senha' : 'Exibir senha'">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
                @if (show()) { <path d="M4 4l16 16" /> }
              </svg>
            </button>
          </div>
          @if (signup()) {
            <span class="hint">Pelo menos 8 caracteres.</span>
          } @else {
            <a class="forgot small" routerLink="/esqueci-senha">Esqueci minha senha</a>
          }
        </div>
        @if (signup()) {
          <div class="field">
            <label for="pass2">Repita a senha</label>
            <input id="pass2" name="password2" [type]="show() ? 'text' : 'password'" [(ngModel)]="password2" autocomplete="new-password" required
                   [attr.aria-invalid]="mismatch() ? 'true' : null" aria-describedby="pass2-hint" />
            <span id="pass2-hint" class="hint" [class.bad]="mismatch()">{{ mismatch() ? 'As senhas não são iguais.' : '' }}</span>
          </div>
        }
        <button class="btn btn-primary" type="submit" [disabled]="loading() || !ready()">
          {{ loading() ? (signup() ? 'Criando…' : 'Entrando…') : signup() ? 'Criar conta' : 'Entrar' }}
        </button>
        <p class="switch small">
          @if (signup()) {
            Já tem conta? <a routerLink="/entrar" [queryParams]="{ voltar: voltar() || null }">Entrar</a>
          } @else {
            Ainda não tem conta? <a routerLink="/cadastro" [queryParams]="{ voltar: voltar() || null }">Criar conta</a>
          }
        </p>
        }
      </form>
     </div>
    </div>
  `,
  styles: `
    .wrap {
      display: grid; place-items: center; min-height: 100vh;
      padding: calc(var(--header-space) + 40px) 16px 64px;
      background: radial-gradient(900px 420px at 15% 0%, var(--hero-glow), transparent), radial-gradient(700px 380px at 95% 100%, var(--hero-glow), transparent);
    }
    .shell { width: 100%; max-width: 900px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); overflow: hidden; box-shadow: var(--shadow-lg); animation: rise 0.45s ease both; }

    /* Brand side: the same moving gradient and tiles as the home hero. */
    .side {
      position: relative; display: flex; flex-direction: column; justify-content: space-between; gap: 28px; padding: 28px;
      color: var(--on-grad); background: linear-gradient(135deg, var(--grad-stops)); background-size: 200% 200%;
      animation: brand-shift 12s ease-in-out infinite;
    }
    .side-top { display: flex; justify-content: space-between; align-items: flex-start; }
    .chip { padding: 3px 7px; border-radius: 3px; font-family: var(--mono); font-size: 0.68rem; font-weight: 600; letter-spacing: 0.05em; background: rgba(0, 0, 0, 0.55); color: #fff; text-transform: uppercase; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .side-symbol { width: 56px; color: #fff; animation: float 6s ease-in-out infinite; }
    .eyebrow { font-family: var(--mono); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.85; }
    .side h2 { margin: 10px 0 18px; font-size: 1.6rem; line-height: 1.15; letter-spacing: -0.02em; color: inherit; }
    .perks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .perks li { display: flex; gap: 12px; align-items: center; font-size: 0.92rem; line-height: 1.4; animation: rise 0.5s ease both; }
    .perks li:nth-child(1) { animation-delay: 0.1s; }
    .perks li:nth-child(2) { animation-delay: 0.2s; }
    .perks li:nth-child(3) { animation-delay: 0.3s; }
    .perks .ico { width: 34px; height: 34px; padding: 8px; flex-shrink: 0; border-radius: 9px; background: rgba(255, 255, 255, 0.16); }
    .ico { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .mini { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
    .mini-tile { aspect-ratio: 1; display: grid; place-items: center; border-radius: 4px; background: rgba(255, 255, 255, 0.1); color: rgba(255, 255, 255, 0.6); animation: mini-glow 7s ease-in-out infinite; animation-delay: calc(var(--i) * 1.1s); }
    .mini-tile .ico { width: 42%; height: 42%; }
    .numbers { margin: 14px 0 0; font-size: 0.82rem; opacity: 0.9; }

    .box { padding: 36px 32px; display: flex; flex-direction: column; justify-content: center; gap: 16px; min-width: 0; }
    .login-logo { height: 30px; color: var(--text); margin-bottom: 12px; align-self: flex-start; }
    h1 { margin: 0; font-size: 1.5rem; }
    .box > p { margin: -8px 0 0; }
    .box > p.switch { margin: 0; text-align: center; color: var(--text-2); }
    .forgot { align-self: flex-end; }
    .pass { position: relative; }
    .pass input { padding-right: 44px; }
    .eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 8px; background: none; color: var(--text-3); cursor: pointer; }
    .eye:hover, .eye[aria-pressed='true'] { color: var(--text); }
    .eye:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
    .hint:empty { display: none; }
    .hint.bad { color: var(--danger); }
    .sso { display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; }
    .or { display: flex; align-items: center; gap: 12px; color: var(--text-3); font-size: 0.8rem; }
    .or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--border); }

    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes brand-shift { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
    @keyframes float { 0%, 100% { transform: none; } 50% { transform: translateY(-6px); } }
    @keyframes mini-glow { 0%, 14%, 100% { background: rgba(255, 255, 255, 0.1); color: rgba(255, 255, 255, 0.6); } 6% { background: rgba(255, 255, 255, 0.28); color: #fff; } }
    @media (prefers-reduced-motion: reduce) { .shell, .side, .side-symbol, .perks li, .mini-tile { animation: none; } }

    @media (max-width: 760px) {
      .shell { grid-template-columns: minmax(0, 1fr); max-width: 440px; }
      /* On small screens the brand side shrinks to a banner above the form. */
      .side { padding: 20px 24px; gap: 14px; }
      .side h2 { font-size: 1.2rem; margin-bottom: 0; }
      .perks, .side-foot { display: none; }
      .side-symbol { width: 40px; }
      .box { padding: 28px 24px; }
      .login-logo { display: none; }
    }
  `,
})
export class Login implements OnInit {
  auth = inject(AuthService);
  brand = inject(BrandService);
  /** SSO and/or e-mail and password, as the server offers. */
  opts = this.auth.options;
  /** Message from a failed SSO login (the server redirects here with it). */
  sso_erro = input<string>();
  private router = inject(Router);
  catalog = inject(CatalogService);
  endpointCount = computed(() => this.catalog.apis().reduce((n, a) => n + a.endpoints.length, 0));
  /** Decorative tiles on the brand side, like the ones in the home hero. */
  readonly tiles = ['braces', 'terminal', 'flow', 'chart', 'bell'];
  /** Route data: true on /cadastro. */
  cadastro = input<boolean>();
  expirou = input<string>();
  /** 'todos' after "Sair de todos os dispositivos". */
  saiu = input<string>();
  voltar = input<string>();

  signup = computed(() => !!this.cadastro());
  name = '';
  email = '';
  password = '';
  /** Sign-up only: typed twice so a typo doesn't lock the person out. */
  password2 = '';
  /** Shows the password (both fields) as plain text. */
  show = signal(false);
  loading = signal(false);
  error = signal('');

  ready() {
    return !!this.email.trim() && !!this.password && (!this.signup() || (!!this.name.trim() && this.password === this.password2));
  }

  /** Only complains once something was typed in the second field. */
  mismatch() {
    return this.signup() && !!this.password2 && this.password !== this.password2;
  }

  ngOnInit() {
    if (this.auth.isLoggedIn()) this.go();
    this.auth.loadOptions();
  }

  async submit() {
    this.loading.set(true);
    this.error.set('');
    try {
      if (this.signup()) await this.auth.register({ email: this.email, name: this.name, password: this.password });
      else await this.auth.login(this.email, this.password);
      this.go();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Back to where the person came from (only paths inside the portal). */
  private go() {
    const back = this.voltar();
    const safe = back && back.startsWith('/') && !back.startsWith('//') ? back : this.auth.isStaff() ? '/admin' : '/';
    this.router.navigateByUrl(safe);
  }
}

import { Component, computed, inject, input, signal } from '@angular/core';
import { BrandLogo } from '../../shared/brand-logo';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth';
import { errorMessage } from '../../core/catalog.service';

/**
 * /esqueci-senha: asks for the e-mail and sends the link.
 * /redefinir-senha?token=…: sets the new password (from the e-mail link) and logs in.
 */
@Component({
  selector: 'app-password-reset',
  imports: [BrandLogo, FormsModule, RouterLink],
  template: `
    <div class="wrap">
      @if (!token()) {
        <form class="card box" (ngSubmit)="sendLink()">
          <app-brand-logo class="login-logo" [size]="28" />
          <h1>Esqueci minha senha</h1>
          @if (sent()) {
            <div class="alert alert-ok" role="status">{{ sent() }}</div>
            <p class="muted small">O link vale por 1 hora. Não chegou? Espere um minuto e peça de novo, ou fale com um administrador do catálogo.</p>
            <a class="btn" routerLink="/entrar">Voltar para entrar</a>
          } @else {
            <p class="muted">Informe o e-mail da sua conta. Enviaremos um link para você criar uma senha nova.</p>
            @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }
            <div class="field">
              <label for="email">E-mail</label>
              <input id="email" name="email" type="email" [(ngModel)]="email" autocomplete="email" required />
            </div>
            <button class="btn btn-primary" type="submit" [disabled]="loading() || !email.trim()">{{ loading() ? 'Enviando…' : 'Enviar link' }}</button>
            <p class="switch small"><a routerLink="/entrar">Voltar para entrar</a></p>
          }
        </form>
      } @else {
        <form class="card box" (ngSubmit)="reset()">
          <app-brand-logo class="login-logo" [size]="28" />
          <h1>Criar uma senha nova</h1>
          <p class="muted">Depois de salvar, você entra direto e as outras sessões abertas são encerradas.</p>
          @if (error()) {
            <div class="alert alert-error" role="alert">{{ error() }}</div>
          }
          <input type="text" name="username" autocomplete="username" hidden />
          <div class="field">
            <label for="pass">Nova senha</label>
            <input id="pass" name="password" type="password" [(ngModel)]="password" autocomplete="new-password" required />
            <span class="hint">Pelo menos 8 caracteres.</span>
          </div>
          <div class="field">
            <label for="pass2">Repita a nova senha</label>
            <input id="pass2" name="password2" type="password" [(ngModel)]="password2" autocomplete="new-password" required />
            @if (mismatch()) { <span class="hint bad">As senhas não são iguais.</span> }
          </div>
          <button class="btn btn-primary" type="submit" [disabled]="loading() || !password || password !== password2">{{ loading() ? 'Salvando…' : 'Salvar e entrar' }}</button>
          @if (expired()) {
            <p class="switch small"><a routerLink="/esqueci-senha">Pedir um link novo</a></p>
          }
        </form>
      }
    </div>
  `,
  styles: `
    .wrap { display: grid; place-items: center; padding: calc(var(--header-space) + 56px) 16px 80px; }
    .box { width: 100%; max-width: 420px; padding: 32px; display: flex; flex-direction: column; gap: 16px; }
    .login-logo { height: 30px; color: var(--text); margin-bottom: 12px; align-self: flex-start; }
    h1 { margin: 0; font-size: 1.5rem; }
    p { margin: -8px 0 0; }
    .box > .btn { align-self: flex-start; }
    .box > button.btn-primary { align-self: stretch; }
    .switch { margin: 0; text-align: center; }
    .bad { color: var(--danger); }
  `,
})
export class PasswordReset {
  private auth = inject(AuthService);
  private router = inject(Router);
  /** ?token= from the e-mail link. */
  token = input<string>();

  email = '';
  password = '';
  password2 = '';
  loading = signal(false);
  error = signal('');
  sent = signal('');

  expired = computed(() => /expirou|inválido/.test(this.error()));

  mismatch() {
    return !!this.password2 && this.password !== this.password2;
  }

  async sendLink() {
    this.loading.set(true);
    this.error.set('');
    try {
      this.sent.set(await this.auth.forgotPassword(this.email.trim()));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  async reset() {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.auth.resetPassword(this.token()!, this.password);
      this.router.navigateByUrl(this.auth.isStaff() ? '/admin' : '/conta');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}

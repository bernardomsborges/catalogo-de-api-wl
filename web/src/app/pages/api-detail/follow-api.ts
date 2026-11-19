import { HttpClient } from '@angular/common/http';
import { AppDialog } from '../../shared/dialog';
import { AuthService } from '../../core/auth';
import { Component, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/catalog.service';

/** "Acompanhar esta API": asks for an e-mail and sends a confirmation link. */
@Component({
  selector: 'app-follow-api',
  imports: [AppDialog, FormsModule],
  template: `
    <button class="btn" type="button" (click)="toggle()" [attr.aria-expanded]="open()" aria-controls="follow-panel" title="Receber avisos por e-mail quando esta API mudar">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
      Acompanhar
    </button>
    @if (open()) {
      <div class="panel card" id="follow-panel" appDialog [trap]="false" (dismiss)="close()" role="dialog" aria-labelledby="follow-title">
        @if (sent()) {
          <h3 id="follow-title">Confira seu e-mail</h3>
          <p class="small">{{ sent() }} Clique no link para começar a receber os avisos.</p>
          <button class="btn btn-sm" type="button" (click)="close()">Fechar</button>
        } @else {
          <h3 id="follow-title">Acompanhar {{ apiName() }}</h3>
          <p class="small muted">Receba um e-mail quando sair uma versão nova, quando algo puder quebrar sua integração ou quando a API for depreciada.</p>
          <form (ngSubmit)="submit()">
            <label class="sr-only" for="follow-email">E-mail</label>
            <input #emailInput id="follow-email" name="email" type="email" required autocomplete="email" [(ngModel)]="email" placeholder="seu.email@organizacao.gov.br" />
            @if (error()) { <div class="alert alert-error small" role="alert">{{ error() }}</div> }
            <div class="row">
              <button class="btn btn-primary btn-sm" type="submit" [disabled]="sending() || !email.trim()">{{ sending() ? 'Enviando…' : 'Acompanhar' }}</button>
              <button class="btn btn-ghost btn-sm" type="button" (click)="close()">Cancelar</button>
            </div>
          </form>
          <p class="hint">Você confirma pelo e-mail e pode deixar de acompanhar com um clique em qualquer aviso.</p>
        }
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: inline-block; }
    .btn { display: inline-flex; align-items: center; gap: 7px; }
    .panel { position: absolute; right: 0; top: calc(100% + 8px); width: min(360px, calc(100vw - 32px)); padding: 16px; z-index: 30; display: flex; flex-direction: column; gap: 10px; }
    h3 { margin: 0; font-size: 1rem; }
    p { margin: 0; }
    form { display: flex; flex-direction: column; gap: 10px; }
    .hint { font-size: 0.75rem; color: var(--text-3); }
    @media (max-width: 640px) { .panel { left: 0; right: auto; } }
  `,
})
export class FollowApi {
  private http = inject(HttpClient);
  apiSlug = input.required<string>();
  apiName = input.required<string>();

  open = signal(false);
  sending = signal(false);
  sent = signal('');
  error = signal('');
  email = '';
  private auth = inject(AuthService);
  private emailInput = viewChild<ElementRef<HTMLInputElement>>('emailInput');

  toggle() {
    if (this.open()) return this.close();
    this.open.set(true);
    if (!this.email) this.email = this.auth.current()?.email ?? '';
    setTimeout(() => this.emailInput()?.nativeElement.focus());
  }

  close() {
    this.open.set(false);
    this.sent.set('');
    this.error.set('');
  }

  async submit() {
    this.error.set('');
    this.sending.set(true);
    try {
      const r = await firstValueFrom(
        this.http.post<{ message: string }>(`/api/apis/${encodeURIComponent(this.apiSlug())}/subscribe`, { email: this.email.trim() })
      );
      this.sent.set(r.message);
      this.email = '';
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.sending.set(false);
    }
  }
}

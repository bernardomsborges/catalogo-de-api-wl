import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AccessRequest, AccessService } from '../../core/access.service';
import { AuthService } from '../../core/auth';
import { errorMessage } from '../../core/catalog.service';
import { Api } from '../../core/models';

/** Private API without access: what it is, who owns it, and how to get access. */
@Component({
  selector: 'app-locked-api',
  imports: [FormsModule, RouterLink],
  template: `
    <section class="card locked">
      <div class="lock" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1.3" fill="currentColor" stroke="none" /></svg>
      </div>
      <div class="body">
        <h2>Esta API é privada</h2>
        <p class="muted">
          A documentação, as rotas, as credenciais e o console de testes ficam disponíveis para quem tem acesso.
          @if (api().owner) { Ela é mantida por <strong>{{ api().owner }}</strong>@if (api().contactEmail) { (<a [href]="'mailto:' + api().contactEmail">{{ api().contactEmail }}</a>)}. }
        </p>

        @if (!auth.isLoggedIn()) {
          <div class="row">
            <a class="btn btn-primary" routerLink="/entrar" [queryParams]="{ voltar: here() }">Entrar</a>
            <a class="btn" routerLink="/cadastro" [queryParams]="{ voltar: here() }">Criar conta</a>
          </div>
          <p class="hint">Entre com a sua conta para ver a API, se você já tem acesso, ou para pedir acesso.</p>
        } @else if (pending(); as r) {
          <div class="alert alert-ok" role="status">
            Pedido enviado em {{ date(r.createdAt) }}. Um administrador vai analisar, e você acompanha em <a routerLink="/conta">Minha conta</a>.
          </div>
        } @else {
          @if (rejected(); as r) {
            <div class="alert alert-warn">Seu último pedido foi recusado{{ r.note ? ': ' + r.note : '' }}. Você pode pedir de novo explicando melhor.</div>
          }
          <form class="ask" (ngSubmit)="send()">
            <div class="field">
              <label for="why">Para que você precisa desta API? (opcional)</label>
              <textarea id="why" name="why" rows="3" [(ngModel)]="why" maxlength="500" placeholder="Ex.: vou integrar o sistema de protocolo da minha unidade"></textarea>
            </div>
            @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }
            <button class="btn btn-primary" type="submit" [disabled]="sending()">{{ sending() ? 'Enviando…' : 'Pedir acesso' }}</button>
          </form>
        }
      </div>
    </section>
  `,
  styles: `
    .locked { display: flex; gap: 20px; padding: 28px; align-items: flex-start; max-width: 760px; margin: 0 auto; }
    .lock { flex: none; width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; background: var(--brand-soft); color: var(--brand); }
    .body { display: flex; flex-direction: column; gap: 14px; flex: 1; min-width: 0; }
    h2 { margin: 0; font-size: 1.25rem; }
    p { margin: 0; }
    .ask { display: flex; flex-direction: column; gap: 12px; }
    .ask .btn { align-self: flex-start; }
    @media (max-width: 560px) { .locked { flex-direction: column; padding: 22px; } }
  `,
})
export class LockedApi {
  api = input.required<Api>();
  auth = inject(AuthService);
  private access = inject(AccessService);
  private router = inject(Router);

  requests = signal<AccessRequest[]>([]);
  sending = signal(false);
  error = signal('');
  why = '';

  pending = computed(() => this.requests().find((r) => r.apiId === this.api().id && r.status === 'pending') ?? null);
  rejected = computed(() => this.requests().find((r) => r.apiId === this.api().id && r.status === 'rejected') ?? null);

  constructor() {
    effect(() => {
      if (this.auth.isLoggedIn()) this.access.myRequests().then((r) => this.requests.set(r), () => {});
      else this.requests.set([]);
    });
  }

  here() {
    return this.router.url;
  }

  async send() {
    this.sending.set(true);
    this.error.set('');
    try {
      const r = await this.access.request({ api: this.api().id, message: this.why });
      this.requests.update((list) => [r, ...list.filter((x) => x.id !== r.id)]);
      this.why = '';
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.sending.set(false);
    }
  }

  date(iso: string) {
    return new Date(iso).toLocaleDateString('pt-BR');
  }
}

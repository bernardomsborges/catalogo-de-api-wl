import { HttpClient } from '@angular/common/http';
import { Component, inject, input, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/catalog.service';

interface Reply {
  api: { name: string; slug: string };
  email: string;
  status: 'pending' | 'active' | 'cancelled';
}

/**
 * Landing page of the e-mail links: /acompanhar/confirmar and /acompanhar/cancelar.
 * The action runs from the page (POST), not from the GET of the link, so mail scanners that open
 * links ahead of time don't confirm or cancel anything.
 */
@Component({
  selector: 'app-follow',
  imports: [RouterLink],
  template: `
    <div class="container page">
      <div class="card box">
        @if (busy()) {
          <p class="muted">Um momento…</p>
        } @else if (error()) {
          <h1>Não deu certo</h1>
          <p class="muted">{{ error() }}</p>
          <a class="btn" routerLink="/apis">Ver o catálogo</a>
        } @else if (reply(); as r) {
          @if (r.status === 'active') {
            <h1>Pronto! Você acompanha a {{ r.api.name }}</h1>
            <p class="muted">Avisos de mudanças vão para <strong>{{ r.email }}</strong>. Em cada aviso há um link para deixar de acompanhar.</p>
          } @else {
            <h1>Você deixou de acompanhar a {{ r.api.name }}</h1>
            <p class="muted">Não enviaremos mais avisos desta API para <strong>{{ r.email }}</strong>.</p>
          }
          <div class="row">
            <a class="btn btn-primary" [routerLink]="['/apis', r.api.slug]">Ir para a API</a>
            @if (r.status === 'cancelled') {
              <button class="btn" type="button" (click)="undo()">Foi sem querer: voltar a acompanhar</button>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 48px); display: grid; place-items: start center; }
    .box { max-width: 560px; width: 100%; padding: 28px; display: flex; flex-direction: column; gap: 12px; }
    h1 { margin: 0; font-size: 1.4rem; }
    p { margin: 0; }
  `,
})
export class Follow implements OnInit {
  private http = inject(HttpClient);
  /** From route data. */
  action = input.required<'confirmar' | 'cancelar'>();
  /** From the query string. */
  token = input<string>('');

  busy = signal(true);
  error = signal('');
  reply = signal<Reply | null>(null);

  ngOnInit() {
    this.run(this.action() === 'confirmar' ? 'confirm' : 'unsubscribe');
  }

  undo() {
    this.run('resubscribe');
  }

  private async run(op: 'confirm' | 'unsubscribe' | 'resubscribe') {
    this.busy.set(true);
    this.error.set('');
    try {
      this.reply.set(await firstValueFrom(this.http.post<Reply>(`/api/subscriptions/${op}`, { token: this.token() })));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

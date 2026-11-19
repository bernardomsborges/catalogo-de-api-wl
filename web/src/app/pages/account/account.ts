import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AccessRequest, AccessService, Group } from '../../core/access.service';
import { AuthService, ROLE_LABELS } from '../../core/auth';
import { errorMessage } from '../../core/catalog.service';

export const REQUEST_STATUS: Record<AccessRequest['status'], string> = { pending: 'Aguardando', approved: 'Aprovado', rejected: 'Recusado' };

/** /conta: who I am, my groups, access requests and password. */
@Component({
  selector: 'app-account',
  imports: [FormsModule, RouterLink],
  template: `
    @let me = auth.current();
    <div class="container page">
      <div class="row head">
        <div>
          <h1>Minha conta</h1>
          <p class="muted">{{ me?.name }} · {{ me?.email }} · {{ roleLabel() }}</p>
        </div>
        <span class="spacer"></span>
        @if (auth.isStaff()) { <a class="btn" routerLink="/admin">Painel admin</a> }
        <button class="btn" type="button" (click)="auth.logout()">Sair</button>
      </div>

      @if (message()) {
        <div class="alert" [class.alert-ok]="!isError()" [class.alert-error]="isError()" role="status">{{ message() }}</div>
      }

      <div class="grid">
        <section class="card section">
          <h2>Meus grupos</h2>
          @if (auth.isStaff()) {
            <p class="muted">Como {{ roleLabel().toLowerCase() }}, você vê todas as APIs, inclusive as privadas.</p>
          }
          @if (me?.groups?.length) {
            <ul class="chips">@for (g of me!.groups; track g.id) { <li class="tag">{{ g.name }}</li> }</ul>
          } @else {
            <p class="muted">Você ainda não faz parte de nenhum grupo. Os grupos dão acesso às APIs privadas.</p>
          }

          @if (available().length) {
            <form class="ask" (ngSubmit)="requestGroup()">
              <h3>Pedir para entrar em um grupo</h3>
              <div class="field">
                <label for="g">Grupo</label>
                <select id="g" name="g" [(ngModel)]="groupId">
                  <option value="">Escolha…</option>
                  @for (g of available(); track g.id) { <option [value]="g.id">{{ g.name }}</option> }
                </select>
                @if (selectedGroup()?.description) { <span class="hint">{{ selectedGroup()!.description }}</span> }
              </div>
              <div class="field">
                <label for="why">Por que você precisa? (opcional)</label>
                <textarea id="why" name="why" rows="2" [(ngModel)]="why" maxlength="500" placeholder="Ex.: vou integrar o sistema X com o SEI"></textarea>
              </div>
              <button class="btn btn-primary" type="submit" [disabled]="!groupId || sending()">{{ sending() ? 'Enviando…' : 'Pedir acesso' }}</button>
            </form>
          }
        </section>

        <section class="card section">
          <h2>Meus pedidos de acesso</h2>
          @for (r of requests(); track r.id) {
            <div class="req">
              <div>
                <strong>{{ r.apiName || r.group?.name || 'Grupo removido' }}</strong>
                <span class="small muted"> · {{ r.apiId ? 'API' : 'grupo' }} · {{ date(r.createdAt) }}</span>
                @if (r.note) { <div class="small muted">Resposta: {{ r.note }}</div> }
              </div>
              <span class="status st-{{ r.status }}">{{ statusLabel[r.status] }}</span>
            </div>
          } @empty {
            <p class="muted">Nenhum pedido ainda. Nas APIs privadas, use o botão <strong>Pedir acesso</strong>.</p>
          }
        </section>

        <!-- Accounts that only enter through SSO have no password here. -->
        @if (auth.options().password && me?.hasPassword !== false) {
        <section class="card section">
          <h2>Trocar senha</h2>
          <form class="pw" (ngSubmit)="changePassword()">
            <input type="text" name="username" [value]="me?.email" autocomplete="username" hidden />
            <div class="field">
              <label for="cur">Senha atual</label>
              <input id="cur" name="cur" type="password" [(ngModel)]="current" autocomplete="current-password" />
            </div>
            <div class="field">
              <label for="new">Nova senha</label>
              <input id="new" name="new" type="password" [(ngModel)]="next" autocomplete="new-password" />
              <span class="hint">Pelo menos 8 caracteres. As outras sessões abertas serão encerradas.</span>
            </div>
            <button class="btn" type="submit" [disabled]="!current || !next || savingPw()">{{ savingPw() ? 'Salvando…' : 'Trocar senha' }}</button>
          </form>
        </section>
        }

        <section class="card section">
          <h2>Sessões</h2>
          <p class="muted">Esqueceu o portal aberto em outro computador ou acha que alguém usou a sua conta? Encerre todas as sessões, inclusive esta. Você precisará entrar de novo.</p>
          <button class="btn btn-danger end-all" type="button" (click)="logoutEverywhere()" [disabled]="endingAll()">{{ endingAll() ? 'Encerrando…' : 'Sair de todos os dispositivos' }}</button>
        </section>
      </div>
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); padding-bottom: 64px; display: flex; flex-direction: column; gap: 20px; }
    .head h1 { margin: 0; }
    .head p { margin: 2px 0 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; align-items: start; }
    .section { padding: 22px; display: flex; flex-direction: column; gap: 12px; }
    .section h2 { margin: 0; font-size: 1.1rem; }
    .section p { margin: 0; }
    h3 { margin: 6px 0 0; font-size: 0.95rem; }
    .chips { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; }
    .ask, .pw { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
    .pw { border: 0; padding: 0; }
    .ask .btn, .pw .btn, .end-all { align-self: flex-start; }
    .req { display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .req:last-child { border-bottom: 0; }
    .status { font-size: 0.78rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
    .st-pending { background: var(--warn-soft); color: var(--warn); }
    .st-approved { background: var(--ok-soft); color: var(--ok); }
    .st-rejected { background: var(--danger-soft); color: var(--danger); }
  `,
})
export class AccountPage implements OnInit {
  auth = inject(AuthService);
  private access = inject(AccessService);
  statusLabel = REQUEST_STATUS;

  groups = signal<Group[]>([]);
  requests = signal<AccessRequest[]>([]);
  message = signal('');
  isError = signal(false);
  sending = signal(false);
  savingPw = signal(false);
  endingAll = signal(false);
  groupId = '';
  why = '';
  current = '';
  next = '';

  roleLabel = computed(() => ROLE_LABELS[this.auth.current()?.role ?? 'consumer']);
  /** Groups I'm not in and haven't asked for yet. */
  available = computed(() => {
    const mine = new Set(this.auth.current()?.groups.map((g) => g.id));
    const asked = new Set(this.requests().filter((r) => r.status === 'pending' && !r.apiId).map((r) => r.groupId));
    return this.groups().filter((g) => !mine.has(g.id) && !asked.has(g.id));
  });
  selectedGroup() {
    return this.groups().find((g) => g.id === this.groupId);
  }

  ngOnInit() {
    this.auth.refreshMe();
    this.auth.loadOptions();
    this.load();
  }

  private async load() {
    const [groups, requests] = await Promise.all([this.access.requestableGroups().catch(() => []), this.access.myRequests().catch(() => [])]);
    this.groups.set(groups);
    this.requests.set(requests);
  }

  private say(text: string, error = false) {
    this.message.set(text);
    this.isError.set(error);
  }

  async requestGroup() {
    this.sending.set(true);
    try {
      const r = await this.access.request({ groupId: this.groupId, message: this.why });
      this.say(`Pedido enviado para o grupo “${r.group?.name}”. Um administrador vai analisar.`);
      this.groupId = '';
      this.why = '';
      await this.load();
    } catch (e) {
      this.say(errorMessage(e), true);
    } finally {
      this.sending.set(false);
    }
  }

  async changePassword() {
    this.savingPw.set(true);
    try {
      await this.auth.changePassword(this.current, this.next);
      this.current = this.next = '';
      this.say('Senha trocada.');
    } catch (e) {
      this.say(errorMessage(e), true);
    } finally {
      this.savingPw.set(false);
    }
  }

  async logoutEverywhere() {
    if (!confirm('Sair de todos os dispositivos? Todas as sessões da sua conta serão encerradas, inclusive esta.')) return;
    this.endingAll.set(true);
    try {
      await this.auth.logoutEverywhere();
    } catch (e) {
      this.say(errorMessage(e), true);
      this.endingAll.set(false);
    }
  }

  date(iso: string) {
    return new Date(iso).toLocaleDateString('pt-BR');
  }
}

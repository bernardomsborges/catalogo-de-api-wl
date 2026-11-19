import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { ArrowKeys } from '../../shared/arrow-keys';
import { AppDialog } from '../../shared/dialog';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AccessRequest, AccessService, AdminAccount, Group } from '../../core/access.service';
import { AuthService, Role, ROLE_LABELS } from '../../core/auth';
import { CatalogService, errorMessage } from '../../core/catalog.service';
import { REQUEST_STATUS } from '../account/account';

type Tab = 'pedidos' | 'pessoas' | 'grupos';

interface PersonForm {
  id: string | null;
  name: string;
  email: string;
  password: string;
  role: Role;
  groups: string[];
  disabled: boolean;
}

interface GroupForm {
  id: string | null;
  name: string;
  description: string;
  requestable: boolean;
}

/** /admin/pessoas: access requests, people (role, groups) and groups. Admins only. */
@Component({
  selector: 'app-people',
  imports: [ArrowKeys, AppDialog, FormsModule, RouterLink],
  template: `
    <div class="container page">
      <div class="row head">
        <div>
          <a routerLink="/admin" class="small">← Voltar ao painel</a>
          <h1>Pessoas e acesso</h1>
          <p class="muted">Quem entra no portal, o que cada um pode fazer e quem acessa as APIs privadas.</p>
        </div>
      </div>

      <div class="tabs" appArrowKeys role="tablist">
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'pedidos'" [class.on]="tab() === 'pedidos'" (click)="go('pedidos')">
          Pedidos @if (pending().length) { <span class="count">{{ pending().length }}</span> }
        </button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'pessoas'" [class.on]="tab() === 'pessoas'" (click)="go('pessoas')">Pessoas ({{ users().length }})</button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'grupos'" [class.on]="tab() === 'grupos'" (click)="go('grupos')">Grupos ({{ groups().length }})</button>
      </div>

      @if (message()) {
        <div class="alert" [class.alert-ok]="!isError()" [class.alert-error]="isError()" role="status">{{ message() }}</div>
      }

      @switch (tab()) {
        @case ('pedidos') {
          <div class="card list">
            @for (r of pending(); track r.id) {
              <div class="req">
                <div class="who">
                  <strong>{{ r.user?.name }}</strong> <span class="muted small">{{ r.user?.email }}</span>
                  <div>pede acesso {{ r.apiId ? 'à API' : 'ao grupo' }} <strong>{{ r.apiName || r.group?.name }}</strong><span class="muted small">&nbsp;· {{ date(r.createdAt) }}</span></div>
                  @if (r.message) { <blockquote>{{ r.message }}</blockquote> }
                </div>
                <div class="decide">
                  @if (r.apiId) {
                    <label class="sr-only" [for]="'grp-' + r.id">Grupo que dá o acesso</label>
                    <select [id]="'grp-' + r.id" [(ngModel)]="choice[r.id]">
                      <option value="">Liberar pelo grupo…</option>
                      @for (g of groupsFor(r); track g.id) { <option [value]="g.id">{{ g.name }}{{ (r.apiGroups || []).includes(g.id) ? '' : ' (não dá acesso a esta API)' }}</option> }
                    </select>
                  }
                  <div class="row">
                    <button class="btn btn-sm btn-primary" type="button" (click)="approve(r)" [disabled]="busy() || (!!r.apiId && !choice[r.id])">Aprovar</button>
                    <button class="btn btn-sm" type="button" (click)="reject(r)" [disabled]="busy()">Recusar</button>
                  </div>
                  @if (r.apiId && !(r.apiGroups || []).length) {
                    <span class="hint">Esta API ainda não tem grupo. Marque um grupo na visibilidade da API para liberar o acesso.</span>
                  }
                </div>
              </div>
            } @empty {
              <p class="empty muted">Nenhum pedido aguardando.</p>
            }
          </div>
          @if (answered().length) {
            <details class="card answered">
              <summary>Pedidos respondidos ({{ answered().length }})</summary>
              @for (r of answered(); track r.id) {
                <div class="small row-ans">
                  <span><strong>{{ r.user?.name }}</strong> → {{ r.apiName || r.group?.name }}{{ r.apiId && r.group ? ' (grupo ' + r.group.name + ')' : '' }}</span>
                  <span class="status st-{{ r.status }}">{{ statusLabel[r.status] }}</span>
                  <span class="muted">{{ r.decidedBy }} · {{ date(r.decidedAt!) }}</span>
                </div>
              }
            </details>
          }
        }

        @case ('pessoas') {
          <div class="card">
            <div class="toolbar row">
              <label class="sr-only" for="fp">Filtrar pessoas</label>
              <input id="fp" [(ngModel)]="filter" placeholder="Filtrar por nome ou e-mail…" />
              <span class="spacer"></span>
              <button class="btn btn-primary" type="button" (click)="newPerson()">+ Nova pessoa</button>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Pessoa</th><th>Papel</th><th>Grupos</th><th>Último acesso</th><th class="right">Ações</th></tr></thead>
                <tbody>
                  @for (u of visibleUsers(); track u.id) {
                    <tr [class.off]="u.disabled">
                      <td><strong>{{ u.name }}</strong>@if (u.disabled) { <span class="tag tag-off">Desativada</span> }<div class="small muted">{{ u.email }}</div></td>
                      <td>{{ roleLabels[u.role] }}</td>
                      <td class="small">{{ groupNames(u) || '—' }}</td>
                      <td class="small muted">{{ u.lastLoginAt ? date(u.lastLoginAt) : 'nunca' }}</td>
                      <td class="right"><button class="btn btn-sm" type="button" (click)="editPerson(u)">Editar</button></td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }

        @case ('grupos') {
          <div class="card">
            <div class="toolbar row">
              <p class="muted small grow">Um grupo dá acesso às APIs privadas marcadas com ele. Coloque pessoas no grupo pela aba Pessoas ou aprovando pedidos.</p>
              <button class="btn btn-primary" type="button" (click)="newGroup()">+ Novo grupo</button>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Grupo</th><th>Pessoas</th><th>APIs privadas</th><th>Aceita pedidos</th><th class="right">Ações</th></tr></thead>
                <tbody>
                  @for (g of groups(); track g.id) {
                    <tr>
                      <td><strong>{{ g.name }}</strong><div class="small muted">{{ g.description }}</div></td>
                      <td>{{ g.memberCount }}</td>
                      <td class="small">{{ apisOf(g) || '—' }}</td>
                      <td>{{ g.requestable ? 'Sim' : 'Não' }}</td>
                      <td class="right"><button class="btn btn-sm" type="button" (click)="editGroup(g)">Editar</button></td>
                    </tr>
                  } @empty {
                    <tr><td colspan="5" class="empty">Nenhum grupo ainda.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }
      }
    </div>

    @if (person(); as p) {
      <div class="backdrop" (click)="person.set(null)">
        <div class="card dialog" appDialog (dismiss)="person.set(null)" role="dialog" aria-modal="true" aria-labelledby="p-title" (click)="$event.stopPropagation()">
          <form class="dialog-form" (ngSubmit)="savePerson(p)">
          <h2 id="p-title">{{ p.id ? 'Editar pessoa' : 'Nova pessoa' }}</h2>
          <div class="field"><label for="p-name">Nome</label><input id="p-name" name="name" [(ngModel)]="p.name" required /></div>
          <div class="field"><label for="p-email">E-mail</label><input id="p-email" name="email" type="email" [(ngModel)]="p.email" />
            @if (p.id && !p.email.includes('@')) { <span class="hint">Coloque um e-mail de verdade para receber os pedidos de acesso e poder usar "Esqueci minha senha".</span> }</div>
          <div class="field">
            <label for="p-role">Papel</label>
            <select id="p-role" name="role" [(ngModel)]="p.role" [disabled]="p.id === auth.current()?.id">
              @for (r of roles; track r[0]) { <option [value]="r[0]">{{ r[1] }}</option> }
            </select>
            <span class="hint">{{ roleHint[p.role] }}</span>
          </div>
          <fieldset class="field">
            <legend>Grupos</legend>
            @for (g of groups(); track g.id) {
              <label class="check"><input type="checkbox" [checked]="p.groups.includes(g.id)" (change)="toggle(p.groups, g.id)" /> {{ g.name }}</label>
            } @empty { <span class="hint">Nenhum grupo criado.</span> }
          </fieldset>
          @if (auth.options().password) {
            <div class="field">
              <label for="p-pass">{{ p.id ? 'Nova senha (opcional)' : 'Senha inicial' }}</label>
              <input id="p-pass" name="password" type="password" [(ngModel)]="p.password" autocomplete="new-password" />
              <span class="hint">Pelo menos 8 caracteres. Passe para a pessoa e peça para ela trocar em Minha conta.</span>
            </div>
          } @else {
            <p class="hint">A pessoa entra pelo login da organização ({{ auth.options().sso?.label }}) com este e-mail e já recebe o papel e os grupos escolhidos aqui.</p>
          }
          @if (p.id && p.id !== auth.current()?.id) {
            <label class="check"><input type="checkbox" name="disabled" [(ngModel)]="p.disabled" /> Conta desativada (não consegue entrar)</label>
          }
          <div class="row end">
            @if (p.id && p.id !== auth.current()?.id) {
              <button class="btn btn-danger" type="button" (click)="removePerson(p)" [disabled]="busy()">Excluir</button>
              <button class="btn" type="button" (click)="endSessions(p)" [disabled]="busy()" title="A pessoa precisa entrar de novo em todos os dispositivos">Encerrar sessões</button>
              <span class="spacer"></span>
            }
            <button class="btn" type="button" (click)="person.set(null)">Cancelar</button>
            <button class="btn btn-primary" type="submit" [disabled]="busy() || !p.name || (!p.id && (!p.email || (auth.options().password && !p.password)))">Salvar</button>
          </div>
          </form>
        </div>
      </div>
    }

    @if (group(); as g) {
      <div class="backdrop" (click)="group.set(null)">
        <div class="card dialog" appDialog (dismiss)="group.set(null)" role="dialog" aria-modal="true" aria-labelledby="g-title" (click)="$event.stopPropagation()">
          <form class="dialog-form" (ngSubmit)="saveGroup(g)">
          <h2 id="g-title">{{ g.id ? 'Editar grupo' : 'Novo grupo' }}</h2>
          <div class="field"><label for="g-name">Nome</label><input id="g-name" name="name" [(ngModel)]="g.name" placeholder="Ex.: Time SEI" required /></div>
          <div class="field"><label for="g-desc">Descrição</label><textarea id="g-desc" name="desc" rows="2" [(ngModel)]="g.description" placeholder="Quem deve fazer parte"></textarea></div>
          <label class="check"><input type="checkbox" name="req" [(ngModel)]="g.requestable" /> Aparece em Minha conta para as pessoas pedirem para entrar</label>
          <div class="row end">
            @if (g.id) {
              <button class="btn btn-danger" type="button" (click)="removeGroup(g)" [disabled]="busy()">Excluir</button>
              <span class="spacer"></span>
            }
            <button class="btn" type="button" (click)="group.set(null)">Cancelar</button>
            <button class="btn btn-primary" type="submit" [disabled]="busy() || !g.name">Salvar</button>
          </div>
          </form>
        </div>
      </div>
    }
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); padding-bottom: 64px; display: flex; flex-direction: column; gap: 18px; }
    .head h1 { margin: 4px 0 0; }
    .head p { margin: 2px 0 0; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 14px; font: inherit; font-weight: 600; color: var(--text-2); cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
    .tabs button.on { color: var(--text); border-bottom-color: var(--brand); }
    .count { background: var(--danger); color: #fff; border-radius: 999px; font-size: 0.72rem; padding: 1px 7px; }
    .list { padding: 6px 18px; }
    .req { display: flex; gap: 16px; justify-content: space-between; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .req:last-child { border-bottom: 0; }
    .who { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 4px; }
    blockquote { margin: 4px 0 0; padding: 6px 10px; border-left: 3px solid var(--border-strong); color: var(--text-2); font-size: 0.9rem; }
    .decide { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; max-width: 320px; }
    .decide select { min-width: 240px; }
    .empty { padding: 18px 0; text-align: center; }
    .answered { padding: 12px 18px; }
    .answered summary { cursor: pointer; font-weight: 600; }
    .row-ans { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .status { font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
    .st-approved { background: var(--ok-soft); color: var(--ok); }
    .st-rejected { background: var(--danger-soft); color: var(--danger); }
    .st-pending { background: var(--warn-soft); color: var(--warn); }
    .toolbar { padding: 14px; border-bottom: 1px solid var(--border); gap: 12px; align-items: center; }
    .toolbar input { max-width: 340px; }
    .toolbar p { margin: 0; }
    .grow { flex: 1; }
    .right { text-align: right; }
    tr.off td { opacity: 0.6; }
    .tag-off { margin-left: 6px; background: var(--danger-soft); color: var(--danger); }
    .backdrop { position: fixed; inset: 0; background: var(--overlay); display: grid; place-items: center; padding: 16px; z-index: 50; overflow-y: auto; }
    .dialog { max-width: 480px; width: 100%; padding: 24px; }
    .dialog-form { display: flex; flex-direction: column; gap: 14px; }
    .dialog h2 { margin: 0; }
    fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
    legend { font-weight: 600; font-size: 0.9rem; margin-bottom: 4px; }
    .end { justify-content: flex-end; gap: 8px; }
  `,
})
export class People implements OnInit {
  auth = inject(AuthService);
  private access = inject(AccessService);
  private catalog = inject(CatalogService);
  private router = inject(Router);
  /** ?aba= */
  aba = input<string>();

  roleLabels = ROLE_LABELS;
  roles = Object.entries(ROLE_LABELS) as [Role, string][];
  roleHint: Record<Role, string> = {
    admin: 'Tudo, inclusive pessoas, grupos e pedidos de acesso.',
    editor: 'Documenta APIs e ReceAPItos e vê todas as APIs privadas.',
    consumer: 'Vê o portal; APIs privadas só com o grupo certo.',
  };
  statusLabel = REQUEST_STATUS;

  users = signal<AdminAccount[]>([]);
  groups = signal<Group[]>([]);
  requests = signal<AccessRequest[]>([]);
  message = signal('');
  isError = signal(false);
  busy = signal(false);
  person = signal<PersonForm | null>(null);
  group = signal<GroupForm | null>(null);
  filter = '';
  /** Group picked to approve each API request. */
  choice: Record<string, string> = {};

  tab = computed<Tab>(() => (['pedidos', 'pessoas', 'grupos'].includes(this.aba() || '') ? (this.aba() as Tab) : 'pedidos'));
  pending = computed(() => this.requests().filter((r) => r.status === 'pending'));
  answered = computed(() => this.requests().filter((r) => r.status !== 'pending'));

  ngOnInit() {
    this.catalog.refresh();
    this.auth.loadOptions();
    this.load();
  }

  private async load() {
    try {
      const [users, groups, requests] = await Promise.all([this.access.users(), this.access.adminGroups(), this.access.requests()]);
      this.users.set(users);
      this.groups.set(groups);
      this.requests.set(requests);
      // Pre-select the API's group when there is exactly one.
      for (const r of requests) if (r.apiId && r.status === 'pending' && !this.choice[r.id] && r.apiGroups?.length === 1) this.choice[r.id] = r.apiGroups[0];
    } catch (e) {
      this.say(errorMessage(e), true);
    }
  }

  go(tab: Tab) {
    this.message.set('');
    this.router.navigate([], { queryParams: { aba: tab === 'pedidos' ? null : tab }, replaceUrl: true });
  }

  private say(text: string, error = false) {
    this.message.set(text);
    this.isError.set(error);
  }

  private async run(fn: () => Promise<unknown>, ok: string) {
    this.busy.set(true);
    try {
      await fn();
      this.say(ok);
      await this.load();
      return true;
    } catch (e) {
      this.say(errorMessage(e), true);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  // ----- requests -----
  /** The API's groups first, then the others. */
  groupsFor(r: AccessRequest) {
    const own = new Set(r.apiGroups || []);
    return [...this.groups().filter((g) => own.has(g.id)), ...this.groups().filter((g) => !own.has(g.id))];
  }
  approve(r: AccessRequest) {
    const g = r.apiId ? this.groups().find((x) => x.id === this.choice[r.id]) : null;
    this.run(() => this.access.approve(r.id, r.apiId ? this.choice[r.id] : null), `${r.user?.name} agora faz parte do grupo “${g?.name ?? r.group?.name}” e recebeu um e-mail avisando.`);
  }
  reject(r: AccessRequest) {
    const note = prompt('Motivo da recusa (opcional, a pessoa vê em Minha conta):') ?? null;
    if (note === null) return;
    this.run(() => this.access.reject(r.id, note), note ? 'Pedido recusado. A pessoa recebeu um e-mail com o motivo.' : 'Pedido recusado. A pessoa recebeu um e-mail avisando.');
  }

  // ----- people -----
  visibleUsers() {
    const f = this.filter.trim().toLowerCase();
    return this.users().filter((u) => !f || `${u.name} ${u.email}`.toLowerCase().includes(f));
  }
  groupNames(u: AdminAccount) {
    return u.groups.map((g) => g.name).join(', ');
  }
  newPerson() {
    this.person.set({ id: null, name: '', email: '', password: '', role: 'consumer', groups: [], disabled: false });
  }
  editPerson(u: AdminAccount) {
    this.person.set({ id: u.id, name: u.name, email: u.email, password: '', role: u.role, groups: u.groups.map((g) => g.id), disabled: u.disabled });
  }
  toggle(list: string[], id: string) {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else list.push(id);
  }
  async savePerson(p: PersonForm) {
    const ok = await this.run(
      () =>
        p.id
          ? this.access.updateUser(p.id, { name: p.name, email: p.email, role: p.role, groups: p.groups, disabled: p.disabled, ...(p.password ? { password: p.password } : {}) })
          : this.access.createUser({ name: p.name, email: p.email, password: p.password, role: p.role, groups: p.groups }),
      p.id ? `“${p.name}” atualizada.` : this.auth.options().password ? `“${p.name}” criada. Passe a senha inicial para a pessoa.` : `“${p.name}” criada. Ela já pode entrar pelo login da organização.`
    );
    if (ok) {
      this.person.set(null);
      if (p.id === this.auth.current()?.id) this.auth.refreshMe();
    }
  }
  async endSessions(p: PersonForm) {
    if (!confirm(`Encerrar as sessões de “${p.name}”? A pessoa precisará entrar de novo em todos os dispositivos.`)) return;
    await this.run(() => this.access.endSessions(p.id!), `Sessões de “${p.name}” encerradas.`);
  }

  async removePerson(p: PersonForm) {
    if (!confirm(`Excluir a conta de “${p.name}”? Os pedidos dela também saem.`)) return;
    if (await this.run(() => this.access.removeUser(p.id!), `Conta de “${p.name}” excluída.`)) this.person.set(null);
  }

  // ----- groups -----
  apisOf(g: Group) {
    return this.catalog
      .apis()
      .filter((a) => a.visibility === 'private' && a.groups?.includes(g.id))
      .map((a) => a.name)
      .join(', ');
  }
  newGroup() {
    this.group.set({ id: null, name: '', description: '', requestable: true });
  }
  editGroup(g: Group) {
    this.group.set({ id: g.id, name: g.name, description: g.description, requestable: g.requestable });
  }
  async saveGroup(g: GroupForm) {
    if (await this.run(() => this.access.saveGroup(g.id, g), `Grupo “${g.name}” salvo.`)) this.group.set(null);
  }
  async removeGroup(g: GroupForm) {
    if (!confirm(`Excluir o grupo “${g.name}”? Quem está nele perde o acesso às APIs que dependem dele.`)) return;
    if (await this.run(() => this.access.removeGroup(g.id!), `Grupo “${g.name}” excluído.`)) this.group.set(null);
  }

  date(iso: string) {
    return new Date(iso).toLocaleDateString('pt-BR');
  }
}

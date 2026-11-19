import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CatalogService, errorMessage } from '../../core/catalog.service';
import { Api } from '../../core/models';
import { ConsumerSystem, routeKey, SystemInput, SystemSuggestion } from '../../core/systems';
import { SystemsService } from '../../core/systems.service';
import { AppDialog } from '../../shared/dialog';
import { ArrowKeys } from '../../shared/arrow-keys';

type Tab = 'sistemas' | 'mapa' | 'sugestoes';

/** Form state: per API, whether it's used and, optionally, which routes ("METHOD /path"). */
interface SystemForm {
  id: string | null;
  name: string;
  owner: string;
  contactEmail: string;
  description: string;
  uses: Record<string, { on: boolean; pick: boolean; routes: Record<string, boolean> }>;
}

interface MapNode {
  id: string;
  label: string;
  title: string;
  x: number;
  y: number;
}

const NODE_W = 230;
const NODE_H = 34;
const GAP = 12;
const MAP_W = 760;

/** /admin/sistemas: consumer systems, the dependency map and suggestions (PRO-166). */
@Component({
  selector: 'app-systems',
  imports: [FormsModule, RouterLink, AppDialog, ArrowKeys],
  template: `
    <div class="container page">
      <div class="row head">
        <div>
          <a routerLink="/admin" class="small">← Voltar ao painel</a>
          <h1>Sistemas consumidores</h1>
          <p class="muted">Quem usa cada API. Antes de mudar uma API, veja quem depende dela e a quem avisar.</p>
        </div>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" (click)="newSystem()">+ Novo sistema</button>
      </div>

      <div class="tabs" appArrowKeys role="tablist" aria-label="Visão">
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'sistemas'" [class.on]="tab() === 'sistemas'" (click)="tab.set('sistemas')">Sistemas ({{ systems().length }})</button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'mapa'" [class.on]="tab() === 'mapa'" (click)="tab.set('mapa')">Mapa</button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'sugestoes'" [class.on]="tab() === 'sugestoes'" (click)="tab.set('sugestoes')">
          Sugestões @if (suggestions().length) { <span class="count">{{ suggestions().length }}</span> }
        </button>
      </div>

      @if (message()) { <div class="alert" [class.alert-ok]="!isError()" [class.alert-error]="isError()" role="status">{{ message() }}</div> }

      @switch (tab()) {
        @case ('sistemas') {
          <div class="card table-wrap">
            <table class="table">
              <thead><tr><th>Sistema</th><th>Time e contato</th><th>APIs que usa</th><th class="right">Ações</th></tr></thead>
              <tbody>
                @for (s of systems(); track s.id) {
                  <tr>
                    <td><strong>{{ s.name }}</strong>@if (s.description) { <div class="small muted">{{ s.description }}</div> }</td>
                    <td class="small">{{ s.owner || '—' }}@if (s.contactEmail) { <div><a [href]="'mailto:' + s.contactEmail">{{ s.contactEmail }}</a></div> }</td>
                    <td class="small">
                      @for (u of s.uses; track u.apiId) {
                        <div>{{ apiName(u.apiId) }} <span class="muted">· {{ u.routes.length ? u.routes.length + (u.routes.length === 1 ? ' rota' : ' rotas') : 'API inteira' }}</span></div>
                      }
                    </td>
                    <td class="right actions"><button class="btn btn-sm" type="button" (click)="edit(s)">Editar</button></td>
                  </tr>
                } @empty {
                  <tr><td colspan="4" class="empty">Nenhum sistema cadastrado. Comece pelas <button type="button" class="linkish" (click)="tab.set('sugestoes')">sugestões dos pedidos de acesso</button> ou por “+ Novo sistema”.</td></tr>
                }
              </tbody>
            </table>
          </div>
        }

        @case ('mapa') {
          <div class="card map-card">
            @if (map().links.length) {
              <p class="small muted legend">
                <span class="key"><svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4" class="link" /></svg> API inteira</span>
                <span class="key"><svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4" class="link partial" /></svg> algumas rotas</span>
                · Passe o mouse ou o foco num sistema ou numa API para destacar as ligações.
              </p>
              <div class="map-scroll">
                <svg class="map" [attr.viewBox]="'0 0 ' + mapW + ' ' + map().height" [attr.width]="mapW" [attr.height]="map().height" role="img"
                     [attr.aria-label]="'Mapa de dependências: ' + map().systems.length + ' sistemas ligados a ' + map().apis.length + ' APIs. A lista completa está na aba Sistemas.'">
                  <text class="col-title" x="0" y="14">Sistemas</text>
                  <text class="col-title" [attr.x]="mapW - nodeW" y="14">APIs</text>
                  @for (l of map().links; track l.key) {
                    <path class="link" [class.partial]="l.partial" [class.hot]="isHot(l.system, l.api)" [class.dim]="hot() && !isHot(l.system, l.api)"
                          [attr.d]="l.d"><title>{{ l.title }}</title></path>
                  }
                  @for (n of map().systems; track n.id) {
                    <g class="node sys" [class.dim]="hot() && !isHot(n.id, null)" tabindex="0" [attr.aria-label]="n.title"
                       (mouseenter)="hot.set(n.id)" (mouseleave)="hot.set(null)" (focus)="hot.set(n.id)" (blur)="hot.set(null)">
                      <title>{{ n.title }}</title>
                      <rect [attr.x]="n.x" [attr.y]="n.y" [attr.width]="nodeW" [attr.height]="nodeH" rx="8" />
                      <text [attr.x]="n.x + 12" [attr.y]="n.y + nodeH / 2 + 4">{{ n.label }}</text>
                    </g>
                  }
                  @for (n of map().apis; track n.id) {
                    <g class="node api" [class.dim]="hot() && !isHot(null, n.id)" tabindex="0" [attr.aria-label]="n.title"
                       (mouseenter)="hot.set(n.id)" (mouseleave)="hot.set(null)" (focus)="hot.set(n.id)" (blur)="hot.set(null)">
                      <title>{{ n.title }}</title>
                      <rect [attr.x]="n.x" [attr.y]="n.y" [attr.width]="nodeW" [attr.height]="nodeH" rx="8" />
                      <text [attr.x]="n.x + 12" [attr.y]="n.y + nodeH / 2 + 4">{{ n.label }}</text>
                    </g>
                  }
                </svg>
              </div>
              @if (map().unused.length) {
                <p class="small muted">Sem nenhum sistema cadastrado: {{ map().unused.join(', ') }}.</p>
              }
            } @else {
              <p class="empty">O mapa aparece quando houver sistemas cadastrados.</p>
            }
          </div>
        }

        @case ('sugestoes') {
          <p class="muted small">Pedidos de acesso aprovados cuja pessoa ainda não está ligada a um sistema que usa a API. Cada um pode virar um sistema cadastrado.</p>
          <ul class="suggestions">
            @for (s of suggestions(); track s.requestId) {
              <li class="card suggestion">
                <div>
                  <strong>{{ s.person.name }}</strong> <span class="small muted">· {{ s.person.email }} · aprovado em {{ date(s.decidedAt) }}</span>
                  <div class="small">Acesso a {{ apiNames(s) }}</div>
                  @if (s.message) { <div class="small muted">“{{ s.message }}”</div> }
                </div>
                <button class="btn btn-sm" type="button" (click)="fromSuggestion(s)">Cadastrar sistema</button>
              </li>
            } @empty {
              <li class="empty muted">Nenhuma sugestão: todo acesso aprovado já está ligado a um sistema.</li>
            }
          </ul>
        }
      }
    </div>

    @if (form(); as f) {
      <div class="backdrop" (click)="form.set(null)">
        <div class="card dialog dialog-wide" appDialog (dismiss)="form.set(null)" role="dialog" aria-modal="true" aria-labelledby="sys-title" (click)="$event.stopPropagation()">
          <form class="dialog-form" (ngSubmit)="save(f)">
          <h2 id="sys-title">{{ f.id ? 'Editar sistema' : 'Novo sistema' }}</h2>
          <div class="grid-2">
            <div class="field"><label for="s-name">Nome do sistema</label><input id="s-name" name="name" [(ngModel)]="f.name" required maxlength="120" placeholder="Ex.: Sistema de Protocolo" /></div>
            <div class="field"><label for="s-owner">Time responsável</label><input id="s-owner" name="owner" [(ngModel)]="f.owner" maxlength="120" /></div>
            <div class="field"><label for="s-email">E-mail de contato</label><input id="s-email" name="email" type="email" [(ngModel)]="f.contactEmail" maxlength="254" /></div>
            <div class="field"><label for="s-desc">O que o sistema faz (opcional)</label><input id="s-desc" name="desc" [(ngModel)]="f.description" maxlength="500" /></div>
          </div>
          <fieldset class="apis">
            <legend>APIs que o sistema usa</legend>
            <p class="hint">Marque as rotas quando souber: assim, só as mudanças nessas rotas contam como risco para o sistema.</p>
            @for (a of catalog.apis(); track a.id) {
              @if (f.uses[a.id] ?? addUse(f, a.id); as u) {
              <div class="api-use">
                <label class="check"><input type="checkbox" [name]="'use-' + a.id" [(ngModel)]="u.on" /> <strong>{{ a.name }}</strong></label>
                @if (u.on && a.endpoints.length) {
                  <label class="check small sub"><input type="checkbox" [name]="'pick-' + a.id" [(ngModel)]="u.pick" /> Usa só algumas rotas</label>
                  @if (u.pick) {
                    <div class="routes">
                      @for (e of a.endpoints; track routeOf(e)) {
                        <label class="check small"><input type="checkbox" [name]="'r-' + a.id + routeOf(e)" [(ngModel)]="u.routes[routeOf(e)]" /> <code>{{ routeOf(e) }}</code> <span class="muted">{{ e.summary }}</span></label>
                      }
                    </div>
                  }
                }
              </div>
              }
            }
          </fieldset>
          <div class="row end">
            @if (f.id) {
              <button class="btn btn-danger" type="button" (click)="remove(f)" [disabled]="busy()">Excluir</button>
              <span class="spacer"></span>
            }
            <button class="btn" type="button" (click)="form.set(null)">Cancelar</button>
            <button class="btn btn-primary" type="submit" [disabled]="busy() || !f.name.trim()">Salvar</button>
          </div>
          </form>
        </div>
      </div>
    }
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); padding-bottom: 64px; display: flex; flex-direction: column; gap: 18px; }
    .head h1 { margin: 4px 0 0; }
    .head p { margin: 4px 0 0; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 14px; font: inherit; font-weight: 600; color: var(--text-2); cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
    .tabs button.on { color: var(--text); border-bottom-color: var(--brand); }
    .count { background: var(--danger); color: #fff; border-radius: 999px; font-size: 0.72rem; padding: 1px 7px; }
    .right { text-align: right; }
    .actions { white-space: nowrap; }
    .empty { text-align: center; padding: 24px; color: var(--text-3); }
    .linkish { background: none; border: 0; padding: 0; font: inherit; color: var(--link); cursor: pointer; text-decoration: underline; }
    .map-card { padding: 18px; display: flex; flex-direction: column; gap: 10px; }
    .legend { margin: 0; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .key { display: inline-flex; gap: 6px; align-items: center; }
    .map-scroll { overflow-x: auto; }
    .map { display: block; max-width: none; }
    .col-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; fill: var(--text-3); }
    .link { fill: none; stroke: var(--border-strong); stroke-width: 1.6; transition: stroke 0.15s, opacity 0.15s; }
    .link.partial { stroke-dasharray: 5 4; }
    .link.hot { stroke: var(--accent); stroke-width: 2.4; }
    .link.dim, .node.dim { opacity: 0.25; }
    .node { cursor: default; outline: none; transition: opacity 0.15s; }
    .node rect { stroke-width: 1.4; }
    .node.sys rect { fill: var(--brand-soft); stroke: var(--brand); }
    .node.api rect { fill: var(--surface-2); stroke: var(--border-strong); }
    .node text { font-size: 13px; font-weight: 600; fill: var(--text); }
    .node:focus-visible rect { stroke: var(--accent); stroke-width: 3; }
    .suggestions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .suggestion { display: flex; gap: 14px; justify-content: space-between; align-items: center; padding: 14px 18px; flex-wrap: wrap; }
    .backdrop { position: fixed; inset: 0; background: var(--overlay); display: grid; place-items: center; padding: 16px; z-index: 50; overflow-y: auto; }
    .dialog { max-width: 680px; width: 100%; padding: 24px; max-height: calc(100vh - 32px); overflow: auto; }
    .dialog-form { display: flex; flex-direction: column; gap: 14px; }
    .dialog h2 { margin: 0; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .apis { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; margin: 0; display: flex; flex-direction: column; gap: 8px; }
    .apis legend { font-weight: 600; padding: 0 4px; }
    .apis .hint { margin: 0; }
    .api-use { display: flex; flex-direction: column; gap: 4px; }
    .sub { margin-left: 24px; }
    .routes { margin-left: 48px; display: flex; flex-direction: column; gap: 4px; }
    .routes code { font-size: 0.8rem; }
  `,
})
export class Systems implements OnInit {
  catalog = inject(CatalogService);
  private service = inject(SystemsService);

  readonly mapW = MAP_W;
  readonly nodeW = NODE_W;
  readonly nodeH = NODE_H;

  tab = signal<Tab>('sistemas');
  systems = signal<ConsumerSystem[]>([]);
  suggestions = signal<SystemSuggestion[]>([]);
  form = signal<SystemForm | null>(null);
  busy = signal(false);
  message = signal('');
  isError = signal(false);
  /** Node being pointed at in the map (system or API id). */
  hot = signal<string | null>(null);

  private apisById = computed(() => new Map(this.catalog.apis().map((a) => [a.id, a])));

  /** Two columns, systems on the left and the APIs they use on the right, with a curve per link. */
  map = computed(() => {
    const systems = this.systems();
    const usedIds = [...new Set(systems.flatMap((s) => s.uses.map((u) => u.apiId)))];
    const apis = usedIds.map((id) => this.apisById().get(id)).filter((a): a is Api => !!a).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    const top = 28;
    const rows = Math.max(systems.length, apis.length, 1);
    const height = top + rows * (NODE_H + GAP);
    const column = (count: number) => (i: number) => top + ((rows - count) * (NODE_H + GAP)) / 2 + i * (NODE_H + GAP);
    const sysY = column(systems.length);
    const apiY = column(apis.length);
    const short = (s: string) => (s.length > 28 ? s.slice(0, 27) + '…' : s);
    const sysNodes: MapNode[] = systems.map((s, i) => ({
      id: s.id,
      label: short(s.name),
      title: `${s.name}: usa ${s.uses.map((u) => this.apiName(u.apiId)).join(', ')}`,
      x: 0,
      y: sysY(i),
    }));
    const apiNodes: MapNode[] = apis.map((a, i) => {
      const users = systems.filter((s) => s.uses.some((u) => u.apiId === a.id)).map((s) => s.name);
      return { id: a.id, label: short(a.name), title: `${a.name}: usada por ${users.join(', ')}`, x: MAP_W - NODE_W, y: apiY(i) };
    });
    const apiPos = new Map(apiNodes.map((n) => [n.id, n]));
    const links = systems.flatMap((s, i) =>
      s.uses
        .filter((u) => apiPos.has(u.apiId))
        .map((u) => {
          const from = sysNodes[i];
          const to = apiPos.get(u.apiId)!;
          const x1 = from.x + NODE_W;
          const y1 = from.y + NODE_H / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return {
            key: `${s.id}>${u.apiId}`,
            system: s.id,
            api: u.apiId,
            partial: u.routes.length > 0,
            d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
            title: `${s.name} → ${this.apiName(u.apiId)}${u.routes.length ? ` (${u.routes.join(', ')})` : ' (API inteira)'}`,
          };
        })
    );
    const unused = this.catalog.apis().filter((a) => !usedIds.includes(a.id)).map((a) => a.name);
    return { systems: sysNodes, apis: apiNodes, links, height, unused };
  });

  async ngOnInit() {
    this.catalog.refresh();
    await this.load();
  }

  private async load() {
    try {
      const [systems, suggestions] = await Promise.all([this.service.list(), this.service.suggestions()]);
      this.systems.set(systems);
      this.suggestions.set(suggestions);
    } catch (e) {
      this.say(errorMessage(e), true);
    }
  }

  /** Lit when the link touches the node being pointed at. */
  isHot(system: string | null, api: string | null) {
    const h = this.hot();
    if (!h) return false;
    if (system && api) return h === system || h === api;
    if (system) return h === system || this.systems().find((s) => s.id === system)?.uses.some((u) => u.apiId === h) === true;
    return h === api || this.systems().find((s) => s.id === h)?.uses.some((u) => u.apiId === api) === true;
  }

  apiName(id: string) {
    return this.apisById().get(id)?.name ?? 'API removida';
  }

  apiNames(s: SystemSuggestion) {
    return s.apis.map((a) => a.name).join(', ');
  }

  routeOf = routeKey;

  private blankUses(selected: { apiId: string; routes: string[] }[] = []): SystemForm['uses'] {
    const byApi = new Map(selected.map((u) => [u.apiId, u.routes]));
    return Object.fromEntries(
      this.catalog.apis().map((a) => {
        const routes = byApi.get(a.id) ?? [];
        return [a.id, { on: byApi.has(a.id), pick: routes.length > 0, routes: Object.fromEntries(routes.map((r) => [r, true])) }];
      })
    );
  }

  /** An API that arrived after the form opened (catalog still loading). */
  addUse(f: SystemForm, apiId: string) {
    return (f.uses[apiId] = { on: false, pick: false, routes: {} });
  }

  newSystem() {
    this.form.set({ id: null, name: '', owner: '', contactEmail: '', description: '', uses: this.blankUses() });
  }

  edit(s: ConsumerSystem) {
    this.form.set({ id: s.id, name: s.name, owner: s.owner, contactEmail: s.contactEmail, description: s.description, uses: this.blankUses(s.uses) });
  }

  /** The approved request fills the contact, the APIs and, as description, what the person wrote. */
  fromSuggestion(s: SystemSuggestion) {
    this.form.set({
      id: null,
      name: '',
      owner: '',
      contactEmail: s.person.email,
      description: s.message,
      uses: this.blankUses(s.apis.map((a) => ({ apiId: a.id, routes: [] }))),
    });
  }

  async save(f: SystemForm) {
    const input: SystemInput = {
      name: f.name,
      owner: f.owner,
      contactEmail: f.contactEmail,
      description: f.description,
      uses: Object.entries(f.uses)
        .filter(([, u]) => u.on)
        .map(([apiId, u]) => ({ apiId, routes: u.pick ? Object.keys(u.routes).filter((r) => u.routes[r]) : [] })),
    };
    this.busy.set(true);
    try {
      const saved = await this.service.save(f.id, input);
      this.form.set(null);
      this.say(`Sistema “${saved.name}” salvo.`);
      await this.load();
    } catch (e) {
      this.say(errorMessage(e), true);
    } finally {
      this.busy.set(false);
    }
  }

  async remove(f: SystemForm) {
    if (!f.id || !confirm(`Excluir o sistema “${f.name}”? As ligações dele com as APIs saem do mapa.`)) return;
    this.busy.set(true);
    try {
      await this.service.remove(f.id);
      this.form.set(null);
      this.say(`Sistema “${f.name}” excluído.`);
      await this.load();
    } catch (e) {
      this.say(errorMessage(e), true);
    } finally {
      this.busy.set(false);
    }
  }

  private say(text: string, error = false) {
    this.message.set(text);
    this.isError.set(error);
  }

  date(iso: string) {
    return new Date(iso).toLocaleDateString('pt-BR');
  }
}

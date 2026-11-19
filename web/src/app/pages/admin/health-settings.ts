import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiInput, errorMessage } from '../../core/catalog.service';
import { apiSchemes } from '../../core/models';
import { SyncAuthType, SyncConfig } from '../../core/spec-sync';
import { HEALTH_LABELS, HealthStatus } from '../../core/status.service';
import { SpecAuthFields } from './spec-auth-fields';

interface HealthAdmin {
  monitored: boolean;
  intervalSeconds: number;
  baseUrl?: string;
  path?: string;
  authType?: SyncAuthType;
  headerName?: string;
  paramName?: string;
  username?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  hasSecret?: boolean;
  current?: { status: HealthStatus; since: string; latencyMs: number | null; httpStatus: number | null; lastCheckedAt: string; lastError: string } | null;
}

/** "Monitoramento" section of the API form: which route checks the API's health, and how. */
@Component({
  selector: 'app-health-settings',
  imports: [FormsModule, SpecAuthFields],
  template: `
    <p class="hint">
      O catálogo chama esta rota a cada {{ (state()?.intervalSeconds ?? 60) === 60 ? 'minuto' : (state()?.intervalSeconds ?? 60) + ' s' }} e mostra o resultado na página
      <a href="/status" target="_blank">Status</a>. Sem rota, a API aparece como "sem monitoramento".
    </p>
    <div class="grid-2">
      <div class="field">
        <label for="h-env">Ambiente</label>
        <select id="h-env" [(ngModel)]="form.baseUrl">
          @for (e of envs(); track e.url) { <option [value]="e.url">{{ e.name }} — {{ e.url }}</option> }
        </select>
      </div>
      <div class="field">
        <label for="h-path">Rota de saúde</label>
        <input id="h-path" class="mono" [(ngModel)]="form.path" placeholder="/health" list="h-paths" />
        <datalist id="h-paths">@for (p of getPaths(); track p) { <option [value]="p"></option> }</datalist>
        <span class="hint">Deixe em branco para desligar o monitoramento.</span>
      </div>
    </div>
    <app-spec-auth-fields [config]="form" p="h-" [showUrl]="false" authLabel="Credencial da verificação" [storedSecret]="keepsSecret()" />
    <div class="row">
      <button class="btn" type="button" (click)="save()" [disabled]="busy()">{{ busy() === 'save' ? 'Salvando…' : 'Salvar e verificar' }}</button>
      <button class="btn" type="button" (click)="checkNow()" [disabled]="busy() || !state()?.monitored">{{ busy() === 'check' ? 'Verificando…' : 'Verificar agora' }}</button>
      @if (state()?.current; as c) {
        <span class="result" [class]="'result ' + c.status">● {{ labels[c.status] }}</span>
        <span class="hint">
          {{ c.httpStatus ? 'HTTP ' + c.httpStatus + ' · ' : '' }}{{ c.latencyMs != null ? c.latencyMs + ' ms · ' : '' }}às {{ time(c.lastCheckedAt) }}
        </span>
      }
    </div>
    @if (state()?.current?.lastError; as err) { <div class="alert alert-warn small">{{ err }}</div> }
    @if (error()) { <div class="alert alert-error small" role="alert">{{ error() }}</div> }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 14px; }
    .hint { font-size: 0.82rem; color: var(--text-3); margin: 0; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
    .mono { font-family: var(--mono); font-size: 0.85rem; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .result { font-weight: 600; font-size: 0.88rem; }
    .result.up { color: var(--ok); }
    .result.degraded { color: var(--warn); }
    .result.down { color: var(--danger); }
  `,
})
export class HealthSettings implements OnInit {
  private http = inject(HttpClient);
  apiId = input.required<string>();
  api = input.required<ApiInput>();

  state = signal<HealthAdmin | null>(null);
  busy = signal<'' | 'save' | 'check'>('');
  error = signal('');
  labels = HEALTH_LABELS;
  form: SyncConfig & { baseUrl: string; path: string } = { ...blank(), baseUrl: '', path: '' };

  envs = computed(() => {
    const a = this.api();
    return a.environments.length ? a.environments : [{ name: 'Padrão', url: a.baseUrl }];
  });

  async ngOnInit() {
    try {
      this.apply(await firstValueFrom(this.http.get<HealthAdmin>(`/api/apis/${this.apiId()}/health`)));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  /** GET routes of the API, health-looking ones first. */
  getPaths() {
    const paths = this.api().endpoints.filter((e) => e.method === 'GET' && !e.path.includes('{')).map((e) => e.path);
    return paths.sort((a, b) => Number(!/health|status|ping/i.test(a)) - Number(!/health|status|ping/i.test(b)));
  }

  keepsSecret() {
    const s = this.state();
    return !!s?.hasSecret && s.authType === this.form.authType;
  }

  private apply(s: HealthAdmin) {
    this.state.set(s);
    if (s.monitored) {
      this.form = {
        ...blank(),
        baseUrl: s.baseUrl ?? '',
        path: s.path ?? '',
        authType: s.authType ?? 'none',
        headerName: s.headerName ?? '',
        paramName: s.paramName ?? '',
        username: s.username ?? '',
        tokenUrl: s.tokenUrl ?? '',
        clientId: s.clientId ?? '',
        scope: s.scope ?? '',
      };
      return;
    }
    // Not monitored yet: suggest the first environment, a health route and the API's own key header.
    const key = apiSchemes(this.api()).find((sc) => sc.type === 'apiKey' && sc.in === 'header');
    this.form = {
      ...blank(),
      baseUrl: this.envs()[0]?.url ?? '',
      path: this.getPaths().find((p) => /health|status|ping/i.test(p)) ?? '',
      authType: key ? 'header' : 'none',
      headerName: key?.name ?? '',
    };
  }

  async save() {
    this.error.set('');
    this.busy.set('save');
    try {
      this.apply(await firstValueFrom(this.http.put<HealthAdmin>(`/api/apis/${this.apiId()}/health`, this.form)));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set('');
    }
  }

  async checkNow() {
    this.error.set('');
    this.busy.set('check');
    try {
      this.apply(await firstValueFrom(this.http.post<HealthAdmin>(`/api/apis/${this.apiId()}/health/check`, {})));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set('');
    }
  }

  time(iso: string) {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}

function blank(): SyncConfig {
  return { url: '', authType: 'none', headerName: '', paramName: '', username: '', tokenUrl: '', clientId: '', scope: '', secret: '', clearSecret: false };
}

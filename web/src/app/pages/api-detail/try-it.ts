import { HttpClient } from '@angular/common/http';
import { ArrowKeys } from '../../shared/arrow-keys';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/catalog.service';
import { ConsoleSession, ConsoleSessionInfo } from '../../core/console-session';
import { Api, AuthScheme, Endpoint, endpointSchemes, SCHEME_LABELS, schemeWire, sessionFlow } from '../../core/models';
import { hasBody } from '../../core/snippets';
import { ToastService } from '../../shared/toast';

type Mode = 'real' | 'simulacao';

interface SendResult {
  status: number;
  statusText: string;
  ms: number;
  body: string;
  headers: Record<string, string>;
  truncated: boolean;
}

interface LoginField {
  name: string;
  secret: boolean;
  /** Type of the documented example, so numbers/booleans are sent as such. */
  kind: 'string' | 'number' | 'boolean';
}

interface TryResult {
  status: number;
  statusText: string;
  ms: number;
  body: string;
  headers: [string, string][];
  simulated: boolean;
  truncated?: boolean;
}

/** Hosts reserved for documentation/testing (RFC 2606): they never resolve. */
const PLACEHOLDER_HOST = /\.(example|test|invalid)$|^example\.(com|org|net)$/i;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error',
};

/**
 * "Testar este endpoint" console.
 * - Real: the request goes through our server (/api/console/send), so browser CORS rules don't block it.
 * - Simulação: answers with the example response documented for the endpoint.
 */
@Component({
  selector: 'app-try-it',
  imports: [ArrowKeys, FormsModule],
  template: `
    <div class="try card">
      <div class="mode" appArrowKeys role="radiogroup" aria-label="Modo do console">
        <button type="button" role="radio" [attr.aria-checked]="mode() === 'real'" [class.on]="mode() === 'real'" (click)="setMode('real')">Chamada real</button>
        <button type="button" role="radio" [attr.aria-checked]="mode() === 'simulacao'" [class.on]="mode() === 'simulacao'" (click)="setMode('simulacao')">Simulação</button>
        <span class="mode-hint small muted">
          {{ mode() === 'real' ? 'Envia a requisição de verdade, pelo servidor do catálogo.' : 'Responde com o exemplo documentado, sem chamar a API.' }}
        </span>
      </div>
      @if (placeholder() && mode() === 'real') {
        <div class="alert alert-warn small">A URL desta API é de exemplo ({{ host() }}) e não existe. Use o modo <strong>Simulação</strong> ou cadastre a URL real no painel admin.</div>
      }

      <div class="grid">
        @if (mode() === 'real') {
          <div class="field">
            <label [for]="id('env')">Ambiente</label>
            <select [id]="id('env')" [ngModel]="baseUrl()" (ngModelChange)="baseUrl.set($event)">
              @for (e of envs(); track e.url) {
                <option [value]="e.url">{{ e.name }} — {{ e.url }}</option>
              }
            </select>
          </div>
        }
      </div>

      @if (mode() === 'real' && options().length) {
        <fieldset class="creds">
          <legend>
            Credenciais
            <span class="muted small">· ficam só na memória desta aba</span>
          </legend>
          @if (isAny()) {
            <div class="field">
              <label [for]="id('opt')">Autenticar com</label>
              <select [id]="id('opt')" [ngModel]="chosen()" (ngModelChange)="chosen.set($event)">
                @for (o of options(); track o.key; let i = $index) {
                  <option [value]="i">{{ wireName(o) }} · {{ schemeLabels[o.type] }}</option>
                }
              </select>
            </div>
          }
          <div class="grid">
            @for (sc of activeSchemes(); track sc.key) {
              @if (sc.type === 'basic') {
                <div class="field">
                  <label [for]="id('u' + sc.key)">Usuário <span class="muted">(Basic)</span></label>
                  <input [id]="id('u' + sc.key)" [ngModel]="cred(sc.key + ':user')" (ngModelChange)="setCred(sc.key + ':user', $event)" autocomplete="off" />
                </div>
                <div class="field">
                  <label [for]="id('p' + sc.key)">Senha <span class="muted">(Basic)</span></label>
                  <input [id]="id('p' + sc.key)" type="password" [ngModel]="cred(sc.key + ':pass')" (ngModelChange)="setCred(sc.key + ':pass', $event)" autocomplete="off" />
                </div>
              } @else {
                <div class="field">
                  <label [for]="id('c' + sc.key)">
                    <code>{{ wireName(sc) }}</code>&nbsp;
                    <span class="muted">({{ sc.type === 'apiKey' ? where(sc) : sc.type === 'oauth2' ? 'token OAuth' : 'token' }})</span>
                  </label>
                  <input [id]="id('c' + sc.key)" type="password" [ngModel]="cred(sc.key)" (ngModelChange)="setCred(sc.key, $event)" autocomplete="off"
                         [placeholder]="sc.type === 'apiKey' ? (sc.example || 'valor') : 'sem o prefixo Bearer'" />
                  @if (sc.description) { <span class="hint">{{ sc.description }}</span> }
                  @if (flowOf(sc); as f) {
                    <div class="session small">
                      @if (sessionOf(sc); as s) {
                        <span class="ok">● Sessão ativa</span>
                        <span class="muted">{{ expiryText(s) }}</span>
                        <button class="btn btn-sm" type="button" (click)="logout(sc)" [disabled]="sessionBusy()">
                          {{ sessionBusy() ? 'Encerrando…' : 'Encerrar sessão' }}
                        </button>
                      } @else {
                        <button class="btn btn-sm" type="button" (click)="openLogin(sc)" [disabled]="loginFor() === sc.key">Criar sessão</button>
                        <span class="muted">preenche o token com <code>{{ f.login.method }} {{ f.login.path }}</code></span>
                      }
                    </div>
                  }
                </div>
              }
            }
          </div>
          @if (expired()) {
            <div class="alert alert-warn small">A sessão expirou. Crie uma nova para continuar testando.</div>
          }
          @if (loginScheme(); as sc) {
            <form class="login" (ngSubmit)="login(sc)" autocomplete="off">
              <p class="small">
                Criar sessão em <code>{{ flowOf(sc)?.login?.method }} {{ flowOf(sc)?.login?.path }}</code>.
                <span class="muted">Estes dados vão só nesta chamada e não são guardados.</span>
              </p>
              <div class="grid">
                @for (f of loginFields(); track f.name) {
                  <div class="field">
                    <label [for]="id('login-' + f.name)">{{ f.name }}</label>
                    <input [id]="id('login-' + f.name)" [name]="f.name" [type]="f.secret ? 'password' : 'text'" [(ngModel)]="loginValues[f.name]" autocomplete="off" />
                  </div>
                }
              </div>
              <div class="row">
                <button class="btn btn-primary btn-sm" type="submit" [disabled]="sessionBusy()">{{ sessionBusy() ? 'Criando…' : 'Criar sessão' }}</button>
                <button class="btn btn-ghost btn-sm" type="button" (click)="closeLogin()">Cancelar</button>
              </div>
            </form>
          }
          @if (sessionError()) {
            <div class="alert alert-error small" role="alert">{{ sessionError() }}</div>
          }
          @if (sessionInfo()) {
            <div class="alert alert-ok small" role="status">{{ sessionInfo() }}</div>
          }
        </fieldset>
      } @else if (mode() === 'real' && publicEp()) {
        <p class="small muted">Este endpoint é público: não precisa de credencial.</p>
      }

      <div class="grid">
        @for (p of params(); track p.in + p.name) {
          <div class="field">
            <label [for]="id(p.in + p.name)">{{ p.name }} <span class="muted">({{ p.in }}{{ p.required ? ', obrigatório' : '' }})</span></label>
            <input [id]="id(p.in + p.name)" [(ngModel)]="values[p.in + ':' + p.name]" [placeholder]="p.example || p.type" />
          </div>
        }
      </div>
      @if (bodyAllowed()) {
        <div class="field">
          <div class="body-head">
            <label [for]="id('body')">Corpo (JSON)</label>
            <button class="btn btn-sm btn-ghost" type="button" (click)="copy(body, 'Corpo da requisição copiado')" [disabled]="!body.trim()">Copiar</button>
          </div>
          <textarea class="code" rows="6" [id]="id('body')" [(ngModel)]="body"></textarea>
        </div>
      }
      <div class="row">
        <button class="btn btn-primary" type="button" (click)="send()" [disabled]="sending()">
          {{ sending() ? 'Enviando…' : mode() === 'real' ? 'Enviar requisição' : 'Simular requisição' }}
        </button>
        <code class="req-line small">{{ endpoint().method }} {{ previewUrl() }}</code>
      </div>
      @if (error()) {
        <div class="alert alert-error" role="alert">{{ error() }}</div>
      }
      @if (result(); as r) {
        <div class="result" aria-live="polite">
          <div class="row small">
            <strong [class.ok]="r.status < 400" [class.bad]="r.status >= 400">{{ r.status }} {{ r.statusText }}</strong>
            <span class="muted">{{ r.ms }} ms</span>
            @if (r.simulated) { <span class="tag">Resposta simulada a partir da documentação</span> }
            @if (r.truncated) { <span class="tag">Corpo cortado em 1 MB</span> }
            <span class="spacer"></span>
            <button class="btn btn-sm btn-ghost" type="button" (click)="copy(r.body, 'Resposta copiada')">Copiar resposta</button>
          </div>
          @if (r.headers.length) {
            <details class="headers small">
              <summary>Cabeçalhos da resposta ({{ r.headers.length }})</summary>
              <dl>
                @for (h of r.headers; track h[0]) { <dt>{{ h[0] }}</dt><dd>{{ h[1] }}</dd> }
              </dl>
            </details>
          }
          <pre tabindex="0">{{ r.body }}</pre>
        </div>
      }
    </div>
  `,
  styles: `
    .try { padding: 16px; display: flex; flex-direction: column; gap: 14px; background: var(--surface-2); box-shadow: none; }
    .mode { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .mode button { border: 1px solid var(--border); background: var(--surface); color: var(--text-2); font: inherit; font-size: 0.82rem; font-weight: 600; padding: 6px 12px; border-radius: 999px; cursor: pointer; }
    .mode button.on { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
    .mode-hint { margin-left: 8px; }
    .creds { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px 14px; margin: 0; display: flex; flex-direction: column; gap: 10px; background: var(--surface); }
    .creds legend { font-weight: 600; font-size: 0.85rem; padding: 0 6px; }
    .creds code { font-size: 0.8rem; }
    .hint { font-size: 0.75rem; color: var(--text-3); }
    .session { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .session code { font-size: 0.75rem; }
    .login { border-top: 1px dashed var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 10px; }
    .login p { margin: 0; }
    .body-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .grid:empty { display: none; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .req-line { color: var(--text-2); word-break: break-all; }
    .result pre { background: var(--code-bg); color: var(--code-text); padding: 12px; border-radius: 8px; overflow: auto; max-height: 360px; margin: 8px 0 0; font-size: 0.78rem; }
    .headers { margin-top: 8px; }
    .headers summary { cursor: pointer; color: var(--text-2); }
    .headers dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 0; font-family: var(--mono); font-size: 0.75rem; }
    .headers dt { color: var(--text-3); }
    .headers dd { margin: 0; word-break: break-all; }
    .ok { color: var(--ok); }
    .bad { color: var(--danger); }
  `,
})
export class TryIt implements OnInit {
  private http = inject(HttpClient);
  private sessions = inject(ConsoleSession);
  private toast = inject(ToastService);
  api = input.required<Api>();
  endpoint = input.required<Endpoint>();

  mode = signal<Mode>('real');
  baseUrl = signal('');
  /** For APIs that accept one of several credentials: index of the chosen one. */
  chosen = signal(0);
  schemeLabels = SCHEME_LABELS;
  body = '';
  values: Record<string, string> = {};
  sending = signal(false);
  result = signal<TryResult | null>(null);
  error = signal('');
  /** Scheme key whose "Criar sessão" form is open. */
  loginFor = signal<string | null>(null);
  /** Typed in the session form; cleared after each attempt. */
  loginValues: Record<string, string> = {};
  sessionBusy = signal(false);
  sessionError = signal('');
  sessionInfo = signal('');

  envs = computed(() => {
    const a = this.api();
    return a.environments.length ? a.environments : [{ name: 'Padrão', url: a.baseUrl }];
  });
  host = computed(() => {
    try {
      return new URL(this.baseUrl() || this.api().baseUrl).hostname;
    } catch {
      return '';
    }
  });
  placeholder = computed(() => PLACEHOLDER_HOST.test(this.host()));
  params = computed(() => this.endpoint().parameters);
  bodyAllowed = computed(() => !['GET', 'DELETE'].includes(this.endpoint().method));
  private security = computed(() => endpointSchemes(this.api(), this.endpoint()));
  /** Credential options: every required one, or (for "any") each alternative. */
  options = computed(() => {
    const { required, alternatives } = this.security();
    return alternatives.length ? [...required, ...alternatives] : required;
  });
  isAny = computed(() => this.security().alternatives.length > 0);
  activeSchemes = computed<AuthScheme[]>(() => {
    const { required, alternatives } = this.security();
    return alternatives.length ? [this.options()[Number(this.chosen())] ?? required[0]] : required;
  });
  expired = computed(() => this.sessions.expired(this.api().id) && this.activeSchemes().some((s) => this.flowOf(s)));
  loginScheme = computed(() => this.activeSchemes().find((s) => s.key === this.loginFor()));
  /** Fields of the session request body, from its documented example. */
  loginFields = computed<LoginField[]>(() => {
    const sc = this.loginScheme();
    const ep = sc && this.flowOf(sc)?.login;
    let example: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(ep?.requestBody || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) example = parsed;
    } catch {
      /* no usable example */
    }
    const fields = Object.entries(example)
      .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
      .map(([name, v]) => ({
        name,
        secret: /senha|pass|secret|pin/i.test(name),
        kind: (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string') as LoginField['kind'],
      }));
    return fields.length ? fields : [{ name: 'usuario', secret: false, kind: 'string' }, { name: 'senha', secret: true, kind: 'string' }];
  });
  publicEp = computed(() => !this.options().length && (this.api().auth.schemes?.length || this.api().auth.type !== 'none'));

  ngOnInit() {
    const ep = this.endpoint();
    this.baseUrl.set(this.envs()[0].url);
    this.body = hasBody(ep) ? ep.requestBody : '';
    for (const p of ep.parameters) this.values[p.in + ':' + p.name] = p.example || '';
    // Example APIs can't be reached, so start them in simulation.
    if (this.envs().every((e) => PLACEHOLDER_HOST.test(safeHost(e.url)))) this.mode.set('simulacao');
  }

  setMode(mode: Mode) {
    this.mode.set(mode);
    this.result.set(null);
    this.error.set('');
  }

  id(suffix: string) {
    return `try-${this.endpoint().id ?? this.endpoint().path}-${suffix}`.replace(/[^\w-]/g, '_');
  }

  previewUrl() {
    return this.buildUrl().url;
  }

  wireName(s: AuthScheme) {
    return schemeWire(s).name;
  }

  where(s: AuthScheme) {
    return s.in === 'query' ? 'query' : s.in === 'cookie' ? 'cookie' : 'cabeçalho';
  }

  cred(key: string) {
    return this.sessions.cred(this.api().id, key);
  }

  setCred(key: string, value: string) {
    this.sessions.setCred(this.api().id, key, value);
  }

  flowOf(s: AuthScheme) {
    return sessionFlow(this.api(), s);
  }

  sessionOf(s: AuthScheme): ConsoleSessionInfo | null {
    const session = this.sessions.session(this.api().id);
    return session?.schemeKey === s.key ? session : null;
  }

  expiryText(s: ConsoleSessionInfo) {
    if (!s.expiresAt) return '· validade não informada pela API';
    const min = Math.max(0, Math.ceil((s.expiresAt - this.sessions.now()) / 60000));
    const at = new Date(s.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `· expira às ${at} (em ${min} min)`;
  }

  openLogin(s: AuthScheme) {
    this.loginValues = {};
    this.sessionError.set('');
    this.sessionInfo.set('');
    this.loginFor.set(s.key);
  }

  closeLogin() {
    this.loginValues = {};
    this.loginFor.set(null);
  }

  /** Calls the API's session route and puts the returned token in the bearer field. */
  async login(sc: AuthScheme) {
    const ep = this.flowOf(sc)?.login;
    if (!ep) return;
    this.sessionError.set('');
    this.sessionInfo.set('');
    const body: Record<string, unknown> = {};
    for (const f of this.loginFields()) {
      const v = (this.loginValues[f.name] ?? '').trim();
      if (!v) continue;
      body[f.name] = f.kind === 'number' && !isNaN(Number(v)) ? Number(v) : f.kind === 'boolean' ? v === 'true' : v;
    }
    // What was typed in the form is used for this call only.
    this.loginValues = {};
    const others = endpointSchemes(this.api(), ep).required.filter((s) => s.key !== sc.key);
    const missing = others.find((s) => !this.hasCred(s));
    if (missing) {
      this.sessionError.set(`Preencha ${this.wireName(missing)} antes de criar a sessão.`);
      return;
    }
    this.sessionBusy.set(true);
    try {
      const r = await this.call(ep, others, { 'Content-Type': 'application/json' }, JSON.stringify(body));
      const ok = r.status >= 200 && r.status < 300;
      if (ok && this.takeToken(sc, r.body)) {
        this.loginFor.set(null);
        this.sessionInfo.set('Sessão criada. O token vale para todos os endpoints desta API enquanto a aba estiver aberta.');
      } else if (ok) {
        this.sessionError.set('A API respondeu, mas sem o campo access_token.');
      } else {
        const msg = apiMessage(r.body);
        this.sessionError.set(`A API não criou a sessão (${r.status}${msg ? ': ' + msg : ''}).`);
      }
    } catch (e) {
      this.sessionError.set(errorMessage(e));
    } finally {
      this.sessionBusy.set(false);
    }
  }

  /** Calls the logout route (when there is one) and forgets the token. */
  async logout(sc: AuthScheme) {
    const ep = this.flowOf(sc)?.logout;
    const apiId = this.api().id;
    this.sessionError.set('');
    this.sessionInfo.set('');
    if (!ep) {
      this.sessions.end(apiId);
      this.sessionInfo.set('Token esquecido pelo console. Esta API não tem rota de logout cadastrada.');
      return;
    }
    this.sessionBusy.set(true);
    try {
      const r = await this.call(ep, endpointSchemes(this.api(), ep).required, {});
      this.sessionInfo.set(r.status < 300 ? 'Sessão encerrada.' : `Token esquecido pelo console. A API respondeu ${r.status} ao encerrar a sessão.`);
    } catch (e) {
      this.sessionInfo.set(`Token esquecido pelo console. Não foi possível avisar a API: ${errorMessage(e)}`);
    } finally {
      this.sessions.end(apiId);
      this.sessionBusy.set(false);
    }
  }

  private hasCred(s: AuthScheme) {
    return s.type === 'basic' ? !!(this.cred(s.key + ':user') || this.cred(s.key + ':pass')) : !!this.cred(s.key).trim();
  }

  /** Reads access_token / expires_in from a session response and starts the session. */
  private takeToken(sc: AuthScheme, text: string): boolean {
    try {
      const data = JSON.parse(text);
      const token = data?.access_token;
      if (typeof token !== 'string' || !token) return false;
      this.sessions.start(this.api().id, sc.key, token, Number(data.expires_in) || undefined);
      return true;
    } catch {
      return false;
    }
  }

  /** Puts the typed credentials of `schemes` in the request (headers, cookies or query). */
  private applyCreds(schemes: AuthScheme[], headers: Record<string, string>, query?: URLSearchParams) {
    const cookies: string[] = [];
    for (const sc of schemes) {
      const v = this.cred(sc.key).trim();
      if (sc.type === 'basic') {
        const user = this.cred(sc.key + ':user');
        const pass = this.cred(sc.key + ':pass');
        if (user || pass) headers['Authorization'] = `Basic ${btoa(unescape(encodeURIComponent(`${user}:${pass}`)))}`;
      } else if (!v) {
        continue;
      } else if (sc.type === 'apiKey') {
        if (sc.in === 'header') headers[sc.name] = v;
        if (sc.in === 'cookie') cookies.push(`${sc.name}=${v}`);
        if (sc.in === 'query') query?.set(sc.name, v);
      } else {
        headers['Authorization'] = `Bearer ${v.replace(/^Bearer\s+/i, '')}`;
      }
    }
    if (cookies.length) headers['Cookie'] = cookies.join('; ');
  }

  /** Calls a session route (no path parameters) in the selected environment, through the catalog server. */
  private call(ep: Endpoint, schemes: AuthScheme[], headers: Record<string, string>, body?: string) {
    const query = new URLSearchParams();
    this.applyCreds(schemes, headers, query);
    const url = this.baseUrl() + ep.path + (query.toString() ? `?${query}` : '');
    return firstValueFrom(this.http.post<SendResult>('/api/console/send', { apiId: this.api().id, endpointId: ep.id, url, method: ep.method, headers, body }));
  }

  private buildUrl(maskSecrets = true): { url: string; missing?: string; headers: Record<string, string> } {
    let path = this.endpoint().path;
    const query = new URLSearchParams();
    const headers: Record<string, string> = {};
    let missing: string | undefined;
    for (const p of this.endpoint().parameters) {
      const v = this.values[p.in + ':' + p.name] ?? '';
      if (p.required && !v && !missing) missing = p.name;
      if (!v) continue;
      if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(v));
      if (p.in === 'query') query.set(p.name, v);
      if (p.in === 'header') headers[p.name] = v;
    }
    // Credentials that go in the query string (masked in the preview).
    if (this.mode() === 'real') {
      for (const sc of this.activeSchemes()) {
        const v = this.cred(sc.key);
        if (sc.type === 'apiKey' && sc.in === 'query' && v) query.set(sc.name, maskSecrets ? '•••' : v);
      }
    }
    const base = this.mode() === 'real' ? this.baseUrl() : this.api().baseUrl;
    return { url: base + path + (query.toString() ? `?${query}` : ''), missing, headers };
  }

  async send() {
    this.error.set('');
    this.result.set(null);
    const { url, missing, headers } = this.buildUrl(false);
    if (missing) {
      this.error.set(`Preencha o parâmetro obrigatório "${missing}".`);
      return;
    }
    let body: string | undefined;
    if (this.bodyAllowed() && this.body.trim()) {
      try {
        JSON.parse(this.body);
      } catch {
        this.error.set('O corpo não é um JSON válido.');
        return;
      }
      body = this.body;
      headers['Content-Type'] = 'application/json';
    }

    this.sending.set(true);
    try {
      if (this.mode() === 'simulacao') await this.simulate();
      else await this.sendReal(url, headers, body);
    } finally {
      this.sending.set(false);
    }
  }

  private async sendReal(url: string, headers: Record<string, string>, body?: string) {
    const a = this.api();
    // Query credentials are already in the URL (buildUrl).
    this.applyCreds(this.activeSchemes(), headers);
    try {
      const r = await firstValueFrom(
        this.http.post<SendResult>('/api/console/send', { apiId: a.id, url, method: this.endpoint().method, headers, body })
      );
      this.trackSession(r);
      this.result.set({
        status: r.status,
        statusText: r.statusText || STATUS_TEXT[r.status] || '',
        ms: r.ms,
        body: pretty(r.body) || '(sem corpo)',
        headers: Object.entries(r.headers),
        simulated: false,
        truncated: r.truncated,
      });
    } catch (e) {
      // 404 without our JSON message = the catalog server running is older than the console route.
      const err = e as { status?: number; error?: { message?: string } };
      if (err.status === 404 && !err.error?.message) {
        this.error.set('O servidor do catálogo está desatualizado e não tem a rota do console. Reinicie o servidor (npm start) e tente de novo.');
        return;
      }
      this.error.set(errorMessage(e));
    }
  }

  /** Calling the session routes by hand also starts or ends the console session. */
  private trackSession(r: SendResult) {
    if (r.status < 200 || r.status >= 300) return;
    const ep = this.endpoint();
    for (const sc of this.api().auth.schemes ?? []) {
      const flow = this.flowOf(sc);
      if (flow?.login === ep && this.takeToken(sc, r.body)) this.sessionInfo.set('Token guardado: vale para os outros endpoints desta API.');
      if (flow?.logout === ep) this.sessions.end(this.api().id);
    }
  }

  private async simulate() {
    const responses = this.endpoint().responses;
    const pick = responses.find((r) => r.status >= 200 && r.status < 300) ?? responses[0];
    const ms = 120 + Math.round(Math.random() * 260);
    await new Promise((r) => setTimeout(r, ms));
    if (!pick) {
      this.error.set('Este endpoint não tem resposta de exemplo documentada para simular.');
      return;
    }
    this.result.set({
      status: pick.status,
      statusText: STATUS_TEXT[pick.status] || '',
      ms,
      body: pretty(pick.body) || '(sem corpo)',
      headers: pick.body ? [['content-type', 'application/json']] : [],
      simulated: true,
    });
  }

  copy(text: string, label: string) {
    this.toast.copy(text, label);
  }
}

/** Error text in the response body of the API (mensagem, message, detail or erro). */
function apiMessage(text: string): string {
  try {
    const d = JSON.parse(text);
    const m = d?.mensagem ?? d?.message ?? d?.detail ?? d?.erro ?? d?.error;
    return typeof m === 'string' ? m : '';
  } catch {
    return '';
  }
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

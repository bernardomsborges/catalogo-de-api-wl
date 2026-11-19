import { Component, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SYNC_AUTH_LABELS, SYNC_SECRET_LABELS, SyncAuthType, SyncConfig } from '../../core/spec-sync';

/**
 * URL + credential used by the catalog server to read an OpenAPI document. Shared by
 * "Importar OpenAPI → Link" and "Sincronização do OpenAPI". Edits `config` in place.
 */
@Component({
  selector: 'app-spec-auth-fields',
  imports: [FormsModule],
  template: `
    <div class="grid-2">
      @if (showUrl()) {
        <div class="field">
          <label [for]="p() + 'url'">URL da especificação ou da documentação</label>
          <input [id]="p() + 'url'" class="mono" [(ngModel)]="config().url" placeholder="https://…/openapi.json ou https://…/docs" />
          <span class="hint">Pode ser a página da documentação (Swagger UI, Redoc…): o catálogo procura a especificação nela.@if (urlHint()) { {{ urlHint() }}}</span>
        </div>
      }
      <div class="field">
        <label [for]="p() + 'auth'">{{ authLabel() }}</label>
        <select [id]="p() + 'auth'" [(ngModel)]="config().authType">
          @for (t of types; track t[0]) { <option [value]="t[0]">{{ t[1] }}</option> }
        </select>
      </div>
    </div>
    @if (config().authType !== 'none') {
      <div class="grid-2 box">
        @switch (config().authType) {
          @case ('header') {
            <div class="field">
              <label [for]="p() + 'header'">Nome do cabeçalho</label>
              <input [id]="p() + 'header'" class="mono" [(ngModel)]="config().headerName" placeholder="X-API-Key" />
            </div>
          }
          @case ('query') {
            <div class="field">
              <label [for]="p() + 'param'">Nome do parâmetro</label>
              <input [id]="p() + 'param'" class="mono" [(ngModel)]="config().paramName" placeholder="api_key" />
              <span class="hint">Vai na URL: <code>?{{ config().paramName || 'api_key' }}=…</code></span>
            </div>
          }
          @case ('basic') {
            <div class="field">
              <label [for]="p() + 'user'">Usuário</label>
              <input [id]="p() + 'user'" [(ngModel)]="config().username" autocomplete="off" />
            </div>
          }
          @case ('oauth2') {
            <div class="field">
              <label [for]="p() + 'token-url'">URL do token</label>
              <input [id]="p() + 'token-url'" class="mono" [(ngModel)]="config().tokenUrl" placeholder="https://…/oauth/token" />
            </div>
            <div class="field">
              <label [for]="p() + 'client-id'">Client ID</label>
              <input [id]="p() + 'client-id'" class="mono" [(ngModel)]="config().clientId" autocomplete="off" />
            </div>
            <div class="field">
              <label [for]="p() + 'scope'">Escopos <span class="muted">(opcional)</span></label>
              <input [id]="p() + 'scope'" class="mono" [(ngModel)]="config().scope" placeholder="docs.read" />
            </div>
          }
        }
        <div class="field">
          <label [for]="p() + 'secret'">{{ secretLabels[config().authType] }}</label>
          <input [id]="p() + 'secret'" type="password" autocomplete="new-password" [(ngModel)]="config().secret"
                 [placeholder]="storedSecret() ? 'Guardado no servidor (deixe em branco para manter)' : config().authType === 'bearer' ? 'sem o prefixo Bearer' : ''" />
          <span class="hint">{{ secretHint() }}</span>
        </div>
      </div>
      @if (config().authType === 'oauth2') {
        <p class="hint">O servidor pede um token com <code>grant_type=client_credentials</code> e o reaproveita até expirar.</p>
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 14px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .box { padding: 14px; border: 1px dashed var(--border); border-radius: var(--radius); }
    .hint { font-size: 0.82rem; color: var(--text-3); margin: 0; }
    .mono { font-family: var(--mono); font-size: 0.85rem; }
  `,
})
export class SpecAuthFields {
  config = input.required<SyncConfig>();
  /** Prefix for element ids (two instances can be on the page). */
  p = input('spec-');
  /** A secret is stored on the server for this type: an empty field keeps it. */
  storedSecret = input(false);
  urlHint = input('');
  /** Hidden when the form around already has its own address fields. */
  showUrl = input(true);
  authLabel = input('Autenticação para ler a especificação');
  secretHint = input('Fica só no servidor do catálogo e nunca é mostrado de volta.');

  types = Object.entries(SYNC_AUTH_LABELS) as [SyncAuthType, string][];
  secretLabels = SYNC_SECRET_LABELS;
}

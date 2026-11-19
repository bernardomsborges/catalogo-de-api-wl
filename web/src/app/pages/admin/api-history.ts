import { Component, inject, input, OnInit, output, signal } from '@angular/core';
import { ApiVersion, CatalogService, errorMessage } from '../../core/catalog.service';
import { ChangeReport, compareModels, modelFromApi } from '../../core/breaking';
import { Api } from '../../core/models';

/** "Histórico de versões" section: every publication, with what changes if it's restored. */
@Component({
  selector: 'app-api-history',
  template: `
    @if (error()) { <div class="alert alert-error small" role="alert">{{ error() }}</div> }
    <ol class="versions">
      @for (v of versions(); track v.revision; let first = $first) {
        <li>
          <div class="row">
            <strong>Versão {{ v.revision }}</strong>
            @if (first) { <span class="tag current">publicada</span> }
            <span class="muted small">{{ when(v.savedAt) }}{{ v.savedBy ? ' · ' + v.savedBy : '' }}</span>
            <span class="spacer"></span>
            <span class="small muted">v{{ v.version }} · {{ v.endpoints }} endpoints</span>
            @if (!first) {
              <button class="btn btn-sm" type="button" (click)="toggle(v)" [attr.aria-expanded]="open() === v.revision">{{ open() === v.revision ? 'Fechar' : 'Ver' }}</button>
            }
          </div>
          @if (v.note) { <p class="small note">{{ v.note }}</p> }
          @if (open() === v.revision) {
            <div class="detail">
              @if (report(); as r) {
                @if (!r.breaking.length && !r.compatible.length) {
                  <p class="small">Rotas, parâmetros e credenciais iguais aos da versão publicada (podem mudar textos, guias e exemplos).</p>
                } @else {
                  <p class="small"><strong>Ao restaurar, em relação à versão publicada:</strong></p>
                  <ul class="small">
                    @for (c of r.breaking; track $index) { <li class="bad">{{ c.route ? c.route + ': ' : '' }}{{ c.text }}</li> }
                    @for (c of r.compatible; track $index) { <li>{{ c.route ? c.route + ': ' : '' }}{{ c.text }}</li> }
                  </ul>
                }
              } @else {
                <p class="small muted">Carregando…</p>
              }
              <div class="row">
                <button class="btn btn-sm btn-primary" type="button" (click)="restore(v)" [disabled]="busy()">{{ busy() ? 'Restaurando…' : 'Restaurar esta versão' }}</button>
                <span class="hint">Vira uma nova versão publicada; o histórico continua completo.</span>
              </div>
            </div>
          }
        </li>
      } @empty {
        <li class="muted small">Nenhuma versão ainda.</li>
      }
    </ol>
  `,
  styles: `
    .versions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .versions > li { padding: 10px 0; border-bottom: 1px solid var(--border); }
    .versions > li:last-child { border-bottom: 0; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .note { margin: 4px 0 0; color: var(--text-2); }
    .current { background: var(--ok-soft); color: var(--ok); }
    .detail { margin-top: 8px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: var(--radius); display: flex; flex-direction: column; gap: 6px; }
    .detail ul { margin: 0; padding-left: 18px; max-height: 220px; overflow: auto; }
    .bad { color: var(--danger); }
    .hint { font-size: 0.8rem; color: var(--text-3); }
    p { margin: 0; }
  `,
})
export class ApiHistory implements OnInit {
  private catalog = inject(CatalogService);
  apiId = input.required<string>();
  /** The published API, to compare old versions with. */
  current = input.required<Api | null>();
  restored = output<Api>();

  versions = signal<ApiVersion[]>([]);
  open = signal<number | null>(null);
  report = signal<ChangeReport | null>(null);
  busy = signal(false);
  error = signal('');

  async ngOnInit() {
    await this.load();
  }

  async load() {
    try {
      this.versions.set(await this.catalog.versions(this.apiId()));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async toggle(v: ApiVersion) {
    if (this.open() === v.revision) return this.open.set(null);
    this.open.set(v.revision);
    this.report.set(null);
    try {
      const old = await this.catalog.version(this.apiId(), v.revision);
      const cur = this.current();
      this.report.set(cur ? compareModels(modelFromApi(cur), modelFromApi(old)) : { breaking: [], compatible: [], precise: false });
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async restore(v: ApiVersion) {
    if (!confirm(`Restaurar a versão ${v.revision}? Ela será publicada como uma nova versão.`)) return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.restored.emit(await this.catalog.restore(this.apiId(), v.revision));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  when(iso: string) {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }
}

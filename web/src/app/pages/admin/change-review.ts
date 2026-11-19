import { Component, computed, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Change, ChangeReport } from '../../core/breaking';
import { affectedSystems, Consumer } from '../../core/systems';

/** Review of a new version of the API before saving. Edited in place by the form. */
export interface ChangeReviewState {
  source: 'sync' | 'import';
  report: ChangeReport;
  /** Version suggested for the catalog (editable). */
  version: string;
  /** Changelog entry suggested from the changes (editable). */
  notes: string;
  addToChangelog: boolean;
  /** Required when something breaks. */
  confirmed: boolean;
}

@Component({
  selector: 'app-change-review',
  imports: [FormsModule],
  template: `
    @let r = review();
    <div class="review">
      <h3>{{ title() }}</h3>
      @if (r.report.breaking.length) {
        <div class="group bad">
          <strong>Quebra integrações ({{ r.report.breaking.length }})</strong>
          <ul>
            @for (c of r.report.breaking; track $index) { <li>@if (c.route) { <code>{{ c.route }}</code> } <span>@for (p of parts(c); track $index) { @if (p.code) { <code>{{ p.t }}</code> } @else { {{ p.t }} } }</span></li> }
          </ul>
        </div>
      }
      <!-- PRO-166: which registered systems the breaking changes hit, and whom to warn. -->
      @if (r.report.breaking.length && consumers()) {
        <div class="group affected" role="note">
          @if (affected().length) {
            <strong>Sistemas afetados ({{ affected().length }})</strong>
            <ul>
              @for (a of affected(); track a.system.id) {
                <li>
                  <span><strong>{{ a.system.name }}</strong>@if (a.system.owner) { · {{ a.system.owner }} }@if (a.system.contactEmail) { · <a [href]="'mailto:' + a.system.contactEmail">{{ a.system.contactEmail }}</a> }</span>
                  <span class="small muted">{{ !a.system.routes.length ? 'usa a API inteira' : a.changes.length === 1 ? '1 mudança atinge as rotas que ele usa' : a.changes.length + ' mudanças atingem as rotas que ele usa' }}</span>
                </li>
              }
            </ul>
          } @else {
            <strong>Nenhum sistema cadastrado usa as rotas que quebram.</strong>
          }
        </div>
      }
      @if (r.report.compatible.length) {
        <div class="group ok">
          <strong>Compatível ({{ r.report.compatible.length }})</strong>
          <ul>
            @for (c of r.report.compatible; track $index) { <li>@if (c.route) { <code>{{ c.route }}</code> } <span>@for (p of parts(c); track $index) { @if (p.code) { <code>{{ p.t }}</code> } @else { {{ p.t }} } }</span></li> }
          </ul>
        </div>
      }
      @if (!r.report.breaking.length && !r.report.compatible.length) {
        <p class="hint">Nenhuma mudança de rotas, parâmetros, campos ou credenciais.</p>
      }
      @if (!r.report.precise) {
        <p class="hint">Comparação feita pelos exemplos do catálogo: campos do corpo que passaram a ser obrigatórios só são detectados com a sincronização do OpenAPI ligada.</p>
      }

      <div class="row">
        <div class="field version">
          <label [for]="p() + 'version'">Nova versão</label>
          <input [id]="p() + 'version'" [(ngModel)]="r.version" />
          <span class="hint">{{ versionHint() }}</span>
        </div>
        <label class="check"><input type="checkbox" [(ngModel)]="r.addToChangelog" /> Adicionar entrada em Novidades</label>
      </div>
      @if (r.addToChangelog) {
        <div class="field">
          <label [for]="p() + 'notes'">Entrada sugerida para Novidades <span class="muted">(pode editar)</span></label>
          <textarea [id]="p() + 'notes'" rows="6" [(ngModel)]="r.notes"></textarea>
        </div>
      }
      @if (r.report.breaking.length) {
        <label class="check confirm">
          <input type="checkbox" [(ngModel)]="r.confirmed" />
          Entendo que esta versão pode quebrar integrações de quem já usa a API e quero publicar mesmo assim.
        </label>
      }
    </div>
  `,
  styles: `
    .review { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    h3 { margin: 0; font-size: 0.95rem; }
    .group { border-left: 3px solid; padding: 8px 12px; border-radius: 6px; display: flex; flex-direction: column; gap: 6px; }
    .affected { border-color: var(--warn); background: var(--warn-soft); }
    .affected li { display: flex; flex-direction: column; }
    .group.bad { border-color: var(--danger); background: var(--danger-soft); }
    .group.bad > strong { color: var(--danger); }
    .group.ok { border-color: var(--ok); background: var(--ok-soft); }
    .group.ok > strong { color: var(--ok); }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; font-size: 0.86rem; }
    li { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    code { font-size: 0.78rem; }
    .row { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
    .version input { width: 160px; }
    .check { display: inline-flex; align-items: center; gap: 6px; font-size: 0.88rem; }
    .check input { width: auto; }
    .confirm { padding: 10px 12px; border: 1px solid var(--danger); border-radius: 6px; color: var(--danger); font-weight: 600; }
    .hint { font-size: 0.8rem; color: var(--text-3); margin: 0; }
  `,
})
export class ChangeReview {
  review = input.required<ChangeReviewState>();
  title = input('Revisão das mudanças');
  /** Prefix for element ids. */
  p = input('review-');
  /** Systems that use this API (PRO-166); null when unknown (e.g. a new API). */
  consumers = input<Consumer[] | null>(null);
  affected = computed(() => affectedSystems(this.review().report.breaking, this.consumers() ?? []));

  versionHint = computed(() =>
    this.review().report.breaking.length ? 'Sugerida: versão maior, porque algo quebra.' : 'Sugerida: versão menor, porque tudo é compatível.'
  );

  /** Splits `code` spans so they render as <code>. */
  parts(c: Change) {
    return c.text.split('`').map((t, i) => ({ t, code: i % 2 === 1 }));
  }
}

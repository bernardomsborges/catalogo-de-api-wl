import { Component, computed, input, output } from '@angular/core';
import { Quality } from '../../../../../shared/doc-quality';
import { qualityTier, TIER_LABELS } from '../../shared/quality-score';

/** How many pending fields are listed per item before "e mais N". */
const SHOWN = 12;

/**
 * "Qualidade da documentação" section of the API form (PRO-164): the 0–100 score, what each item
 * is worth and, for what is missing, a link straight to the field. Recomputed on every change.
 */
@Component({
  selector: 'app-doc-quality',
  template: `
    @let q = quality();
    <div class="top">
      <div class="score q-{{ tier() }}" role="img" [attr.aria-label]="'Nota ' + q.score + ' de 100'">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle class="track" cx="18" cy="18" r="15.9" />
          <circle class="bar" cx="18" cy="18" r="15.9" [attr.stroke-dasharray]="q.score + ' 100'" />
        </svg>
        <strong>{{ q.score }}</strong>
      </div>
      <div class="grow">
        <h2 id="qualidade-title">Qualidade da documentação</h2>
        <p class="muted">
          <strong class="t-{{ tier() }}">{{ tierLabel() }}</strong> ·
          @if (q.pendingCount) { {{ q.pendingCount }} {{ q.pendingCount === 1 ? 'item pendente' : 'itens pendentes' }}. A nota muda assim que você preenche. }
          @else { nada pendente. }
        </p>
      </div>
      @if (ai() && q.pendingCount) {
        <button class="btn" type="button" (click)="improve.emit()" title="A IA sugere os textos que faltam; você aprova um a um">✨ Melhorar com IA</button>
      }
    </div>

    <ul class="items">
      @for (it of q.items; track it.key) {
        <li [class.done]="!it.pending.length">
          @if (it.pending.length) {
            <details>
              <summary>
                <span class="mark" aria-hidden="true"></span>
                <span class="label">{{ it.label }}</span>
                <span class="count">{{ it.pending.length }} {{ it.pending.length === 1 ? 'pendente' : 'pendentes' }}</span>
                <span class="pts">{{ fmt(it.points) }}/{{ it.weight }}</span>
              </summary>
              <ul class="pending">
                @for (c of it.pending.slice(0, shown); track c.target + c.label) {
                  <li><button type="button" class="linkish" (click)="go.emit(c.target)">{{ c.label }}</button></li>
                }
                @if (it.pending.length > shown) {
                  <li class="muted small">e mais {{ it.pending.length - shown }}.</li>
                }
              </ul>
            </details>
          } @else {
            <div class="row-done">
              <span class="mark" aria-hidden="true">✓</span>
              <span class="label">{{ it.label }}</span>
              <span class="count">{{ it.notApplicable ? 'não se aplica' : 'ok' }}</span>
              <span class="pts">{{ it.weight }}/{{ it.weight }}</span>
            </div>
          }
        </li>
      }
    </ul>
  `,
  styles: `
    :host { display: block; }
    .top { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
    .top h2 { margin: 0 0 2px; }
    .top p { margin: 0; }
    .grow { flex: 1; min-width: 200px; }
    .score { position: relative; width: 64px; height: 64px; flex: none; }
    .score svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .score circle { fill: none; stroke-width: 3.2; }
    .score .track { stroke: var(--surface-2); }
    .score .bar { stroke: currentColor; stroke-linecap: round; transition: stroke-dasharray 0.3s ease; }
    .score strong { position: absolute; inset: 0; display: grid; place-items: center; font-size: 1.15rem; color: var(--text); font-variant-numeric: tabular-nums; }
    .q-good, .t-good { color: var(--ok); }
    .q-fair, .t-fair { color: var(--warn); }
    .q-poor, .t-poor { color: var(--danger); }
    .items { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
    .items > li { border-bottom: 1px solid var(--border); }
    summary, .row-done { display: flex; align-items: center; gap: 10px; padding: 9px 4px; }
    summary { cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary:hover { background: var(--surface-hover); }
    .mark { width: 18px; height: 18px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 0.7rem; font-weight: 700; }
    summary .mark { border: 2px solid var(--warn); }
    details[open] summary .mark { background: var(--warn-soft); }
    .done .mark { background: var(--ok-soft); color: var(--ok); }
    .label { flex: 1; min-width: 0; }
    .done .label { color: var(--text-2); }
    .count { font-size: 0.8rem; color: var(--text-3); }
    summary .count { color: var(--warn); }
    .pts { font-size: 0.8rem; color: var(--text-3); font-variant-numeric: tabular-nums; min-width: 4.2em; text-align: right; }
    .pending { list-style: none; margin: 0 0 10px; padding: 0 0 0 32px; display: flex; flex-direction: column; gap: 4px; }
    .linkish { background: none; border: 0; padding: 2px 0; font: inherit; font-size: 0.9rem; color: var(--link); cursor: pointer; text-align: left; }
    .linkish:hover { text-decoration: underline; }
  `,
})
export class DocQuality {
  quality = input.required<Quality>();
  ai = input(false);
  /** Field to jump to (Gap/Check target path). */
  go = output<string>();
  improve = output<void>();

  shown = SHOWN;
  tier = computed(() => qualityTier(this.quality().score));
  tierLabel = computed(() => TIER_LABELS[this.tier()]);

  fmt(n: number) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
  }
}

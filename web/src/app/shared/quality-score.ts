import { Component, computed, input } from '@angular/core';
import { COMPLETE_SCORE } from '../../../../shared/doc-quality';

export type QualityTier = 'good' | 'fair' | 'poor';

/** Green from 90 ("documentação completa"), amber from 60, red below. */
export function qualityTier(score: number): QualityTier {
  return score >= COMPLETE_SCORE ? 'good' : score >= 60 ? 'fair' : 'poor';
}

export const TIER_LABELS: Record<QualityTier, string> = { good: 'Completa', fair: 'Razoável', poor: 'Incompleta' };

/** Documentation score chip (0–100), e.g. in the admin list. */
@Component({
  selector: 'app-quality-score',
  template: `<span class="q q-{{ tier() }}" [title]="'Nota da documentação: ' + score() + ' de 100 (' + label() + ')'">{{ score() }}</span>`,
  styles: `
    .q { display: inline-flex; align-items: center; justify-content: center; min-width: 2.6em; padding: 2px 8px; border-radius: 999px; font-size: 0.8rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .q-good { background: var(--ok-soft); color: var(--ok); }
    .q-fair { background: var(--warn-soft); color: var(--warn); }
    .q-poor { background: var(--danger-soft); color: var(--danger); }
  `,
})
export class QualityScore {
  score = input.required<number>();
  tier = computed(() => qualityTier(this.score()));
  label = computed(() => TIER_LABELS[this.tier()]);
}

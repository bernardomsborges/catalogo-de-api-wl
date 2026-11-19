import { Component, computed, inject, input, OnInit } from '@angular/core';
import { HEALTH_LABELS, StatusService } from '../core/status.service';

/** "● No ar · 120 ms" pill for an API, from the health checks. */
@Component({
  selector: 'app-health-badge',
  template: `
    @if (info(); as h) {
      @if (h.monitored) {
        <span class="health" [class]="'health ' + h.status" [attr.title]="title()">
          <span class="dot" aria-hidden="true"></span>{{ labels[h.status ?? 'pending'] }}@if (showLatency() && h.latencyMs != null && h.status !== 'down') { <span class="ms">· {{ h.latencyMs }} ms</span> }
        </span>
      } @else if (showUnmonitored()) {
        <span class="health unmonitored" title="Esta API não tem verificação de saúde">{{ labels.unmonitored }}</span>
      }
    }
  `,
  styles: `
    .health { display: inline-flex; align-items: center; gap: 6px; font-size: 0.75rem; font-weight: 600; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .up { color: var(--ok); border-color: var(--ok); background: var(--ok-soft); }
    .degraded { color: var(--warn); border-color: var(--warn); background: var(--warn-soft); }
    .down { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
    .pending, .unmonitored { color: var(--text-3); }
    .ms { font-weight: 500; opacity: 0.85; }
  `,
})
export class HealthBadge implements OnInit {
  private status = inject(StatusService);
  apiId = input.required<string>();
  showLatency = input(true);
  showUnmonitored = input(false);
  labels = HEALTH_LABELS;

  info = computed(() => this.status.byApi().get(this.apiId()));
  title = computed(() => {
    const h = this.info();
    if (!h?.lastCheckedAt) return '';
    const at = new Date(h.lastCheckedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `Última verificação às ${at}${h.uptime90 != null ? ` · ${h.uptime90}% no ar em 90 dias` : ''}`;
  });

  ngOnInit() {
    this.status.refresh();
  }
}

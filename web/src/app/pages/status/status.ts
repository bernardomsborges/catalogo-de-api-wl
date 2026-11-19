import { Component, computed, DestroyRef, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DayHealth, HEALTH_LABELS, StatusService } from '../../core/status.service';

const ORDER = { down: 0, degraded: 1, pending: 2, up: 3 } as const;

/** /status: is the API down, or is it me? */
@Component({
  selector: 'app-status-page',
  imports: [RouterLink],
  template: `
    <div class="container page">
      <header class="head">
        <h1>Status das APIs</h1>
        <p class="muted">O catálogo verifica cada API a cada minuto. Atualizado às {{ updatedAt() }}.</p>
      </header>

      @if (monitored().length) {
        <div class="summary card" [class]="'summary card ' + overall().kind" role="status">
          <span class="big-dot" aria-hidden="true"></span>
          <strong>{{ overall().text }}</strong>
        </div>
      }

      <section class="list">
        @for (h of monitored(); track h.apiId) {
          <article class="card row-api">
            <div class="line">
              <a class="name" [routerLink]="['/apis', h.slug]">{{ h.name }}</a>
              <span class="pill" [class]="'pill ' + h.status"><span class="dot" aria-hidden="true"></span>{{ labels[h.status ?? 'pending'] }}</span>
              <span class="spacer"></span>
              <span class="small muted">
                @if (h.latencyMs != null && h.status !== 'down') { {{ h.latencyMs }} ms · }
                {{ h.uptime90 != null ? h.uptime90 + '% no ar em 90 dias' : 'sem histórico ainda' }}
              </span>
            </div>
            @if (h.status === 'down' || h.status === 'degraded') {
              <p class="small since">{{ h.status === 'down' ? 'Fora do ar' : 'Instável' }} desde {{ when(h.since) }}.</p>
            }
            <div class="bars" role="img" [attr.aria-label]="'Disponibilidade nos últimos 90 dias: ' + (h.uptime90 ?? 'sem dados') + '%'">
              @for (d of h.days; track d.date) {
                <span class="bar" [class]="'bar ' + dayClass(d)" [attr.title]="dayTitle(d)"></span>
              }
            </div>
            <div class="axis small muted"><span>90 dias atrás</span><span>hoje</span></div>
          </article>
        }
      </section>

      @if (unmonitored().length) {
        <section class="unmonitored">
          <h2>Sem monitoramento</h2>
          <p class="small muted">Estas APIs ainda não têm uma rota de verificação de saúde cadastrada. Isso não quer dizer que estejam fora do ar.</p>
          <ul>
            @for (h of unmonitored(); track h.apiId) { <li><a [routerLink]="['/apis', h.slug]">{{ h.name }}</a></li> }
          </ul>
        </section>
      }

      <p class="legend small muted">
        <span class="bar up"></span> 99,5% ou mais &nbsp; <span class="bar warn"></span> 95% a 99,5% &nbsp; <span class="bar bad"></span> menos de 95% &nbsp; <span class="bar none"></span> sem verificação
      </p>
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 32px); display: flex; flex-direction: column; gap: 16px; max-width: 980px; }
    .head h1 { margin: 0; }
    .head p { margin: 4px 0 0; }
    .summary { display: flex; align-items: center; gap: 12px; padding: 16px 20px; font-size: 1.05rem; }
    .big-dot { width: 14px; height: 14px; border-radius: 50%; background: currentColor; }
    .summary.ok { color: var(--ok); background: var(--ok-soft); border-color: var(--ok); }
    .summary.warn { color: var(--warn); background: var(--warn-soft); border-color: var(--warn); }
    .summary.bad { color: var(--danger); background: var(--danger-soft); border-color: var(--danger); }
    .list { display: flex; flex-direction: column; gap: 10px; }
    .row-api { padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; }
    .line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .name { font-weight: 600; color: var(--text); }
    .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 0.75rem; font-weight: 600; padding: 2px 9px; border-radius: 999px; border: 1px solid; }
    .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .pill.up { color: var(--ok); background: var(--ok-soft); }
    .pill.degraded { color: var(--warn); background: var(--warn-soft); }
    .pill.down { color: var(--danger); background: var(--danger-soft); }
    .pill.pending { color: var(--text-3); }
    .since { margin: 0; color: var(--text-2); }
    .bars { display: grid; grid-template-columns: repeat(90, 1fr); gap: 2px; height: 28px; }
    .bar { display: inline-block; border-radius: 2px; min-width: 2px; }
    .legend .bar { width: 10px; height: 10px; vertical-align: middle; }
    .bar.up { background: var(--ok); }
    .bar.warn { background: var(--warn); }
    .bar.bad { background: var(--danger); }
    .bar.none { background: var(--border); }
    .axis { display: flex; justify-content: space-between; }
    .unmonitored h2 { font-size: 1rem; margin: 8px 0 4px; }
    .unmonitored p { margin: 0 0 6px; }
    .unmonitored ul { margin: 0; padding-left: 18px; columns: 2; }
    @media (max-width: 640px) { .bars { height: 22px; gap: 1px; } .unmonitored ul { columns: 1; } }
  `,
})
export class StatusPage implements OnInit {
  private status = inject(StatusService);
  private destroyRef = inject(DestroyRef);
  labels = HEALTH_LABELS;

  private sorted = computed(() => [...this.status.list()].sort((a, b) => a.name.localeCompare(b.name)));
  monitored = computed(() =>
    this.sorted()
      .filter((h) => h.monitored)
      .sort((a, b) => ORDER[a.status ?? 'pending'] - ORDER[b.status ?? 'pending'] || a.name.localeCompare(b.name))
  );
  unmonitored = computed(() => this.sorted().filter((h) => !h.monitored));
  overall = computed(() => {
    const m = this.monitored();
    const down = m.filter((h) => h.status === 'down').length;
    const degraded = m.filter((h) => h.status === 'degraded').length;
    if (down) return { kind: 'bad', text: down === 1 ? '1 API fora do ar' : `${down} APIs fora do ar` };
    if (degraded) return { kind: 'warn', text: degraded === 1 ? '1 API instável' : `${degraded} APIs instáveis` };
    return { kind: 'ok', text: 'Todas as APIs monitoradas estão no ar' };
  });
  updatedAt = computed(() => (this.status.list(), new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })));

  ngOnInit() {
    this.status.refresh(0);
    const timer = setInterval(() => this.status.refresh(0), 60_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  dayClass(d: DayHealth) {
    if (d.uptime == null) return 'none';
    return d.uptime >= 99.5 ? 'up' : d.uptime >= 95 ? 'warn' : 'bad';
  }

  dayTitle(d: DayHealth) {
    const date = new Date(d.date + 'T12:00:00Z').toLocaleDateString('pt-BR');
    return d.uptime == null ? `${date}: sem verificação` : `${date}: ${d.uptime}% no ar${d.avgMs != null ? ` · média ${d.avgMs} ms` : ''}`;
  }

  when(iso?: string | null) {
    return iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  }
}

import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, apiSchemes, authSummary, Endpoint } from '../core/models';
import { endpointAnchor } from '../core/catalog-search';
import { HealthBadge } from './health-badge';
import { StatusBadge } from './ui';

@Component({
  selector: 'app-api-card',
  imports: [RouterLink, StatusBadge, HealthBadge],
  template: `
    @let a = api();
    @let r = routes();
    <!-- Found by a route (PRO-206): the card opens that route in the reference. -->
    <a class="api-card card" [class.locked]="a.locked" [routerLink]="r.length ? ['/apis', a.slug, 'referencia'] : ['/apis', a.slug]" [fragment]="r.length ? anchor(r[0]) : undefined">
      <div class="top">
        <span class="icon" aria-hidden="true">{{ a.name.charAt(0) }}</span>
        <span class="badges">
          @if (a.visibility === 'private') {
            @let privateHint = a.locked ? 'API privada: entre e peça acesso para ver a documentação' : 'API privada: você tem acesso';
            <span class="private" [class.unlocked]="!a.locked" [title]="privateHint">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                @if (a.locked) { <path d="M8 11V7a4 4 0 0 1 8 0v4" /> } @else { <path d="M8 11V7a4 4 0 0 1 7.5-2" /> }
              </svg>
              <span class="sr-only">{{ privateHint }}</span>
            </span>
          }
          <app-status-badge [status]="a.status" />
        </span>
      </div>
      <h3>{{ a.name }}</h3>
      <p class="muted">{{ a.summary }}</p>
      @if (r.length) {
        <div class="route small">
          <span class="route-label">Rota encontrada</span>
          <span class="route-line"><code>{{ r[0].method }} {{ r[0].path }}</code>@if (r[0].summary) { <span class="muted"> · {{ r[0].summary }}</span> }</span>
          @if (r.length > 1) { <span class="muted">e mais {{ r.length - 1 }} {{ r.length === 2 ? 'rota' : 'rotas' }}</span> }
        </div>
      }
      <div class="meta">
        <span class="tag">{{ a.category }}</span>
        <span class="small muted">v{{ a.version }}@if (!a.locked) { · {{ a.endpoints.length }} endpoint{{ a.endpoints.length === 1 ? '' : 's' }} }</span>
      </div>
      @if (a.locked) {
        <div class="foot small muted"><span>Acesso restrito</span><span class="request">Pedir acesso →</span></div>
      } @else {
        <div class="foot small muted"><span>{{ authLabel(a) }}</span><app-health-badge [apiId]="a.id" [showLatency]="false" /></div>
      }
    </a>
  `,
  styles: `
    :host { display: block; }
    .api-card { display: flex; flex-direction: column; gap: 8px; padding: 20px; height: 100%; color: var(--text); text-decoration: none !important; transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s; }
    .api-card:hover { border-color: var(--brand); box-shadow: var(--shadow-lg); transform: translateY(-2px); }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    /* Pills never break inside; if the row runs out of room they wrap as whole pills. */
    .badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; align-items: center; min-width: 0; }
    .private { flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--text-2); }
    .private.unlocked { background: var(--ok-soft); color: var(--ok); }
    .icon { flex-shrink: 0; width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; font-weight: 700; background: var(--brand-soft); color: var(--brand); }
    h3 { margin: 6px 0 0; }
    .route { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); }
    .route-label { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); }
    .route-line { overflow-wrap: anywhere; }
    .route code { font-size: 0.8rem; color: var(--text); }
    p { margin: 0; flex: 1; font-size: 0.9rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    /* Private API the person can't open: greyed out, dashed, and it doesn't lift on hover. */
    .api-card.locked { background: var(--surface-2); border: 1px dashed var(--border-strong); box-shadow: none; }
    .api-card.locked:hover { border-color: var(--text-3); box-shadow: none; transform: none; }
    .locked .icon { background: var(--border); color: var(--text-3); }
    .locked h3 { color: var(--text-2); }
    .locked p, .locked .meta { color: var(--text-3); }
    .locked .private { background: var(--border); }
    .locked app-status-badge { filter: grayscale(1); opacity: 0.75; }
    .locked .tag { background: var(--border); color: var(--text-3); }
    .locked .foot { border-top-style: dashed; border-top-color: var(--border-strong); }
    .request { color: var(--link); font-weight: 600; }
    .foot { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 4px; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  `,
})
export class ApiCard {
  /** Routes that matched the search, when the API was found by them. */
  routes = input<Endpoint[]>([]);
  anchor = endpointAnchor;
  api = input.required<Api>();
  authLabel = (a: Api) => (apiSchemes(a).length ? '🔒 ' : '') + authSummary(a);
}

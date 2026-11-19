import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { CatalogService } from '../../core/catalog.service';
import { RecipeService } from '../../core/recipe.service';
import { analyze, Recipe, RecipeStep } from '../../core/recipes';
import { MarkdownPipe } from '../../shared/markdown.pipe';
import { RecipeCode } from '../../shared/recipe-code';
import { MethodBadge } from '../../shared/ui';

/** Same anchor as the API reference page uses for each endpoint. */
export const endpointAnchor = (s: Pick<RecipeStep, 'method' | 'path'>) =>
  'ep-' + (s.method + s.path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

@Component({
  selector: 'app-recipe-detail',
  imports: [RouterLink, MarkdownPipe, MethodBadge, RecipeCode],
  template: `
    @if (notFound()) {
      <div class="container page">
        <h1>ReceAPIto não encontrado</h1>
        <a class="btn" routerLink="/receapitos">Ver todos os ReceAPItos</a>
      </div>
    } @else if (recipe(); as r) {
      <div class="container page">
        <nav class="crumbs small" aria-label="Navegação estrutural"><a routerLink="/receapitos">ReceAPItos</a></nav>
        <header class="head">
          <h1>{{ r.title }}</h1>
          @if (r.goal) { <p class="goal">{{ r.goal }}</p> }
          <div class="meta small">
            <span class="tag">{{ r.steps.length }} passos</span>
            @for (a of analysis().apis; track a.id) { <a class="tag" [routerLink]="['/apis', a.slug]">{{ a.name }}</a> }
          </div>
        </header>

        @if (analysis().missingCount) {
          <div class="alert alert-warn" role="alert">
            <strong>Atenção:</strong> {{ analysis().missingCount === 1 ? 'uma rota usada neste ReceAPIto não existe' : analysis().missingCount + ' rotas usadas neste ReceAPIto não existem' }} mais no catálogo. Os passos marcados abaixo podem não funcionar.
          </div>
        }
        @if (r.intro) { <div class="markdown" [innerHTML]="r.intro | markdown"></div> }

        @if (analysis().inputs.length) {
          <section class="card inputs">
            <h2>Antes de começar</h2>
            <p class="small muted">Estes dados são seus. No código, eles vêm de variáveis de ambiente.</p>
            <dl>
              @for (v of analysis().inputs; track v) {
                <dt><code>{{ v }}</code></dt>
                <dd>{{ r.inputs[v] || '—' }}</dd>
              }
            </dl>
          </section>
        }

        <ol class="steps">
          @for (s of r.steps; track $index; let i = $index) {
            @let info = analysis().steps[i];
            <li class="card step" [class.missing]="info.missing">
              <div class="step-head">
                <span class="num" aria-hidden="true">{{ i + 1 }}</span>
                <div class="step-title">
                  <h2>{{ s.title || s.method + ' ' + s.path }}</h2>
                  <div class="route small">
                    <app-method [method]="s.method" /> <code>{{ s.path }}</code>
                    @if (info.api) { <span class="muted">· {{ info.api.name }}</span> }
                  </div>
                </div>
              </div>
              @if (info.missing) {
                <div class="alert alert-warn small">Esta rota não existe mais {{ info.api ? 'na ' + info.api.name : 'no catálogo (a API foi removida)' }}.</div>
              } @else if (info.api) {
                <div class="links small">
                  <a [routerLink]="['/apis', info.api.slug, 'referencia']" [fragment]="anchor(s)">Ver na referência</a>
                  <a [routerLink]="['/apis', info.api.slug, 'referencia']" [queryParams]="{ testar: anchor(s) }" [fragment]="anchor(s)">Testar no console</a>
                </div>
              }
              @if (s.description) { <div class="markdown small" [innerHTML]="s.description | markdown"></div> }

              @if (info.uses.length) {
                <div class="flow small">
                  <span class="label">Usa</span>
                  @for (u of info.uses; track u.name) {
                    <span class="chip" [class.from-step]="u.from">
                      <code>{{ u.name }}</code> {{ u.from ? '← passo ' + u.from : '← você informa' }}
                    </span>
                  }
                </div>
              }
              @if (s.outputs.length) {
                <div class="flow small">
                  <span class="label">Guarda</span>
                  @for (o of s.outputs; track o.name) {
                    <span class="chip saves"><code>{{ o.name }}</code> ← resposta <code>{{ o.path }}</code></span>
                  }
                </div>
              }
              @if (s.params.length || s.body) {
                <details class="request small">
                  <summary>Ver a requisição</summary>
                  @if (s.params.length) {
                    <table class="table">
                      <tbody>
                        @for (p of s.params; track p.in + p.name) {
                          <tr><td><code>{{ p.name }}</code></td><td class="muted">{{ p.in === 'header' ? 'cabeçalho' : p.in === 'path' ? 'caminho' : 'query' }}</td><td><code>{{ p.value }}</code></td></tr>
                        }
                      </tbody>
                    </table>
                  }
                  @if (s.body) { <pre class="body" tabindex="0">{{ s.body }}</pre> }
                </details>
              }
            </li>
          }
        </ol>

        <app-recipe-code [recipe]="r" [apis]="apis()" />
      </div>
    }
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 28px); display: flex; flex-direction: column; gap: 18px; max-width: 960px; }
    .head h1 { margin: 4px 0 6px; }
    .goal { margin: 0 0 8px; font-size: 1.05rem; color: var(--text-2); }
    .meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .meta a.tag { text-decoration: none; }
    .inputs { padding: 18px; }
    .inputs h2 { margin: 0; font-size: 1.1rem; }
    .inputs dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 10px 0 0; }
    .inputs dd { margin: 0; }
    .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
    .step { padding: 18px; display: flex; flex-direction: column; gap: 10px; }
    .step.missing { border-color: var(--warn); }
    .step-head { display: flex; gap: 12px; align-items: flex-start; }
    .num { flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: var(--brand); color: var(--on-brand); font-weight: 700; }
    .step h2 { margin: 0 0 4px; font-size: 1.02rem; }
    .route { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .links { display: flex; gap: 14px; }
    .flow { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .flow .label { font-weight: 600; color: var(--text-2); min-width: 52px; }
    .chip { border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; background: var(--surface-2); }
    .chip.from-step { border-color: var(--brand); }
    .chip.saves { border-color: var(--ok); background: var(--ok-soft); }
    .chip code { font-size: 0.78rem; }
    .request summary { cursor: pointer; color: var(--text-2); }
    .request table { margin-top: 8px; }
    .body { background: var(--code-bg); color: var(--code-text); padding: 10px; border-radius: 8px; overflow: auto; font-size: 0.78rem; }
    .markdown :first-child { margin-top: 0; }
  `,
})
export class RecipeDetail implements OnInit {
  private service = inject(RecipeService);
  private catalog = inject(CatalogService);
  private titleService = inject(Title);
  slug = input.required<string>();

  recipe = signal<Recipe | null>(null);
  notFound = signal(false);

  apis = computed(() => this.catalog.apis());
  analysis = computed(() => analyze(this.recipe() ?? { steps: [] }, this.catalog.apis()));

  async ngOnInit() {
    if (!this.catalog.apis().length) this.catalog.refresh();
    try {
      const r = await this.service.get(this.slug());
      this.recipe.set(r);
      this.titleService.setTitle(`${r.title} · ReceAPItos · Automatiza.MG`);
    } catch {
      this.notFound.set(true);
    }
  }

  anchor = endpointAnchor;
}

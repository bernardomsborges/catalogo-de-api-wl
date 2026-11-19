import { Component, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CatalogService, errorMessage } from '../../core/catalog.service';
import { Api } from '../../core/models';
import { RecipeService } from '../../core/recipe.service';
import { analyze, emptyRecipe, findApi, RecipeInput, RecipeStep, responseFields, stepFromEndpoint, VAR_NAME } from '../../core/recipes';
import { RecipeCode } from '../../shared/recipe-code';
import { RecipeAgent } from './recipe-agent';
import { RecipeDraft } from '../../core/recipe.service';

/** /admin/receapitos/novo and /admin/receapitos/editar/:id */
@Component({
  selector: 'app-recipe-form',
  imports: [FormsModule, RouterLink, RecipeAgent, RecipeCode],
  template: `
    <div class="container page">
      <div class="row head">
        <div>
          <a routerLink="/admin/receapitos" class="small">← ReceAPItos</a>
          <h1>{{ id() ? 'Editar ReceAPIto' : 'Novo ReceAPIto' }}</h1>
        </div>
        <span class="spacer"></span>
        <button class="btn" type="button" (click)="showCode.set(!showCode())">{{ showCode() ? 'Fechar código' : 'Ver código gerado' }}</button>
        <button class="btn btn-primary" type="button" (click)="save()" [disabled]="saving()">{{ saving() ? 'Salvando…' : 'Salvar' }}</button>
      </div>

      @if (errors().length) {
        <div class="alert alert-error" role="alert"><ul>@for (e of errors(); track e) { <li>{{ e }}</li> }</ul></div>
      }

      <app-recipe-agent [current]="snapshot" (apply)="applyDraft($event)" (restore)="restore($event)" />

      <section class="card section">
        <div class="grid-2">
          <div class="field">
            <label for="r-title">Título *</label>
            <input id="r-title" [(ngModel)]="m.title" placeholder="Ex.: Abrir um processo e anexar um documento externo" />
          </div>
          <div class="field">
            <label for="r-slug">Identificador na URL</label>
            <input id="r-slug" class="mono" [(ngModel)]="m.slug" placeholder="gerado a partir do título" />
          </div>
        </div>
        <div class="field">
          <label for="r-goal">Objetivo</label>
          <input id="r-goal" [(ngModel)]="m.goal" placeholder="Uma frase: o que a pessoa consegue fazer com este ReceAPIto" />
        </div>
        <div class="field">
          <label for="r-intro">Introdução <span class="muted">(Markdown, opcional)</span></label>
          <textarea id="r-intro" rows="3" [(ngModel)]="m.intro"></textarea>
        </div>
        <div class="field">
          <label for="r-tags">Etiquetas <span class="muted">(separadas por vírgula)</span></label>
          <input id="r-tags" [(ngModel)]="tagsText" />
        </div>
      </section>

      <section class="steps">
        <h2>Passos</h2>
        <p class="hint">
          Cada passo chama uma rota. Em <strong>Guarda</strong>, salve dados da resposta em variáveis (ex.: <code>TOKEN</code> ← <code>access_token</code>) e use-as nos passos seguintes como
          <code>{{ placeholders.token }}</code>. Variáveis que nenhum passo guarda são informadas por quem roda o ReceAPIto.
        </p>
        @for (s of m.steps; track s; let i = $index) {
          @let info = analysis().steps[i];
          <div class="card step" [class.missing]="s.path && info?.missing">
            <div class="row">
              <strong>Passo {{ i + 1 }}</strong>
              <span class="spacer"></span>
              <button class="btn btn-sm btn-ghost" type="button" (click)="move(i, -1)" [disabled]="i === 0" aria-label="Subir passo">↑</button>
              <button class="btn btn-sm btn-ghost" type="button" (click)="move(i, 1)" [disabled]="i === m.steps.length - 1" aria-label="Descer passo">↓</button>
              <button class="btn btn-sm btn-danger" type="button" (click)="m.steps.splice(i, 1)" aria-label="Remover passo">×</button>
            </div>
            <div class="grid-3">
              <div class="field">
                <label [for]="'api' + i">API</label>
                <select [id]="'api' + i" [ngModel]="apiOf(s)?.id ?? ''" (ngModelChange)="setApi(s, $event)">
                  <option value="" disabled>Escolha…</option>
                  @for (a of catalog.apis(); track a.id) { <option [value]="a.id">{{ a.name }}</option> }
                </select>
              </div>
              <div class="field span-2">
                <label [for]="'route' + i">Rota</label>
                <select [id]="'route' + i" [ngModel]="s.method + ' ' + s.path" (ngModelChange)="setRoute(s, $event)" [disabled]="!apiOf(s)">
                  <option value=" " disabled>Escolha…</option>
                  @if (s.path && info?.missing) { <option [value]="s.method + ' ' + s.path">⚠ {{ s.method }} {{ s.path }} (não existe mais)</option> }
                  @for (e of apiOf(s)?.endpoints ?? []; track e.method + e.path) {
                    <option [value]="e.method + ' ' + e.path">{{ e.method }} {{ e.path }}{{ e.summary ? ' — ' + e.summary : '' }}</option>
                  }
                </select>
              </div>
            </div>
            @if (s.path && info?.missing) {
              <div class="alert alert-warn small">Esta rota não existe mais na API. Escolha outra ou remova o passo.</div>
            }
            <div class="field">
              <label [for]="'title' + i">Título do passo</label>
              <input [id]="'title' + i" [(ngModel)]="s.title" />
            </div>
            <div class="field">
              <label [for]="'desc' + i">Explicação <span class="muted">(Markdown, opcional)</span></label>
              <textarea [id]="'desc' + i" rows="2" [(ngModel)]="s.description"></textarea>
            </div>

            <div class="sub">
              <div class="row"><span class="label">Parâmetros e cabeçalhos</span><span class="spacer"></span><button class="btn btn-sm" type="button" (click)="s.params.push({ in: 'header', name: '', value: '' })">+ Parâmetro</button></div>
              @for (p of s.params; track $index; let pi = $index) {
                <div class="param">
                  <select [(ngModel)]="p.in" aria-label="Onde vai">
                    <option value="header">cabeçalho</option><option value="query">query</option><option value="path">caminho</option>
                  </select>
                  <input class="mono" [(ngModel)]="p.name" placeholder="nome" aria-label="Nome" />
                  <input class="mono" [(ngModel)]="p.value" [placeholder]="placeholders.value" aria-label="Valor" />
                  <button class="btn btn-sm btn-danger" type="button" (click)="s.params.splice(pi, 1)" aria-label="Remover parâmetro">×</button>
                </div>
              }
            </div>
            @if (!['GET', 'DELETE'].includes(s.method)) {
              <div class="field">
                <label [for]="'body' + i">Corpo (JSON) <span class="muted">— variáveis entre aspas: "{{ placeholders.senha }}"</span></label>
                <textarea [id]="'body' + i" class="code" rows="6" [(ngModel)]="s.body"></textarea>
              </div>
            }
            <div class="sub">
              <div class="row"><span class="label">Guarda da resposta</span><span class="spacer"></span><button class="btn btn-sm" type="button" (click)="s.outputs.push({ name: '', path: '' })">+ Variável</button></div>
              @for (o of s.outputs; track $index; let oi = $index) {
                <div class="output">
                  <input class="mono" [(ngModel)]="o.name" placeholder="VARIAVEL" aria-label="Nome da variável" />
                  <span class="muted">←</span>
                  <input class="mono" [(ngModel)]="o.path" placeholder="campo, ex.: data[0].id" [attr.list]="'fields' + i" aria-label="Campo da resposta" />
                  <button class="btn btn-sm btn-danger" type="button" (click)="s.outputs.splice(oi, 1)" aria-label="Remover variável">×</button>
                </div>
              }
              <datalist [id]="'fields' + i">@for (f of fields(s); track f) { <option [value]="f"></option> }</datalist>
            </div>
            @if (info?.uses?.length) {
              <p class="small uses">
                Usa:
                @for (u of info!.uses; track u.name) { <code>{{ u.name }}</code> {{ u.from ? '(passo ' + u.from + ')' : '(informada)' }}&nbsp; }
              </p>
            }
          </div>
        }
        <button class="btn" type="button" (click)="addStep()">+ Passo</button>
      </section>

      @if (analysis().inputs.length) {
        <section class="card section">
          <h2>Dados que a pessoa informa</h2>
          <p class="hint">Aparecem em "Antes de começar" e viram variáveis de ambiente no código.</p>
          @for (v of analysis().inputs; track v) {
            <div class="input-row">
              <code>{{ v }}</code>
              <input [ngModel]="m.inputs[v] ?? ''" (ngModelChange)="m.inputs[v] = $event" placeholder="O que é, ex.: Sua senha do SEI" [attr.aria-label]="'Descrição de ' + v" />
            </div>
          }
        </section>
      }

      @if (showCode()) {
        <app-recipe-code [recipe]="snapshot()" [apis]="catalog.apis()" />
      }

      <div class="row end">
        <a class="btn" routerLink="/admin/receapitos">Cancelar</a>
        <button class="btn btn-primary" type="button" (click)="save()" [disabled]="saving()">{{ saving() ? 'Salvando…' : 'Salvar ReceAPIto' }}</button>
      </div>
    </div>
  `,
  styles: `
    .page { padding-top: calc(var(--header-space) + 24px); display: flex; flex-direction: column; gap: 18px; max-width: 1000px; }
    .head h1 { margin: 4px 0 0; }
    .section { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .section h2, .steps h2 { margin: 0; font-size: 1.1rem; }
    .steps { display: flex; flex-direction: column; gap: 12px; }
    .hint { font-size: 0.85rem; color: var(--text-3); margin: 0; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 2fr; gap: 14px; }
    .step { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .step.missing { border-color: var(--warn); }
    .sub { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px dashed var(--border); border-radius: var(--radius); }
    .label { font-weight: 600; font-size: 0.88rem; }
    .param { display: grid; grid-template-columns: 130px 1fr 1.5fr auto; gap: 8px; }
    .output { display: grid; grid-template-columns: 1fr auto 1.5fr auto; gap: 8px; align-items: center; }
    .input-row { display: grid; grid-template-columns: 200px 1fr; gap: 10px; align-items: center; }
    .mono { font-family: var(--mono); font-size: 0.85rem; }
    .uses { margin: 0; color: var(--text-2); }
    .end { justify-content: flex-end; }
    @media (max-width: 700px) { .grid-3, .param, .output, .input-row { grid-template-columns: 1fr; } }
  `,
})
export class RecipeForm implements OnInit {
  private service = inject(RecipeService);
  catalog = inject(CatalogService);
  private router = inject(Router);
  /** Route param when editing. */
  id = input<string>();

  model = signal<RecipeInput>(emptyRecipe());
  tagsText = '';
  saving = signal(false);
  errors = signal<string[]>([]);
  showCode = signal(false);
  /** Texts with literal braces (kept out of the template, where {{ }} is interpolation). */
  placeholders = { value: 'valor ou {{VARIAVEL}}', token: '{{TOKEN}}', senha: '{{SENHA}}' };

  get m() {
    return this.model();
  }

  async ngOnInit() {
    this.catalog.refresh();
    const id = this.id();
    if (!id) {
      this.addStep();
      return;
    }
    try {
      const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = await this.service.get(id);
      this.model.set(structuredClone(rest));
      this.tagsText = rest.tags.join(', ');
    } catch (e) {
      this.errors.set([errorMessage(e)]);
    }
  }

  // Recomputed on every check: the model is edited in place by the inputs.
  analysis() {
    return analyze(this.m, this.catalog.apis());
  }

  apiOf(s: RecipeStep): Api | undefined {
    return findApi(this.catalog.apis(), s);
  }

  fields(s: RecipeStep) {
    return responseFields(this.apiOf(s)?.endpoints.find((e) => e.method === s.method && e.path === s.path));
  }

  addStep() {
    // New steps start on the API of the previous one.
    const prev = this.m.steps.at(-1);
    this.m.steps.push({ title: '', description: '', apiId: prev?.apiId ?? '', apiSlug: prev?.apiSlug, method: 'GET', path: '', params: [], body: '', outputs: [] });
  }

  move(i: number, delta: number) {
    const j = i + delta;
    [this.m.steps[i], this.m.steps[j]] = [this.m.steps[j], this.m.steps[i]];
  }

  setApi(s: RecipeStep, apiId: string) {
    const api = this.catalog.apis().find((a) => a.id === apiId);
    s.apiId = apiId;
    s.apiSlug = api?.slug;
    s.path = '';
  }

  /** Picking a route pre-fills credentials, required parameters and the body example. */
  setRoute(s: RecipeStep, value: string) {
    const api = this.apiOf(s);
    const ep = api?.endpoints.find((e) => `${e.method} ${e.path}` === value);
    if (!api || !ep) return;
    const filled = stepFromEndpoint(api, ep);
    s.method = ep.method;
    s.path = ep.path;
    s.title ||= filled.title;
    s.params = filled.params;
    s.body = filled.body;
  }

  /** The form as it is, for the AI to adjust and for "Desfazer" (null while it is still blank). */
  snapshot = (): RecipeInput => structuredClone({ ...this.m, tags: this.tagsText.split(',').map((t) => t.trim()).filter(Boolean) });

  restore(r: RecipeInput) {
    this.model.set(structuredClone(r));
    this.tagsText = r.tags.join(', ');
  }

  /**
   * Fills the form with the AI draft. Each step starts from the catalog route (credentials,
   * required parameters, body example) and gets what the AI wrote on top.
   */
  applyDraft(d: NonNullable<RecipeDraft['recipe']>) {
    const steps = d.steps.map(({ bodyFromModel, ...s }) => {
      const api = findApi(this.catalog.apis(), s);
      const ep = api?.endpoints.find((e) => e.method === s.method && e.path === s.path);
      if (!api || !ep) return s;
      const base = stepFromEndpoint(api, ep);
      const same = (a: { in: string; name: string }, b: { in: string; name: string }) => a.in === b.in && a.name.toLowerCase() === b.name.toLowerCase();
      // The AI's values win; parameters it left out keep the catalog default.
      const params = [...s.params, ...base.params.filter((b) => !s.params.some((p) => same(p, b)))];
      return { ...s, params, body: bodyFromModel ? s.body : base.body };
    });
    this.model.set({ slug: this.m.slug, title: d.title, goal: d.goal, intro: d.intro, tags: d.tags, inputs: { ...d.inputs }, steps });
    this.tagsText = d.tags.join(', ');
    this.errors.set([]);
  }

  private validate(): string[] {
    const errs: string[] = [];
    if (!this.m.title.trim()) errs.push('Informe o título.');
    if (!this.m.steps.length) errs.push('Inclua pelo menos um passo.');
    this.m.steps.forEach((s, i) => {
      if (!s.path) errs.push(`Passo ${i + 1}: escolha a API e a rota.`);
      for (const o of s.outputs) {
        if (!VAR_NAME.test(o.name)) errs.push(`Passo ${i + 1}: nome de variável inválido "${o.name}" (use letras, números e _).`);
        else if (!o.path.trim()) errs.push(`Passo ${i + 1}: informe de onde vem ${o.name}.`);
      }
      if (s.body?.trim() && !['GET', 'DELETE'].includes(s.method)) {
        try {
          JSON.parse(s.body);
        } catch {
          errs.push(`Passo ${i + 1}: o corpo não é um JSON válido (as {{VARIÁVEIS}} devem ficar entre aspas).`);
        }
      }
    });
    return errs;
  }

  async save() {
    const errs = this.validate();
    this.errors.set(errs);
    if (errs.length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const payload: RecipeInput = {
      ...this.m,
      tags: this.tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      steps: this.m.steps.map((s) => ({ ...s, body: ['GET', 'DELETE'].includes(s.method) ? '' : s.body })),
    };
    this.saving.set(true);
    try {
      const id = this.id();
      const saved = id ? await this.service.update(id, payload) : await this.service.create(payload);
      this.router.navigate(['/admin/receapitos'], { state: { message: `“${saved.title}” foi ${id ? 'atualizado' : 'criado'}.` } });
    } catch (e) {
      this.errors.set([errorMessage(e)]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      this.saving.set(false);
    }
  }
}

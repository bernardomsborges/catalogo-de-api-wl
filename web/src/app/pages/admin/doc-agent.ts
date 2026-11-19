import { HttpClient } from '@angular/common/http';
import { ArrowKeys } from '../../shared/arrow-keys';
import { AppDialog } from '../../shared/dialog';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiInput, errorMessage } from '../../core/catalog.service';
import { MarkdownPipe } from '../../shared/markdown.pipe';
import { docQuality, missingResponses, QResponse } from '../../../../../shared/doc-quality';

interface Suggestion {
  target: string;
  kind: 'translate' | 'fill' | 'improve' | 'example' | 'json' | 'responses';
  label: string;
  current: string;
  value: string;
  state: 'pending' | 'accepted' | 'rejected';
  /** kind 'responses': what is added to the route (written without AI). */
  add?: QResponse[];
}

const KIND_LABELS = { translate: 'Tradução', fill: 'Texto novo', improve: 'Melhoria', example: 'Exemplo', json: 'Exemplo de resposta', responses: 'Respostas' } as const;
/** Endpoints per request: keeps each answer small for the model (response examples are long). */
const BATCH = 4;
/** Batches asked to the AI at the same time, unless the server says otherwise (LLM_PARALLEL). */
const PARALLEL = 5;
/** Fields only a person can fill (the AI would have to invent them). */
const MANUAL: Record<string, string> = { owner: 'Time responsável', contactEmail: 'E-mail de contato do time', endpoints: 'Endpoints da API' };

/** Sets a value by target path ("endpoints[3].parameters[1].description"). */
function setAt(obj: Record<string, unknown>, target: string, value: string) {
  const keys = target.replace(/\[(\d+)\]/g, '.$1').split('.');
  let o: any = obj;
  for (const k of keys.slice(0, -1)) {
    if (o == null) return false;
    o = o[k];
  }
  if (o == null) return false;
  o[keys[keys.length - 1]] = value;
  return true;
}

type Guide = { title: string; content: string; invented: string[] };

/**
 * What the panel has done so far (suggestions, progress, guide draft).
 * It lives in the API form, so closing the panel keeps the work and a search can finish in the background.
 */
export class DocAgentSession {
  tab = signal<'textos' | 'guia'>('textos');
  started = signal(false);
  running = signal(false);
  progress = signal(0);
  status = signal('');
  error = signal('');
  suggestions = signal<Suggestion[]>([]);
  dropped = signal<{ target: string; reason: string }[]>([]);
  topic = '';
  guideBusy = signal(false);
  guideError = signal('');
  guide = signal<Guide | null>(null);
  /** Shown when an earlier session had to be dropped. */
  notice = '';
  private endpoints: readonly object[] = [];

  constructor(readonly api: ApiInput) {}

  /** Remembers the route list the suggestions were made for (they point at endpoint indexes). */
  snapshot() {
    this.endpoints = [...this.api.endpoints];
  }

  /** Pending suggestions are only safe while the route list is the same, in the same order. */
  routesChanged() {
    const busy = this.running() || this.suggestions().some((s) => s.state === 'pending');
    const now = this.api.endpoints;
    return busy && (now.length !== this.endpoints.length || now.some((e, i) => e !== this.endpoints[i]));
  }
}

/**
 * "✨ Melhorar com IA" panel of the API form. Suggestions only change the form when accepted;
 * nothing is published until the admin saves.
 */
@Component({
  selector: 'app-doc-agent',
  imports: [ArrowKeys, AppDialog, FormsModule, MarkdownPipe],
  template: `
    <!-- Clicking outside does not close: only ✕, "Fechar" and Esc do, and the work is kept. -->
    <div class="backdrop">
    <section class="panel" appDialog (dismiss)="closed.emit()" role="dialog" aria-modal="true" aria-labelledby="agent-title">
      <header class="head">
        <div>
          <h2 id="agent-title">✨ Melhorar com IA</h2>
          <span class="small muted">{{ endpoint() != null ? 'Rota ' + routeOf(endpoint()!) : 'API inteira' }}</span>
        </div>
        <button class="btn btn-sm btn-ghost close" type="button" (click)="closed.emit()" aria-label="Fechar">✕</button>
      </header>
      <div class="tabs" appArrowKeys role="tablist">
        <button type="button" role="tab" [class.on]="tab() === 'textos'" [attr.aria-selected]="tab() === 'textos'" (click)="tab.set('textos')">Textos</button>
        @if (endpoint() == null) {
          <button type="button" role="tab" [class.on]="tab() === 'guia'" [attr.aria-selected]="tab() === 'guia'" (click)="tab.set('guia')">Escrever guia</button>
        }
      </div>

      <div class="body">
        @if (session().notice) { <div class="alert alert-warn small">{{ session().notice }}</div> }
        @if (tab() === 'textos') {
          @if (!started()) {
            <p class="small">
              A IA mira na nota 100: traduz títulos, escreve as descrições que faltam, explica parâmetros, respostas e credenciais,
              sugere exemplos de parâmetros e de respostas e completa as respostas de sucesso e de erro que não estão documentadas.
              Ela só usa as rotas, parâmetros e campos que já estão no cadastro, e você aprova cada sugestão.
            </p>
            <button class="btn btn-primary" type="button" (click)="run()">Procurar lacunas e sugerir</button>
          }
          @if (running()) {
            <div class="progress" role="status">
              <div class="bar"><span [style.width.%]="progress()"></span></div>
              <span class="small muted">{{ status() }}</span>
            </div>
          }
          @if (error()) { <div class="alert alert-error small" role="alert">{{ error() }}</div> }
          @if (started() && !running() && !suggestions().length && !error()) {
            <div class="alert alert-ok small">Nenhuma lacuna encontrada{{ endpoint() != null ? ' nesta rota' : '' }}. 🎉</div>
          }
          @if (started() && !running()) {
            <div class="score-box">
              <div class="row">
                <span class="small">Nota agora: <strong>{{ scoreNow() }}</strong>@if (pending() && scoreIfAll() > scoreNow()) { · aceitando as {{ pending() }} pendentes: <strong>{{ scoreIfAll() }}</strong>}</span>
                <span class="spacer"></span>
                @if (endpoint() == null) { <button class="btn btn-sm btn-ghost" type="button" (click)="run()" title="Depois de aceitar, pode haver lacunas novas (ex.: exemplo de uma resposta 200 recém-adicionada)">Procurar de novo</button> }
              </div>
              @if (endpoint() == null && (manual().length || needsGuide())) {
                <div class="manual small">
                  <strong>Para chegar a 100, falta também:</strong>
                  <ul>
                    @for (m of manual(); track m.target) { <li><button type="button" class="linkish" (click)="go.emit(m.target)">{{ m.label }}</button> <span class="muted">(só você sabe)</span></li> }
                    @if (needsGuide()) { <li>Um guia ou ReceAPIto · <button type="button" class="linkish" (click)="tab.set('guia')">escrever um guia com a IA</button></li> }
                  </ul>
                </div>
              }
            </div>
          }
          @if (suggestions().length) {
            <div class="row summary">
              <span class="small"><strong>{{ pending() }}</strong> para revisar · {{ accepted() }} aceitas · {{ rejected() }} recusadas</span>
              <span class="spacer"></span>
              <button class="btn btn-sm" type="button" (click)="acceptAll()" [disabled]="!pending()">Aceitar todas</button>
              <button class="btn btn-sm btn-ghost" type="button" (click)="rejectAll()" [disabled]="!pending()">Recusar todas</button>
            </div>
            @if (dropped().length) {
              <details class="small dropped">
                <summary>{{ dropped().length }} sugestão(ões) descartada(s): citavam algo que não existe ou não foram pedidas</summary>
                <ul>@for (d of dropped(); track $index) { <li><strong>{{ d.target }}</strong>: {{ d.reason }}</li> }</ul>
              </details>
            }
            <ol class="list">
              @for (s of suggestions(); track s.target) {
                <li class="item" [class]="'item ' + s.state">
                  <div class="row">
                    <strong class="small">{{ s.label }}</strong>
                    <span class="tag">{{ kinds[s.kind] }}</span>
                  </div>
                  @if (s.current) { <p class="current small"><span class="muted">Atual:</span> {{ s.current }}</p> }
                  @if (s.kind === 'json' && s.state === 'pending') {
                    <p class="small warn">Exemplo criado pela IA a partir dos nomes da rota: confira com uma resposta real (use "Testar este endpoint").</p>
                  }
                  @if (s.state === 'pending' && s.kind === 'responses') {
                    <ul class="adds small">@for (r of s.add!; track r.status) { <li><code>{{ r.status }}</code> {{ r.description }}</li> }</ul>
                    <div class="row">
                      <button class="btn btn-sm btn-primary" type="button" (click)="accept(s)">Adicionar</button>
                      <button class="btn btn-sm" type="button" (click)="reject(s)">Recusar</button>
                    </div>
                  } @else if (s.state === 'pending') {
                    <textarea [attr.aria-label]="'Sugestão para ' + s.label" [class.code]="s.kind === 'json'" [rows]="s.kind === 'json' ? 8 : s.target.endsWith('summary') || s.kind === 'example' ? 1 : 3" [(ngModel)]="s.value"></textarea>
                    <div class="row">
                      <button class="btn btn-sm btn-primary" type="button" (click)="accept(s)">Aceitar</button>
                      <button class="btn btn-sm" type="button" (click)="reject(s)">Recusar</button>
                    </div>
                  } @else {
                    <p class="small result">{{ s.state === 'accepted' ? (s.kind === 'responses' ? '✓ Respostas adicionadas na rota' : s.kind === 'json' ? '✓ Exemplo aplicado no formulário' : '✓ Aplicado no formulário: ' + s.value) : '✗ Recusado' }}</p>
                  }
                </li>
              }
            </ol>
          }
        } @else {
          <div class="field">
            <label for="guide-topic">Fluxo do guia</label>
            <input id="guide-topic" [(ngModel)]="topic" placeholder="Ex.: criar sessão → escolher unidade → criar processo → anexar documento" />
          </div>
          <button class="btn btn-primary" type="button" (click)="writeGuide()" [disabled]="guideBusy()">{{ guideBusy() ? 'Escrevendo…' : 'Escrever rascunho' }}</button>
          @if (guideError()) { <div class="alert alert-error small" role="alert">{{ guideError() }}</div> }
          @if (guide(); as g) {
            @if (g.invented.length) {
              <div class="alert alert-warn small">A IA citou rotas que não existem nesta API ({{ g.invented.join(', ') }}). Elas foram marcadas com ⚠️ no texto; corrija antes de adicionar.</div>
            }
            <div class="field">
              <label for="guide-title">Título</label>
              <input id="guide-title" [(ngModel)]="g.title" />
            </div>
            <div class="field">
              <label for="guide-content">Conteúdo (Markdown)</label>
              <textarea id="guide-content" rows="10" class="code" [(ngModel)]="g.content"></textarea>
            </div>
            <details class="preview">
              <summary class="small">Prévia</summary>
              <div class="markdown" [innerHTML]="g.content | markdown"></div>
            </details>
            <div class="row">
              <button class="btn btn-primary" type="button" (click)="addGuide()">Adicionar aos guias</button>
              <button class="btn" type="button" (click)="guide.set(null)">Descartar</button>
            </div>
          }
        }
      </div>
      <footer class="foot">
        <span class="small muted">Nada vai para o portal até você salvar ou publicar a API. Se fechar, as sugestões ficam guardadas.</span>
        <button class="btn btn-sm" type="button" (click)="closed.emit()">Fechar</button>
      </footer>
    </section>
    </div>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: var(--overlay); z-index: 90; display: grid; place-items: center; padding: 24px 16px; }
    .panel {
      width: min(860px, 100%); height: min(760px, calc(100dvh - 48px));
      background: var(--surface); color: var(--text); display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
      animation: agent-in 0.16s ease-out;
    }
    @keyframes agent-in { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
    .head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px 8px; }
    .head h2 { margin: 0; font-size: 1.1rem; }
    .close { margin-left: auto; }
    .tabs { display: flex; gap: 4px; padding: 0 18px 10px; border-bottom: 1px solid var(--border); }
    .tabs button { border: 1px solid var(--border); background: var(--surface); color: var(--text-2); font: inherit; font-size: 0.82rem; font-weight: 600; padding: 6px 12px; border-radius: 999px; cursor: pointer; }
    .tabs button.on { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
    .body { flex: 1; overflow: auto; padding: 14px 18px 18px; display: flex; flex-direction: column; gap: 12px; }
    .body p { margin: 0; }
    .progress { display: flex; flex-direction: column; gap: 6px; }
    .bar { height: 6px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--brand); transition: width 0.3s; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .item { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
    .item.accepted { border-color: var(--ok); background: var(--ok-soft); }
    .item.rejected { opacity: 0.6; }
    .current { text-decoration: line-through; color: var(--text-3); }
    .result { color: var(--text-2); }
    textarea { width: 100%; resize: vertical; }
    .dropped ul { margin: 6px 0 0; padding-left: 18px; }
    .score-box { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; background: var(--surface-2); }
    .manual ul { margin: 4px 0 0; padding-left: 18px; }
    .linkish { background: none; border: 0; padding: 0; font: inherit; color: var(--brand); cursor: pointer; text-decoration: underline; }
    .warn { color: var(--warn); }
    .adds { margin: 0; padding-left: 18px; }
    .preview { border: 1px dashed var(--border); border-radius: var(--radius); padding: 8px 12px; }
    .foot { padding: 10px 18px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
    .foot .btn { margin-left: auto; flex-shrink: 0; }
    @media (max-width: 640px) {
      .backdrop { padding: 0; }
      .panel { width: 100vw; height: 100dvh; border: 0; border-radius: 0; }
    }
  `,
})
export class DocAgent {
  private http = inject(HttpClient);
  /** The form model: accepted suggestions are written into it. */
  api = input.required<ApiInput>();
  /** Endpoint index, or null for the whole API. */
  endpoint = input<number | null>(null);
  /** Recipes that use the API (count as a guide in the score). */
  recipes = input(0);
  /** Kept by the form between openings. */
  session = input.required<DocAgentSession>();
  closed = output<void>();
  /** Fired after a suggestion or guide changes the form. */
  changed = output<void>();
  /** Jump to a field only a person can fill. */
  go = output<string>();

  kinds = KIND_LABELS;
  get tab() { return this.session().tab; }
  get started() { return this.session().started; }
  get running() { return this.session().running; }
  get progress() { return this.session().progress; }
  get status() { return this.session().status; }
  get error() { return this.session().error; }
  get suggestions() { return this.session().suggestions; }
  get dropped() { return this.session().dropped; }
  get guideBusy() { return this.session().guideBusy; }
  get guideError() { return this.session().guideError; }
  get guide() { return this.session().guide; }
  get topic() { return this.session().topic; }
  set topic(v: string) { this.session().topic = v; }
  pending = computed(() => this.suggestions().filter((s) => s.state === 'pending').length);
  accepted = computed(() => this.suggestions().filter((s) => s.state === 'accepted').length);
  rejected = computed(() => this.suggestions().filter((s) => s.state === 'rejected').length);

  // The form model changes in place: these recompute when the suggestions list (or a guide) changes.
  private tick = signal(0);
  private quality = computed(() => (this.suggestions(), this.tick(), docQuality(this.api(), { recipes: this.recipes() })));
  scoreNow = computed(() => this.quality().score);
  /** Score if every pending suggestion is accepted as it is. */
  scoreIfAll = computed(() => {
    const copy = structuredClone(this.api()) as unknown as Record<string, unknown>;
    for (const s of this.suggestions()) if (s.state === 'pending') this.applyTo(copy, s);
    return docQuality(copy as never, { recipes: this.recipes() }).score;
  });
  manual = computed(() => this.quality().items.flatMap((it) => it.pending).filter((c) => MANUAL[c.target]).map((c) => ({ target: c.target, label: MANUAL[c.target] })));
  needsGuide = computed(() => this.quality().items.some((it) => it.key === 'guias' && it.pending.length));


  routeOf(i: number) {
    const ep = this.api().endpoints[i];
    return ep ? `${ep.method} ${ep.path}` : '';
  }

  /** Looks for gaps, then asks for suggestions in small batches of endpoints. */
  async run() {
    // Captured: the search keeps writing here even if the panel is closed meanwhile.
    const { started, running, error, suggestions, dropped, status, progress } = this.session();
    this.session().notice = '';
    this.session().snapshot();
    started.set(true);
    running.set(true);
    error.set('');
    suggestions.set([]);
    dropped.set([]);
    const api = structuredClone(this.api());
    try {
      let batches: { endpoints: number[]; apiLevel: boolean }[];
      let parallel = PARALLEL;
      const one = this.endpoint();
      if (one != null) {
        batches = [{ endpoints: [one], apiLevel: false }];
      } else {
        status.set('Procurando lacunas…');
        const plan = await firstValueFrom(this.http.post<{ total: number; apiLevel: boolean; endpoints: number[]; parallel?: number }>('/api/ai/doc-gaps', { api }));
        parallel = plan.parallel || PARALLEL;
        batches = [];
        for (let i = 0; i < plan.endpoints.length; i += BATCH) batches.push({ endpoints: plan.endpoints.slice(i, i + BATCH), apiLevel: false });
        if (plan.apiLevel) batches.unshift({ endpoints: [], apiLevel: true });
      }
      // Several batches at a time. Each answer shows up as soon as it arrives, kept in route order;
      // the suggestion objects are reused, so what was already accepted keeps its state.
      const found: Suggestion[][] = batches.map(() => []);
      const failures: string[] = [];
      let done = 0;
      let next = 0;
      const report = () => {
        status.set(batches.length > 1 ? `Sugerindo textos… ${done} de ${batches.length} partes prontas` : 'Sugerindo textos…');
        progress.set(Math.round((done / batches.length) * 100));
      };
      report();
      const worker = async () => {
        while (next < batches.length) {
          const n = next++;
          const b = batches[n];
          try {
            const r = await firstValueFrom(
              this.http.post<{ suggestions: Omit<Suggestion, 'state'>[]; dropped: { target: string; reason: string }[] }>('/api/ai/improve', { api, endpoints: b.endpoints, apiLevel: b.apiLevel })
            );
            found[n] = r.suggestions.map((s) => ({ ...s, state: 'pending' as const }));
            suggestions.set(found.flat());
            dropped.update((l) => [...l, ...r.dropped]);
          } catch (e) {
            failures.push(errorMessage(e));
          } finally {
            done++;
            report();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
      if (failures.length === batches.length) throw new Error(failures[0]);
      if (failures.length) {
        error.set(`${failures.length} de ${batches.length} partes não responderam (${failures[0]}). As outras sugestões estão abaixo; use "Procurar de novo" para tentar o resto.`);
      }
      // Routes without a 2xx or without errors: standard responses, written here (no AI).
      const proposals = missingResponses(api, one != null ? [one] : null).map((p) => ({
        target: `endpoints[${p.endpoint}].responses`,
        kind: 'responses' as const,
        label: p.label,
        current: '',
        value: '',
        add: p.add,
        state: 'pending' as const,
      }));
      suggestions.update((l) => [...l, ...proposals]);
      progress.set(100);
    } catch (e) {
      error.set(errorMessage(e));
    } finally {
      running.set(false);
    }
  }

  /** Writes a suggestion into `obj` (the form model or a copy). */
  private applyTo(obj: Record<string, unknown>, s: Suggestion): boolean {
    if (s.kind === 'responses') {
      const i = Number(/^endpoints\[(\d+)\]/.exec(s.target)?.[1]);
      const ep = (obj['endpoints'] as { responses: QResponse[] }[] | undefined)?.[i];
      if (!ep) return false;
      const have = new Set(ep.responses.map((r) => r.status));
      ep.responses.push(...s.add!.filter((r) => !have.has(r.status)).map((r) => ({ ...r })));
      ep.responses.sort((a, b) => a.status - b.status);
      return true;
    }
    if (!s.value.trim()) return false;
    return setAt(obj, s.target, s.value.trim());
  }

  accept(s: Suggestion) {
    if (s.kind !== 'responses' && !s.value.trim()) return this.reject(s);
    if (this.applyTo(this.api() as unknown as Record<string, unknown>, s)) {
      s.state = 'accepted';
      this.suggestions.update((l) => [...l]);
      this.changed.emit();
    }
  }

  reject(s: Suggestion) {
    s.state = 'rejected';
    this.suggestions.update((l) => [...l]);
  }

  acceptAll() {
    for (const s of this.suggestions()) if (s.state === 'pending') this.accept(s);
  }

  rejectAll() {
    for (const s of this.suggestions()) if (s.state === 'pending') s.state = 'rejected';
    this.suggestions.update((l) => [...l]);
  }

  async writeGuide() {
    const { guide, guideBusy, guideError } = this.session();
    guideBusy.set(true);
    guideError.set('');
    try {
      guide.set(await firstValueFrom(this.http.post<Guide>('/api/ai/guide', { api: this.api(), topic: this.topic })));
    } catch (e) {
      guideError.set(errorMessage(e));
    } finally {
      guideBusy.set(false);
    }
  }

  addGuide() {
    const g = this.guide();
    if (!g) return;
    this.api().guides.push({ title: g.title.trim(), content: g.content.trim() });
    this.guide.set(null);
    this.tick.update((n) => n + 1);
    this.changed.emit();
    this.closed.emit();
  }
}

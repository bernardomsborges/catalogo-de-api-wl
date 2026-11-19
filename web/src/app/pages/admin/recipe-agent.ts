import { Component, ElementRef, inject, input, OnInit, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../../core/catalog.service';
import { RecipeDraft, RecipeService } from '../../core/recipe.service';
import { RecipeInput } from '../../core/recipes';
import { AssistantIcon } from '../../shared/assistant-icon';

type Turn =
  | { role: 'user'; text: string }
  | { role: 'agent'; message: string; questions: string[]; warnings: string[]; applied: boolean; steps: number }
  | { role: 'error'; text: string };

/**
 * "Montar com IA" in the ReceAPIto form: the admin describes the idea of the requests and the
 * agent fills the form with a draft. Follow-up messages adjust the draft that is in the form.
 * Nothing is saved until the admin saves the ReceAPIto.
 */
@Component({
  selector: 'app-recipe-agent',
  imports: [FormsModule, AssistantIcon],
  template: `
    <section class="card agent">
      <header class="head">
        <span class="avatar" aria-hidden="true"><app-assistant-icon [size]="22" /></span>
        <div>
          <h2>Montar com IA</h2>
          <p class="hint">Descreva a ideia das requisições, na ordem em que acontecem. O assistente escolhe as rotas no catálogo e preenche o formulário; você revisa e salva.</p>
        </div>
      </header>

      @if (enabled() === false) {
        <div class="alert alert-warn small">A IA não está configurada neste ambiente (LLM_BASE_URL). Monte os passos à mão, abaixo.</div>
      } @else {
        @if (turns().length) {
          <div #log class="log" aria-live="polite">
            @for (t of turns(); track $index) {
              @switch (t.role) {
                @case ('user') { <div class="bubble user">{{ t.text }}</div> }
                @case ('error') { <div class="alert alert-error small" role="alert">{{ t.text }}</div> }
                @case ('agent') {
                  <div class="bubble bot">
                    @if (t.applied) { <span class="done small">✓ Formulário preenchido com {{ t.steps }} passo{{ t.steps === 1 ? '' : 's' }}</span> }
                    @if (t.message) { <p>{{ t.message }}</p> }
                    @if (t.questions.length) {
                      <p class="label">{{ t.applied ? 'Ficou em aberto' : 'Preciso saber' }}</p>
                      <ul>@for (q of t.questions; track q) { <li>{{ q }}</li> }</ul>
                    }
                    @if (t.warnings.length) {
                      <p class="label warn">Confira antes de salvar</p>
                      <ul>@for (w of t.warnings; track w) { <li>{{ w }}</li> }</ul>
                    }
                  </div>
                }
              }
            }
            @if (busy()) { <div class="bubble bot thinking">Procurando as rotas no catálogo e montando os passos…</div> }
          </div>
        }

        <form class="compose" (ngSubmit)="send()">
          <label class="sr-only" for="agent-idea">{{ turns().length ? 'Peça um ajuste' : 'Ideia do ReceAPIto' }}</label>
          <textarea id="agent-idea" name="idea" [rows]="turns().length ? 2 : 4" [(ngModel)]="idea" (keydown.control.enter)="send()" [disabled]="busy()"
                    [placeholder]="turns().length ? 'Peça um ajuste… ex.: guarde também o número do processo; troque o passo 2 pela rota de consulta' : example"></textarea>
          <div class="row">
            <button class="btn btn-primary" type="submit" [disabled]="busy() || idea.trim().length < 5">
              {{ busy() ? 'Montando…' : turns().length ? 'Ajustar' : 'Montar ReceAPIto' }}
            </button>
            @if (undo().length) {
              <button class="btn" type="button" (click)="undoLast()" [disabled]="busy()">Desfazer a última alteração da IA</button>
            }
            <span class="spacer"></span>
            <span class="hint">Ctrl+Enter envia. Não cole senhas, chaves ou tokens.</span>
          </div>
        </form>

        @if (!turns().length) {
          <div class="examples">
            <span class="hint">Exemplos:</span>
            @for (e of examples; track e) { <button type="button" class="chip" (click)="idea = e">{{ e }}</button> }
          </div>
        }
      }
    </section>
  `,
  styles: `
    .agent { padding: 20px; display: flex; flex-direction: column; gap: 14px; border-color: var(--accent); background: linear-gradient(var(--surface), var(--surface)) padding-box, linear-gradient(135deg, var(--grad-stops)) border-box; border: 1px solid transparent; }
    .head { display: flex; gap: 12px; align-items: flex-start; }
    .avatar { width: 38px; height: 38px; flex-shrink: 0; border-radius: 12px; display: grid; place-items: center; color: var(--on-grad); background: linear-gradient(135deg, var(--grad-stops)); }
    h2 { margin: 0 0 2px; font-size: 1.1rem; }
    .hint { font-size: 0.82rem; color: var(--text-3); margin: 0; }
    .log { display: flex; flex-direction: column; gap: 10px; max-height: 360px; overflow-y: auto; padding: 4px 2px; }
    .bubble { max-width: 88%; padding: 10px 14px; border-radius: 14px; font-size: 0.9rem; line-height: 1.5; }
    .bubble p { margin: 0 0 6px; }
    .bubble p:last-child { margin-bottom: 0; }
    .bubble ul { margin: 0 0 6px; padding-left: 18px; }
    .user { align-self: flex-end; background: var(--brand); color: var(--on-brand); border-bottom-right-radius: 4px; white-space: pre-wrap; }
    .bot { align-self: flex-start; background: var(--surface-2); color: var(--text); border-bottom-left-radius: 4px; }
    .thinking { color: var(--text-3); animation: pulse 1.4s ease-in-out infinite; }
    .done { display: inline-block; margin-bottom: 6px; font-weight: 600; color: var(--ok); }
    .label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-3); }
    .label.warn { color: var(--warn); }
    .compose { display: flex; flex-direction: column; gap: 10px; }
    .examples { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); font: inherit; font-size: 0.8rem; padding: 4px 10px; border-radius: 999px; cursor: pointer; text-align: left; }
    .chip:hover { border-color: var(--brand); color: var(--text); }
    @keyframes pulse { 50% { opacity: 0.5; } }
    @media (prefers-reduced-motion: reduce) { .thinking { animation: none; } }
  `,
})
export class RecipeAgent implements OnInit {
  private service = inject(RecipeService);
  /** Reads the form as it is now. */
  current = input.required<() => RecipeInput>();
  /** A draft to put in the form. */
  apply = output<NonNullable<RecipeDraft['recipe']>>();
  /** Puts back the form as it was before the last draft. */
  restore = output<RecipeInput>();

  /** null while checking. */
  enabled = signal<boolean | null>(null);
  idea = '';
  busy = signal(false);
  turns = signal<Turn[]>([]);
  /** The form before each draft was applied. */
  undo = signal<RecipeInput[]>([]);
  private log = viewChild<ElementRef<HTMLElement>>('log');

  example = 'Ex.: entrar no SEI com usuário e senha, listar as unidades, abrir um processo na primeira unidade e anexar um PDF nele.';
  examples = [
    'Fazer login, pegar o token e listar os processos da minha unidade',
    'Buscar o código do IBGE de um município pelo nome e consultar a população estimada',
    'Consultar um CEP e depois a previsão do tempo para a cidade encontrada',
  ];

  async ngOnInit() {
    this.enabled.set(await this.service.aiEnabled());
  }

  async send() {
    const idea = this.idea.trim();
    if (this.busy() || idea.length < 5) return;
    const before = this.current()();
    const history = this.turns().flatMap((t) => (t.role === 'user' ? [t.text] : []));
    this.turns.update((t) => [...t, { role: 'user', text: idea }]);
    this.idea = '';
    this.busy.set(true);
    this.scroll();
    try {
      // A form with no route chosen yet is a blank start, not a draft to adjust.
      const draft = before.steps.some((s) => s.path) ? before : null;
      const r = await this.service.draft(idea, draft, history);
      if (r.recipe) {
        this.undo.update((u) => [...u, before]);
        this.apply.emit(r.recipe);
      }
      this.turns.update((t) => [...t, { role: 'agent', message: r.message, questions: r.questions, warnings: r.warnings, applied: !!r.recipe, steps: r.recipe?.steps.length ?? 0 }]);
    } catch (e) {
      this.turns.update((t) => [...t, { role: 'error', text: errorMessage(e) }]);
      this.idea = idea;
    } finally {
      this.busy.set(false);
      this.scroll();
    }
  }

  undoLast() {
    const prev = this.undo().at(-1);
    if (!prev) return;
    this.undo.update((u) => u.slice(0, -1));
    this.restore.emit(prev);
    this.turns.update((t) => [...t, { role: 'agent', message: 'Desfiz a última alteração: o formulário voltou a como estava antes.', questions: [], warnings: [], applied: false, steps: 0 }]);
    this.scroll();
  }

  private scroll() {
    setTimeout(() => {
      const el = this.log()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}

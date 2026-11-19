import { Component, computed, effect, ElementRef, inject, signal, untracked, viewChild } from '@angular/core';
import { AppDialog } from './dialog';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth';
import { AskAnswer, AskService, AskStep } from '../core/ask.service';
import { CatalogService, errorMessage } from '../core/catalog.service';
import { cloudCode, padCode, powerAutomateAsked } from '../core/power-automate';
import { emptyRecipe, stepFromEndpoint } from '../core/recipes';
import { generateSnippets, Snippet } from '../core/snippets';
import { MarkdownPipe } from './markdown.pipe';
import { AssistantIcon } from './assistant-icon';
import { CodeTabs } from './ui';

type Turn = { role: 'user'; text: string } | { role: 'assistant'; answer: AskAnswer } | { role: 'error'; text: string };

/**
 * Catalog assistant: a side button on every page opens a chat that can read the catalog data
 * (APIs, routes, recipes, status) and points to the routes to use.
 */
@Component({
  selector: 'app-ask-panel',
  imports: [AppDialog, FormsModule, RouterLink, MarkdownPipe, CodeTabs, AssistantIcon],
  host: { '(document:pointerdown)': 'outside($event)' },
  template: `
    <button type="button" class="launcher" (click)="toggle()" [attr.aria-expanded]="ask.open()"
            [attr.aria-label]="ask.open() ? 'Fechar o assistente de IA' : 'Abrir o assistente de IA do catálogo'">
      <app-assistant-icon [size]="ask.open() ? 24 : 30" [close]="ask.open()" />
      @if (!ask.open()) { <span class="launcher-tip">Assistente do catálogo</span> }
    </button>

    @if (ask.open()) {
      <div class="backdrop" aria-hidden="true"></div>
      <aside class="panel" appDialog [trap]="false" (dismiss)="ask.close()" role="dialog" aria-modal="false" aria-labelledby="ask-title">
        <header class="head">
          <span class="avatar" aria-hidden="true"><app-assistant-icon [size]="24" /></span>
          <div class="identity">
            <h2 id="ask-title">Assistente do catálogo</h2>
            <span class="online"><span class="online-dot"></span>Consulta APIs, rotas e ReceAPItos</span>
            @if (ask.api(); as a) {
              <span class="scope">Sobre <strong>{{ a.name }}</strong> <button type="button" class="link" (click)="ask.api.set(null)" aria-label="Perguntar sobre todo o catálogo">×</button></span>
            }
          </div>
          <div class="head-actions">
            @if (turns().length) {
              <button class="new-chat" type="button" (click)="reset()">Nova conversa</button>
            }
            <button class="close" type="button" (click)="ask.close()" aria-label="Fechar assistente">×</button>
          </div>
        </header>

        <div #scroller class="body" (click)="intercept($event)" aria-live="polite">
          @if (!turns().length) {
            <p class="small muted">Pergunte sobre as APIs do catálogo ou descreva o que você quer fazer. Exemplos:</p>
            <div class="examples">
              @for (e of examples; track e) { <button type="button" class="chip" (click)="question = e; send()">{{ e }}</button> }
            </div>
          }

          @for (t of turns(); track $index) {
            @switch (t.role) {
              @case ('user') { <div class="bubble user">{{ t.text }}</div> }
              @case ('error') { <div class="alert alert-error small" role="alert">{{ t.text }}</div> }
              @case ('assistant') {
                @let r = t.answer;
                <div class="bubble bot">
                  @if (r.aiOff) {
                    <div class="alert alert-warn small">O assistente de IA não está configurado. Estas são as rotas mais parecidas com a sua pergunta:</div>
                  } @else if (r.answer) {
                    <div class="answer markdown" [innerHTML]="r.answer | markdown"></div>
                  }

                  @if (r.steps.length) {
                    <h3>{{ r.aiOff ? 'Rotas encontradas' : 'Passo a passo' }}</h3>
                    <ol class="steps">
                      @for (s of r.steps; track $index; let i = $index) {
                        <li>
                          <span class="num">{{ i + 1 }}</span>
                          <div class="step">
                            @if (s.kind === 'recipe') {
                              <a [routerLink]="s.link" (click)="ask.close()"><strong>ReceAPIto: {{ s.title }}</strong></a>
                            } @else {
                              <a [routerLink]="path(s.link)" [fragment]="frag(s.link)"><code class="route"><span class="m">{{ s.method }}</span> {{ s.path }}</code></a>
                              <span class="small muted">{{ s.title }} · {{ s.apiName }}</span>
                            }
                            @if (s.why) { <span class="small">{{ s.why }}</span> }
                            @if (s.credentials.length) {
                              <span class="creds small">🔒 {{ s.credentials.join(s.credentialsMode === 'any' ? ' ou ' : ' + ') }}</span>
                            }
                            @if (s.kind === 'endpoint') {
                              <span class="links small">
                                <a [routerLink]="path(s.link)" [fragment]="frag(s.link)">Referência</a>
                                <a [routerLink]="path(s.link)" [queryParams]="{ testar: frag(s.link) }" [fragment]="frag(s.link)">Testar no console</a>
                              </span>
                              @if (snippetsFor(s).length) {
                                <div class="step-example">
                                  <span class="small muted">Exemplo: {{ s.method }} {{ s.path }}</span>
                                  <app-code-tabs [snippets]="snippetsFor(s)" [prefer]="powerAutomate()" />
                                </div>
                              }
                            }
                          </div>
                        </li>
                      }
                    </ol>
                  }

                  @if (!r.found && r.contacts.length) {
                    <div class="none small">
                      <p>Fale com quem cuida{{ r.contacts[0].api ? ' das APIs relacionadas' : ' do catálogo' }}:</p>
                      <ul>
                        @for (c of r.contacts; track $index) {
                          <li>
                            @if (c.slug) { <a [routerLink]="['/apis', c.slug]">{{ c.api }}</a> — }
                            {{ c.owner || 'time responsável' }}
                            @if (c.email) { · <a [href]="'mailto:' + c.email">{{ c.email }}</a> }
                          </li>
                        }
                      </ul>
                      <p class="muted">Registramos a pergunta, sem identificar você, para melhorar a documentação.</p>
                    </div>
                  }
                </div>
              }
            }
          }
          @if (loading()) { <div class="bubble bot thinking">Consultando o catálogo…</div> }
        </div>

        <form class="question" (ngSubmit)="send()">
          <label class="sr-only" for="ask-q">Sua pergunta</label>
          <div class="compose">
            <textarea #q id="ask-q" name="q" rows="2" [(ngModel)]="question" (keydown.enter)="enter($event)"
                      [placeholder]="turns().length ? 'Continue a conversa…' : 'Escreva sua mensagem…'"></textarea>
            <button class="send-btn" type="submit" aria-label="Enviar mensagem" [disabled]="loading() || question.trim().length < 3">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                <path d="M4.5 11.6 19.2 4.9a.6.6 0 0 1 .8.8l-6.7 14.7a.6.6 0 0 1-1.1-.06l-1.9-5.6-5.6-1.9a.6.6 0 0 1-.2-1.04z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
                <path d="M10.4 13.6 15.4 8.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <span class="hint">Respostas geradas por IA a partir do catálogo. Não cole chaves, senhas ou tokens.</span>
        </form>
      </aside>
    }
  `,
  styles: `
    .launcher {
      position: fixed; right: 24px; bottom: 24px; z-index: 92;
      display: grid; place-items: center; width: 60px; height: 60px;
      border: 0; border-radius: 50%; cursor: pointer;
      background: linear-gradient(135deg, var(--grad-stops)); color: var(--on-grad); font: inherit; font-size: 1.75rem;
      box-shadow: 0 8px 26px rgba(9, 9, 11, 0.3); transition: transform 0.18s ease, box-shadow 0.18s ease;
    }
    .launcher:hover, .launcher:focus-visible { transform: translateY(-3px); box-shadow: 0 12px 30px rgba(9, 9, 11, 0.36); }
    .launcher-tip { position: absolute; right: 72px; padding: 7px 11px; border-radius: 8px; background: var(--surface); color: var(--text); border: 1px solid var(--border); box-shadow: var(--shadow-lg); font-size: 0.8rem; font-weight: 600; white-space: nowrap; opacity: 0; transform: translateX(4px); pointer-events: none; transition: opacity 0.15s, transform 0.15s; }
    .launcher:hover .launcher-tip, .launcher:focus-visible .launcher-tip { opacity: 1; transform: none; }
    .backdrop { position: fixed; inset: 0; z-index: 89; background: rgba(9, 9, 11, 0.06); backdrop-filter: blur(1.5px); pointer-events: none; }
    .panel { position: fixed; right: 24px; bottom: 98px; width: min(560px, calc(100vw - 32px)); height: min(580px, calc(100dvh - 150px)); background: var(--surface); color: var(--text); z-index: 91; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 18px 55px rgba(9, 9, 11, 0.28); animation: chat-in 0.18s ease-out; }
    @keyframes chat-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }
    .head { display: flex; align-items: center; gap: 11px; padding: 13px 14px; background: linear-gradient(120deg, var(--grad-stops)); color: var(--on-grad); flex: none; }
    .avatar { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border-radius: 50%; background: var(--surface); color: var(--brand); box-shadow: 0 2px 8px rgba(9, 9, 11, 0.18); }
    .identity { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .head h2 { margin: 0; font-size: 0.98rem; line-height: 1.2; }
    .online { display: flex; align-items: center; gap: 5px; font-size: 0.72rem; opacity: 0.82; }
    .online-dot { width: 7px; height: 7px; border-radius: 50%; background: #52d273; box-shadow: 0 0 0 2px rgba(82, 210, 115, 0.18); }
    .scope { font-size: 0.72rem; opacity: 0.9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .link { background: none; border: 0; color: inherit; cursor: pointer; font-size: 0.9rem; padding: 0 4px; }
    .head-actions { display: flex; align-items: center; gap: 6px; }
    .new-chat, .close { border: 0; cursor: pointer; color: inherit; background: rgba(255, 255, 255, 0.14); }
    .new-chat { border-radius: 999px; padding: 6px 9px; font: inherit; font-size: 0.7rem; white-space: nowrap; }
    .new-chat:hover, .close:hover { background: rgba(255, 255, 255, 0.24); }
    .close { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; font-size: 1.35rem; line-height: 1; }
    .body { flex: 1; min-height: 0; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; background: var(--surface); }
    .examples { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .chip { border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 0.85rem; cursor: pointer; text-align: left; }
    .chip:hover { border-color: var(--brand); }
    .bubble { border-radius: 14px; padding: 10px 12px; max-width: 100%; overflow-wrap: anywhere; font-size: 0.9rem; }
    .bubble.user { align-self: flex-end; background: var(--brand); color: var(--on-brand); max-width: 88%; white-space: pre-wrap; border-bottom-right-radius: 5px; }
    .bubble.bot { align-self: stretch; background: var(--surface-2); border: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; border-bottom-left-radius: 5px; }
    .thinking { color: var(--text-3); animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.45; } }
    h3 { font-size: 0.9rem; margin: 6px 0 2px; }
    .answer :first-child { margin-top: 0; }
    .answer :last-child { margin-bottom: 0; }
    .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .steps li { display: flex; gap: 10px; align-items: flex-start; }
    .num { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--brand); color: var(--on-brand); font-size: 0.75rem; font-weight: 700; }
    .step { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .step-example { display: flex; flex-direction: column; gap: 4px; margin-top: 5px; }
    .route { font-size: 0.8rem; word-break: break-all; }
    .m { font-weight: 700; }
    .creds { color: var(--text-2); }
    .links { display: flex; gap: 12px; }
    .none p { margin: 0 0 4px; }
    .none ul { margin: 0 0 4px; padding-left: 18px; }
    .question { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); background: var(--surface); flex: none; }
    .compose { display: flex; align-items: flex-end; gap: 8px; }
    .question textarea { flex: 1; min-width: 0; resize: none; min-height: 42px; max-height: 120px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); color: var(--text); font: inherit; font-size: 0.88rem; }
    .question textarea:focus { outline: 2px solid color-mix(in srgb, var(--brand) 40%, transparent); border-color: var(--brand); }
    .hint { font-size: 0.68rem; color: var(--text-3); }
    .send-btn { flex: none; display: grid; place-items: center; width: 42px; height: 42px; border: 0; border-radius: 12px; color: var(--on-grad); background: linear-gradient(135deg, var(--grad-stops)); font-size: 1.15rem; cursor: pointer; transition: transform 0.15s, opacity 0.15s; }
    .send-btn:not(:disabled):hover { transform: translateY(-2px); }
    .send-btn:disabled { opacity: 0.45; cursor: default; }
    @media (max-width: 640px) {
      .launcher { right: 16px; bottom: 16px; width: 56px; height: 56px; }
      .launcher-tip { display: none; }
      .panel { right: 12px; bottom: 84px; width: min(560px, calc(100vw - 24px)); height: min(600px, calc(100dvh - 120px)); border-radius: 16px; }
      .head { padding: 11px 12px; }
      .body { padding: 12px; }
      .hint { max-width: 68%; }
    }
  `,
})
export class AskPanel {
  ask = inject(AskService);
  private catalog = inject(CatalogService);
  private router = inject(Router);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private input = viewChild<ElementRef<HTMLTextAreaElement>>('q');
  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private snippetCache = new Map<string, Snippet[]>();

  question = '';
  loading = signal(false);
  turns = signal<Turn[]>([]);
  examples = [
    'Quais APIs existem no catálogo e qual o status de cada uma?',
    'Como anexo um PDF a um processo e envio para outra unidade?',
    'Quem é o responsável pela API de notificações?',
    'Alguma API está fora do ar agora?',
  ];

  /** 'pad' | 'pa-cloud' once the person asks for help building in Power Automate (the last mention wins). */
  powerAutomate = computed(() => {
    for (const t of [...this.turns()].reverse()) {
      const asked = t.role === 'user' ? powerAutomateAsked(t.text) : null;
      if (asked) return asked;
    }
    return null;
  });

  /**
   * Generates the same runnable examples used in the API reference for each route step, plus the
   * Power Automate versions when the conversation asks for them.
   */
  snippetsFor(step: AskStep): Snippet[] {
    if (step.kind !== 'endpoint' || !step.apiSlug || !step.method || !step.path) return [];
    const pa = !!this.powerAutomate();
    const key = `${step.apiSlug}:${step.method}:${step.path}:${pa}`;
    const api = this.catalog.apis().find((a) => a.slug === step.apiSlug);
    const ep = api?.endpoints.find((e) => e.method === step.method && e.path === step.path);
    if (!api || !ep) return [];

    const cached = this.snippetCache.get(key);
    if (cached) return cached;

    const snippets = generateSnippets(api, ep).filter((s) => ['curl', 'python', 'javascript', 'go'].includes(s.lang));
    if (pa) {
      const recipe = { ...emptyRecipe(), title: ep.summary || `${ep.method} ${ep.path}`, steps: [stepFromEndpoint(api, ep)] };
      const apis = this.catalog.apis();
      snippets.push({ lang: 'pad', label: 'PA Desktop', code: padCode(recipe, apis) }, { lang: 'pa-cloud', label: 'PA Cloud', code: cloudCode(recipe, apis).actions[0]?.json ?? '' });
    }
    this.snippetCache.set(key, snippets);
    return snippets;
  }

  constructor() {
    effect(() => {
      if (!this.ask.open()) return;
      untracked(() => {
        if (!this.catalog.apis().length) this.catalog.refresh();
        const draft = this.ask.draft();
        if (draft) {
          this.question = draft;
          this.ask.draft.set('');
          this.send();
        }
        setTimeout(() => this.input()?.nativeElement.focus());
      });
    });
  }

  /**
   * Closes when the person clicks anywhere outside the chat (and outside the button).
   * Uses pointerdown, so a button elsewhere that opens the chat on click isn't undone right away.
   */
  outside(e: Event) {
    if (this.ask.open() && !this.host.nativeElement.contains(e.target as Node)) this.ask.close();
  }

  toggle() {
    if (this.ask.open()) this.ask.close();
    else this.ask.show({ api: this.ask.pageApi() });
  }

  enter(e: Event) {
    const k = e as KeyboardEvent;
    if (!k.shiftKey) {
      k.preventDefault();
      this.send();
    }
  }

  /** A new person (login/logout) starts a new conversation: answers depended on the old permissions. */
  private resetOnAccountChange = effect(() => {
    const who = this.auth.current()?.id ?? null;
    if (who !== this.lastAccount) {
      this.lastAccount = who;
      untracked(() => {
        this.turns.set([]);
        this.snippetCache.clear();
      });
    }
  });
  private lastAccount: string | null | undefined = undefined;
  private auth = inject(AuthService);

  reset() {
    this.turns.set([]);
    this.question = '';
    setTimeout(() => this.input()?.nativeElement.focus());
  }

  /** Text of the conversation so far (for follow-up questions). */
  private history() {
    return this.turns()
      .filter((t) => t.role !== 'error')
      .map((t) => (t.role === 'user' ? { role: 'user' as const, content: t.text } : { role: 'assistant' as const, content: (t as { answer: AskAnswer }).answer.answer || '' }));
  }

  async send() {
    const q = this.question.trim();
    if (q.length < 3 || this.loading()) return;
    const history = this.history();
    this.question = '';
    this.turns.update((l) => [...l, { role: 'user', text: q }]);
    this.loading.set(true);
    this.scrollDown();
    try {
      const answer = await this.ask.ask(q, this.ask.api()?.slug, history);
      this.turns.update((l) => [...l, { role: 'assistant', answer }]);
    } catch (e) {
      this.turns.update((l) => [...l, { role: 'error', text: errorMessage(e) }]);
    } finally {
      this.loading.set(false);
      this.scrollDown();
    }
  }

  private scrollDown() {
    setTimeout(() => {
      const el = this.scroller()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  path = (link: string) => link.split('#')[0];
  frag = (link: string) => link.split('#')[1] || undefined;

  /** Links inside the generated answer navigate in the app instead of reloading the page. */
  intercept(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('.answer a');
    const href = a?.getAttribute('href');
    if (a && href?.startsWith('/')) {
      e.preventDefault();
      this.router.navigateByUrl(href);
    }
  }
}

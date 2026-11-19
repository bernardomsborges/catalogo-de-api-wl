import { Component, computed, inject, input, signal } from '@angular/core';
import { ArrowKeys } from './arrow-keys';
import { Api } from '../core/models';
import { cloudCode, padCode } from '../core/power-automate';
import { curlCode, goCode, pythonCode, RecipeInput } from '../core/recipes';
import { ToastService } from './toast';
import { CodeTabs } from './ui';

type Target = 'curl' | 'python' | 'go' | 'pad' | 'pa-cloud';

interface Option {
  id: Target;
  label: string;
  hint: string;
}

const GROUPS: { title: string; options: Option[] }[] = [
  {
    title: 'Código',
    options: [
      { id: 'curl', label: 'cURL', hint: 'Script de terminal' },
      { id: 'python', label: 'Python', hint: 'Script .py' },
      { id: 'go', label: 'Go', hint: 'Programa .go' },
    ],
  },
  {
    title: 'Power Automate',
    options: [
      { id: 'pad', label: 'Desktop', hint: 'Fluxo de desktop' },
      { id: 'pa-cloud', label: 'Cloud', hint: 'Fluxo de nuvem' },
    ],
  },
];
const TARGETS = GROUPS.flatMap((g) => g.options.map((o) => o.id));
const FILES: Partial<Record<Target, string>> = { curl: 'receapito.sh', python: 'receapito.py', go: 'receapito.go' };
const STORE = 'catalogo-receapito-formato';

/**
 * A ReceAPIto ready to use: the reader says where they will run it and sees only that version
 * (code to download, or what to paste in Power Automate). The choice is remembered.
 */
@Component({
  selector: 'app-recipe-code',
  imports: [ArrowKeys, CodeTabs],
  template: `
    <section class="use">
      <h2>Leve pronto</h2>
      <p class="small muted lead">Onde você vai usar este ReceAPIto? Mostramos só o que serve para a sua escolha.</p>

      <div class="groups">
        @for (g of groups; track g.title) {
          <div class="group" appArrowKeys role="radiogroup" [attr.aria-label]="g.title">
            <span class="group-title small">{{ g.title }}</span>
            <div class="options">
              @for (o of g.options; track o.id) {
                <button type="button" class="option" role="radio" [attr.aria-checked]="target() === o.id" [class.on]="target() === o.id" (click)="choose(o.id)">
                  <strong>{{ o.label }}</strong>
                  <span class="small">{{ o.hint }}</span>
                </button>
              }
            </div>
          </div>
        }
      </div>

      @switch (target()) {
        @case (null) {
          <p class="empty small muted">Escolha uma opção acima para ver o código ou as ações prontas para colar.</p>
        }
        @case ('pad') {
          <ol class="how small">
            <li>Copie o texto abaixo.</li>
            <li>No Power Automate Desktop, clique na área de ações do fluxo e pressione <kbd>Ctrl</kbd>+<kbd>V</kbd>.</li>
            <li>Troque os <code>PREENCHA</code> pelos seus valores.</li>
          </ol>
          <app-code-tabs [snippets]="[{ lang: 'pad', label: 'Ações do Power Automate Desktop', code: pad() }]" [remember]="false" />
        }
        @case ('pa-cloud') {
          <ol class="how small">
            <li>Copie a ação do passo 1, clique no <strong>+</strong> do fluxo e escolha <em>Colar uma ação</em> (ou <kbd>Ctrl</kbd>+<kbd>V</kbd>).</li>
            <li>Repita com os outros passos, <strong>na ordem</strong>. Cada um entra como uma ação HTTP já preenchida.</li>
            <li>Troque os <code>PREENCHA</code> pelos seus valores.</li>
          </ol>
          <ul class="rows">
            @for (a of cloud().actions; track a.name) {
              <li>
                <span class="label">{{ a.label }}</span>
                <code>{{ a.name }}</code>
                <button type="button" class="btn btn-sm" (click)="toast.copy(a.json, 'Ação copiada')" [attr.aria-label]="'Copiar ação do ' + a.label">Copiar ação</button>
              </li>
            }
          </ul>
          <p class="small muted note">
            A ação HTTP é um conector premium. Os passos leem a resposta dos anteriores pelos nomes <code>HTTP</code>, <code>HTTP_1</code>, <code>HTTP_2</code>… que o designer dá a cada ação colada; se o fluxo já tiver outra ação HTTP, ajuste esses nomes nas expressões.
          </p>
          @if (cloud().expressions.length) {
            <details class="more">
              <summary>Expressões para ler as respostas ({{ cloud().expressions.length }})</summary>
              <ul class="rows">
                @for (e of cloud().expressions; track e.expr) {
                  <li>
                    <span class="label">{{ e.label }}</span>
                    <code>{{ e.expr }}</code>
                    <button type="button" class="btn btn-sm" (click)="toast.copy(e.expr)" [attr.aria-label]="'Copiar expressão de ' + e.label">Copiar</button>
                  </li>
                }
              </ul>
            </details>
          }
        }
        @default {
          <div class="bar">
            <p class="small muted">
              Roda os passos em ordem e para com a mensagem da API se algo der errado. Seus dados vêm de variáveis de ambiente.
              @switch (target()) {
                @case ('curl') { Usa <code>jq</code> para ler as respostas. }
                @case ('python') { Precisa da biblioteca <code>requests</code>. }
                @case ('go') { Só usa a biblioteca padrão. }
              }
            </p>
            <button class="btn btn-sm" type="button" (click)="download()">Baixar {{ file() }}</button>
          </div>
          <app-code-tabs [snippets]="[{ lang: target()!, label: file()!, code: code() }]" [remember]="false" />
        }
      }
    </section>
  `,
  styles: `
    .use { display: flex; flex-direction: column; gap: 12px; }
    h2 { margin: 0; font-size: 1.1rem; }
    p { margin: 0; }
    .lead { margin-top: -8px; }
    .groups { display: flex; flex-wrap: wrap; gap: 12px 24px; }
    .group { display: flex; flex-direction: column; gap: 6px; flex: 1 1 0; min-width: min(100%, 260px); }
    .group:first-child { flex-grow: 3; }
    .group:last-child { flex-grow: 2; }
    .group-title { font-weight: 600; color: var(--text-2); }
    .options { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 8px; }
    .option { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface); color: inherit; font: inherit; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
    .option span { color: var(--text-3); }
    .option:hover { border-color: var(--brand); }
    .option.on { border-color: var(--brand); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--brand); }
    .option.on span { color: var(--text-2); }
    .empty { padding: 22px; border: 1px dashed var(--border-strong); border-radius: 12px; text-align: center; }
    .bar { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .bar p { flex: 1 1 280px; }
    .how { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; color: var(--text-2); }
    kbd { padding: 1px 5px; border: 1px solid var(--border-strong); border-radius: 5px; font-size: 0.75rem; background: var(--surface-2); }
    .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .rows li { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr) auto; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
    .label { font-weight: 600; font-size: 0.85rem; color: var(--text-2); }
    .rows code { font-size: 0.8rem; overflow-wrap: anywhere; }
    .more summary { cursor: pointer; color: var(--text-2); font-size: 0.9rem; margin-bottom: 8px; }
    @media (max-width: 560px) {
      .options { grid-auto-flow: row; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
      .rows li { grid-template-columns: 1fr auto; }
      .rows code { grid-column: 1 / -1; grid-row: 2; }
    }
  `,
})
export class RecipeCode {
  toast = inject(ToastService);
  recipe = input.required<RecipeInput>();
  apis = input.required<Api[]>();

  groups = GROUPS;
  target = signal<Target | null>(RecipeCode.remembered());

  file = computed(() => FILES[this.target() ?? 'pad'] ?? null);
  code = computed(() => {
    const t = this.target();
    return t === 'curl' ? curlCode(this.recipe(), this.apis()) : t === 'python' ? pythonCode(this.recipe(), this.apis()) : t === 'go' ? goCode(this.recipe(), this.apis()) : '';
  });
  pad = computed(() => (this.target() === 'pad' ? padCode(this.recipe(), this.apis()) : ''));
  cloud = computed(() => (this.target() === 'pa-cloud' ? cloudCode(this.recipe(), this.apis()) : { actions: [], expressions: [] }));

  private static remembered(): Target | null {
    try {
      const t = localStorage.getItem(STORE) as Target | null;
      return t && TARGETS.includes(t) ? t : null;
    } catch {
      return null;
    }
  }

  choose(t: Target) {
    this.target.set(t);
    try {
      localStorage.setItem(STORE, t);
    } catch {
      /* ignore */
    }
  }

  download() {
    const name = this.file();
    if (!name) return;
    const url = URL.createObjectURL(new Blob([this.code()], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
}

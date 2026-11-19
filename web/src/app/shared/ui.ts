import { Component, computed, inject, input, signal } from '@angular/core';
import { ApiStatus, HttpMethod, STATUS_LABELS } from '../core/models';
import { Snippet } from '../core/snippets';
import { ToastService } from './toast';

@Component({
  selector: 'app-status-badge',
  template: `<span class="badge status-{{ status() }}">{{ label() }}</span>`,
})
export class StatusBadge {
  status = input.required<ApiStatus>();
  label = computed(() => STATUS_LABELS[this.status()] ?? this.status());
}

@Component({
  selector: 'app-method',
  template: `<span class="method method-{{ method().toLowerCase() }}">{{ method() }}</span>`,
})
export class MethodBadge {
  method = input.required<HttpMethod>();
}

/** Dark code panel with language tabs and a copy button (Stripe-style). */
@Component({
  selector: 'app-code-tabs',
  template: `
    <div class="code-panel">
      <div class="code-head">
        @if (snippets().length > 1) {
          <div class="code-tabs" role="group" aria-label="Linguagem">
            @for (s of snippets(); track s.lang) {
              <button type="button" [class.active]="s.lang === current().lang" [attr.aria-pressed]="s.lang === current().lang" (click)="select(s.lang)">
                {{ s.label }}
              </button>
            }
          </div>
        } @else {
          <span class="code-title">{{ title() || current().label }}</span>
        }
        <button type="button" class="copy" (click)="copy()">{{ copied() ? 'Copiado!' : 'Copiar' }}</button>
      </div>
      <!-- tabindex: a long line scrolls sideways, and the keyboard must reach it too. -->
      <pre tabindex="0"><code>{{ current().code }}</code></pre>
    </div>
  `,
})
export class CodeTabs {
  snippets = input.required<Snippet[]>();
  title = input('');
  /** Tab to open with, when the page knows what the reader wants. */
  prefer = input<string | null>(null);
  /** false: picking a tab here doesn't change the language remembered for the other code panels. */
  remember = input(true);
  private toast = inject(ToastService);
  private picked = signal<string | null>(null);
  copied = signal(false);

  current = computed(() => {
    const lang = this.picked() ?? this.prefer() ?? (this.remember() ? CodeTabs.preferred() : null);
    return this.snippets().find((s) => s.lang === lang) ?? this.snippets()[0];
  });

  // Remember the reader's language across pages, like Stripe does.
  private static preferred(): string {
    try {
      return localStorage.getItem('catalogo-lang') || 'curl';
    } catch {
      return 'curl';
    }
  }

  select(lang: string) {
    this.picked.set(lang);
    if (!this.remember()) return;
    try {
      localStorage.setItem('catalogo-lang', lang);
    } catch {
      /* ignore */
    }
  }

  async copy() {
    if (!(await this.toast.copy(this.current().code))) return;
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}

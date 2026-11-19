import { Component, inject, Injectable, signal } from '@angular/core';

interface ToastMsg {
  id: number;
  text: string;
  ok: boolean;
}

/** Small, quiet notice in the bottom-left corner (e.g. "Copiado"). */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly current = signal<ToastMsg | null>(null);
  private seq = 0;
  private timer?: ReturnType<typeof setTimeout>;

  show(text: string, ok = true, ms = 1800) {
    clearTimeout(this.timer);
    const id = ++this.seq;
    this.current.set({ id, text, ok });
    this.timer = setTimeout(() => {
      if (this.current()?.id === id) this.current.set(null);
    }, ms);
  }

  /** Copies `text` and confirms with a toast. Returns whether it worked. */
  async copy(text: string, label = 'Copiado para a área de transferência'): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      this.show(label);
      return true;
    } catch {
      this.show('Não foi possível copiar', false);
      return false;
    }
  }
}

@Component({
  selector: 'app-toast',
  template: `
    <div class="toast-region" role="status" aria-live="polite">
      @if (toast.current(); as t) {
        @for (x of [t.id]; track x) {
          <div class="toast">
            <span class="icon" [class.bad]="!t.ok" aria-hidden="true">{{ t.ok ? '✓' : '!' }}</span>
            {{ t.text }}
          </div>
        }
      }
    </div>
  `,
  styles: `
    .toast-region { position: fixed; left: 24px; bottom: 24px; z-index: 95; pointer-events: none; }
    .toast {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-radius: var(--radius);
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border); box-shadow: var(--shadow-lg);
      font-size: 0.85rem; animation: toast-in 0.16s ease-out;
    }
    .icon { color: var(--ok); font-weight: 700; }
    .icon.bad { color: var(--danger); }
    @keyframes toast-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
    @media (max-width: 480px) { .toast-region { left: 16px; bottom: 16px; } }
  `,
})
export class Toast {
  toast = inject(ToastService);
}

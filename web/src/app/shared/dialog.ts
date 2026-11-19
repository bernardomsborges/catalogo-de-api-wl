import { AfterViewInit, Directive, ElementRef, inject, input, OnDestroy, output } from '@angular/core';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Windows open on top of the page, most recent last: only the top one answers to Esc. */
const stack: AppDialog[] = [];

/**
 * Keyboard behaviour of a window (PRO-200), on the element with role="dialog":
 * - on open, focus goes inside (to the element with `autofocus`, else the first field or button);
 * - Tab and Shift+Tab stay inside while it's open (`trap`, on by default; off for side panels
 *   that don't block the page);
 * - Esc emits `dismiss`;
 * - on close, focus goes back to where it was (usually the button that opened it).
 */
@Directive({
  selector: '[appDialog]',
  host: { '(keydown)': 'onKeydown($event)' },
})
export class AppDialog implements AfterViewInit, OnDestroy {
  /** Keep Tab inside the window. */
  trap = input(true);
  dismiss = output<void>();

  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private previous: Element | null = null;
  private onDocKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && stack[stack.length - 1] === this && !e.defaultPrevented) {
      e.preventDefault();
      this.dismiss.emit();
    }
  };

  ngAfterViewInit() {
    this.previous = document.activeElement;
    stack.push(this);
    document.addEventListener('keydown', this.onDocKey);
    const el = this.host.nativeElement;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    // After the content (which may still be rendering) is in place.
    setTimeout(() => {
      if (el.contains(document.activeElement)) return;
      const target = el.querySelector<HTMLElement>('[autofocus]') ?? this.focusables()[0] ?? el;
      target.focus();
    });
  }

  ngOnDestroy() {
    stack.splice(stack.indexOf(this), 1);
    document.removeEventListener('keydown', this.onDocKey);
    const prev = this.previous as HTMLElement | null;
    // Only when focus was inside (or lost): a click elsewhere already chose where it goes.
    const active = document.activeElement;
    if (prev?.isConnected && (!active || active === document.body || this.host.nativeElement.contains(active))) prev.focus();
  }

  onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !this.trap()) return;
    const items = this.focusables();
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === this.host.nativeElement)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private focusables(): HTMLElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
  }
}

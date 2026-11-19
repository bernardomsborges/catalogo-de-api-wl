import { afterEveryRender, Directive, ElementRef, inject } from '@angular/core';

/**
 * Keyboard of a group with role="tablist" or role="radiogroup" (PRO-200), as screen readers expect:
 * - the group is one Tab stop: only the chosen option (aria-selected / aria-checked) is in the Tab order;
 * - arrows move to the previous / next option and choose it; Home and End go to the first / last.
 * The options are the buttons with role="tab" or role="radio" inside the group.
 */
@Directive({
  selector: '[appArrowKeys]',
  host: { '(keydown)': 'onKeydown($event)' },
})
export class ArrowKeys {
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterEveryRender(() => this.updateTabStops());
  }

  private options(): HTMLButtonElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLButtonElement>('[role="tab"], [role="radio"]')].filter((b) => !b.disabled);
  }

  private isChosen(b: HTMLElement) {
    return b.getAttribute('aria-selected') === 'true' || b.getAttribute('aria-checked') === 'true';
  }

  private updateTabStops() {
    const options = this.options();
    const chosen = options.find((b) => this.isChosen(b)) ?? options[0];
    for (const b of options) b.tabIndex = b === chosen ? 0 : -1;
  }

  onKeydown(e: KeyboardEvent) {
    const options = this.options();
    const i = options.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: options.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = options[(next + options.length) % options.length];
    target.focus();
    target.click();
  }
}

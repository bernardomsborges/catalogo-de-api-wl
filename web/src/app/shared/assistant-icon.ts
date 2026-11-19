import { Component, input } from '@angular/core';

/**
 * Icon of the catalog assistant: a chat bubble with an AI sparkle. Drawn with currentColor, so it
 * follows the color of where it's placed (white on the gradient button, brand on the avatar).
 */
@Component({
  selector: 'app-assistant-icon',
  host: { '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">
      @if (close()) {
        <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      } @else {
        <!-- Bubble -->
        <path
          d="M5.2 4.8h8.6a3.2 3.2 0 0 1 3.2 3.2v5.9a3.2 3.2 0 0 1-3.2 3.2H9.6l-3.7 3.1a.5.5 0 0 1-.8-.4v-2.7a3.2 3.2 0 0 1-3.1-3.2V8a3.2 3.2 0 0 1 3.2-3.2z"
          fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
        <!-- Main sparkle -->
        <path d="M9.5 7.4c.38 1.86 1.36 2.84 3.2 3.22-1.84.38-2.82 1.36-3.2 3.22-.38-1.86-1.36-2.84-3.2-3.22 1.84-.38 2.82-1.36 3.2-3.22z" fill="currentColor" />
        <!-- Small sparkles -->
        <path d="M19.6 2.1c.22 1.1.8 1.68 1.9 1.9-1.1.22-1.68.8-1.9 1.9-.22-1.1-.8-1.68-1.9-1.9 1.1-.22 1.68-.8 1.9-1.9z" fill="currentColor" />
        <circle cx="21.2" cy="8.6" r="0.95" fill="currentColor" />
      }
    </svg>
  `,
  styles: `
    :host { display: inline-block; flex: none; line-height: 0; }
    svg { display: block; }
  `,
})
export class AssistantIcon {
  size = input(24);
  /** Shows an "×" with the same stroke, for the open state of the button. */
  close = input(false);
}

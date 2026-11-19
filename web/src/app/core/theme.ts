import { computed, Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';
export type ThemeMode = Theme | 'system';
const STORAGE_KEY = 'catalogo-theme';

/**
 * Light/dark theme. "system" follows the OS; "light"/"dark" are saved and applied
 * as data-theme on <html>. index.html applies the saved value before Angular boots
 * to avoid a flash of the wrong theme.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private media = window.matchMedia('(prefers-color-scheme: dark)');
  private systemDark = signal(this.media.matches);

  readonly mode = signal<ThemeMode>(this.saved() ?? 'system');
  readonly theme = computed<Theme>(() => {
    const m = this.mode();
    return m === 'system' ? (this.systemDark() ? 'dark' : 'light') : m;
  });

  constructor() {
    this.media.addEventListener('change', (e) => this.systemDark.set(e.matches));
  }

  setMode(mode: ThemeMode) {
    const root = document.documentElement;
    root.classList.add('theme-anim');
    if (mode === 'system') delete root.dataset['theme'];
    else root.dataset['theme'] = mode;
    this.mode.set(mode);
    try {
      if (mode === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* storage unavailable: choice lasts for this visit only */
    }
    setTimeout(() => root.classList.remove('theme-anim'), 300);
  }

  private saved(): Theme | null {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch {
      return null;
    }
  }
}

import { DestroyRef, inject, Injectable, signal } from '@angular/core';

export interface ConsoleSessionInfo {
  /** Scheme key that received the token. */
  schemeKey: string;
  /** Epoch ms when the token expires (missing = the API didn't say). */
  expiresAt?: number;
}

interface ApiState {
  /** Credential values typed in the console, by scheme key (Basic uses key:user / key:pass). */
  creds: Record<string, string>;
  session: ConsoleSessionInfo | null;
  /** The last session ended because its token expired. */
  expired?: boolean;
}

/**
 * Console state shared by every "Testar este endpoint" of the same API: typed credentials and the
 * session token. Lives only in memory: reloading or closing the tab clears it, and nothing is
 * written to localStorage or sent to the catalog server (besides the test calls themselves).
 */
@Injectable({ providedIn: 'root' })
export class ConsoleSession {
  private state = signal<Record<string, ApiState>>({});
  /** Current time, refreshed every 15 s so expiry warnings update. */
  readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.tick(), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private get(apiId: string): ApiState {
    return this.state()[apiId] ?? { creds: {}, session: null };
  }

  private patch(apiId: string, fn: (s: ApiState) => ApiState) {
    this.state.update((all) => ({ ...all, [apiId]: fn(this.get(apiId)) }));
  }

  cred(apiId: string, key: string): string {
    return this.get(apiId).creds[key] ?? '';
  }

  setCred(apiId: string, key: string, value: string) {
    this.patch(apiId, (s) => ({ ...s, creds: { ...s.creds, [key]: value } }));
  }

  session(apiId: string): ConsoleSessionInfo | null {
    return this.get(apiId).session;
  }

  /** True when the last session ended because the token expired. */
  expired(apiId: string): boolean {
    return !!this.get(apiId).expired;
  }

  /** Stores a token issued by the API and puts it in the bearer field. */
  start(apiId: string, schemeKey: string, token: string, expiresInSec?: number) {
    const expiresAt = expiresInSec && expiresInSec > 0 ? Date.now() + expiresInSec * 1000 : undefined;
    this.patch(apiId, (s) => ({ creds: { ...s.creds, [schemeKey]: token }, session: { schemeKey, expiresAt } }));
    this.now.set(Date.now());
  }

  /** Forgets the session token. */
  end(apiId: string, expired = false) {
    this.patch(apiId, (s) => {
      if (!s.session) return { ...s, expired: false };
      const creds = { ...s.creds };
      delete creds[s.session.schemeKey];
      return { creds, session: null, expired };
    });
  }

  private tick() {
    const now = Date.now();
    this.now.set(now);
    for (const [apiId, s] of Object.entries(this.state())) {
      if (s.session?.expiresAt && s.session.expiresAt <= now) this.end(apiId, true);
    }
  }
}

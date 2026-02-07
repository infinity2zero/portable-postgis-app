import { Injectable } from '@angular/core';
import { getElectronApi } from './electron-api';

export type ThemeId = 'light' | 'dark' | 'auto';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private mediaQuery: MediaQueryList | null =
    typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  private mediaListener: (() => void) | null = null;

  constructor() {
    if (typeof document !== 'undefined' && !document.documentElement.hasAttribute('data-theme')) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  async init(): Promise<void> {
    const api = getElectronApi();
    if (!api) return;
    const settings = await api.getSettings();
    const theme = (settings?.theme as ThemeId) || 'light';
    this.apply(theme);
    if (theme === 'auto') this.observeSystem();
  }

  get effectiveTheme(): 'light' | 'dark' {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    if (this.mediaQuery && this.mediaQuery.matches) return 'dark';
    return 'light';
  }

  apply(theme: ThemeId): void {
    if (theme === 'auto') {
      const dark = this.mediaQuery ? this.mediaQuery.matches : false;
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      this.observeSystem();
    } else {
      this.stopObserving();
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  private observeSystem(): void {
    this.stopObserving();
    const mq = this.mediaQuery;
    if (!mq) return;
    this.mediaListener = () => {
      document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', this.mediaListener);
  }

  private stopObserving(): void {
    if (this.mediaListener && this.mediaQuery) {
      this.mediaQuery.removeEventListener('change', this.mediaListener);
      this.mediaListener = null;
    }
  }

  async setTheme(theme: ThemeId): Promise<void> {
    const api = getElectronApi();
    if (api) await api.saveSettings({ theme });
    this.apply(theme);
  }

  async getSavedTheme(): Promise<ThemeId> {
    const api = getElectronApi();
    if (!api) return 'light';
    const s = await api.getSettings();
    return (s?.theme as ThemeId) || 'light';
  }
}

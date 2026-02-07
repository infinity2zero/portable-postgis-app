import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { getElectronApi } from '../../core/electron-api';

/**
 * Handles first app load: redirects to onboarding if first run, otherwise to dashboard.
 * Keeps the initial URL as '' so we don't flash dashboard before deciding.
 */
@Component({
  selector: 'app-initial-redirect',
  standalone: true,
  template: `<div class="initial-redirect" aria-live="polite">Loading…</div>`,
  styles: [
    `
      .initial-redirect {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 1;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }
    `,
  ],
})
export class InitialRedirectComponent implements OnInit {
  private router = inject(Router);

  ngOnInit(): void {
    const api = getElectronApi();
    if (!api?.getSettings) {
      this.router.navigate(['/dashboard'], { replaceUrl: true });
      return;
    }
    api.getSettings().then((s) => {
      const firstRun = (s as { firstRun?: boolean })?.firstRun !== false;
      this.router.navigate([firstRun ? '/onboarding' : '/dashboard'], { replaceUrl: true });
    }).catch(() => {
      this.router.navigate(['/dashboard'], { replaceUrl: true });
    });
  }
}

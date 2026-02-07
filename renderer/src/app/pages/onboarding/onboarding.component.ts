import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { getElectronApi } from '../../core/electron-api';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss',
})
export class OnboardingComponent {
  private router = inject(Router);

  step = 0;
  readonly totalSteps = 4;
  readonly steps = [0, 1, 2, 3];

  next(): void {
    if (this.step < this.totalSteps - 1) {
      this.step++;
    } else {
      this.markOnboardingComplete();
      this.router.navigate(['/dashboard']);
    }
  }

  prev(): void {
    if (this.step > 0) this.step--;
  }

  skip(): void {
    this.markOnboardingComplete();
    this.router.navigate(['/dashboard']);
  }

  private markOnboardingComplete(): void {
    getElectronApi()?.saveSettings?.({ firstRun: false });
  }
}

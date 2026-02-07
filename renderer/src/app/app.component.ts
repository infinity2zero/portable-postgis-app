import { Component, OnInit, inject } from '@angular/core';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { TitleBarComponent } from './layout/title-bar/title-bar.component';
import { ActivityBarComponent } from './layout/activity-bar/activity-bar.component';
import { StatusBarComponent } from './layout/status-bar/status-bar.component';
import { ThemeService } from './core/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, TitleBarComponent, ActivityBarComponent, StatusBarComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  private theme = inject(ThemeService);
  private router = inject(Router);

  /** When true, show activity bar and status bar. When false (onboarding), full-screen content only. */
  showMainLayout = true;

  ngOnInit(): void {
    this.theme.init();
    this.updateLayoutForRoute(this.router.url);
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.updateLayoutForRoute(e.urlAfterRedirects));
  }

  private updateLayoutForRoute(url: string): void {
    this.showMainLayout = !url.includes('/onboarding');
  }
}

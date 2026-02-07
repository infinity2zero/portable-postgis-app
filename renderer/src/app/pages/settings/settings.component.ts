import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ThemeService, ThemeId } from '../../core/theme.service';
import { getElectronApi } from '../../core/electron-api';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  activeTheme: ThemeId = 'light';

  /** Database connection (used by built-in browser and backup/restore) */
  dbPort = 5432;
  dbUser = 'postgres';
  dbPassword = 'postgres';
  showPassword = false;
  connectionSaved = false;
  connectionError = '';

  constructor(
    private theme: ThemeService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.theme.getSavedTheme().then((t) => (this.activeTheme = t));
    this.loadConnectionSettings();
  }

  loadConnectionSettings(): void {
    const api = getElectronApi();
    if (!api?.getSettings) return;
    api.getSettings().then((s) => {
      if (s?.ports?.postgres != null) this.dbPort = s.ports.postgres;
      this.dbUser = 'postgres'; // Username fixed for now
      if (s?.dbPassword != null) this.dbPassword = s.dbPassword;
    });
  }

  saveConnectionSettings(): void {
    const api = getElectronApi();
    if (!api?.saveSettings) return;
    this.connectionError = '';
    this.connectionSaved = false;
    api.getSettings().then((s) => {
      api.saveSettings({
        ports: { ...s?.ports, postgres: this.dbPort },
        dbUser: 'postgres', // Username fixed for now
        dbPassword: this.dbPassword ?? 'postgres',
      }).then(() => {
        this.connectionSaved = true;
        setTimeout(() => (this.connectionSaved = false), 2000);
      }).catch((err) => {
        this.connectionError = err?.message || 'Failed to save';
      });
    });
  }

  setTheme(t: ThemeId): void {
    this.activeTheme = t;
    this.theme.setTheme(t);
  }

  showOnboardingAgain(): void {
    this.router.navigate(['/onboarding']);
  }

  wipeData(): void {
    if (typeof window !== 'undefined' && !window.confirm?.('Wipe all database and app data? This cannot be undone.')) return;
    const api = getElectronApi();
    if (!api?.wipeData) return;
    api.wipeData();
  }
}

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { getElectronApi } from '../../core/electron-api';
import { DashboardService } from '../../core/dashboard.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit, OnDestroy {
  pgStatus: 'stopped' | 'running' = 'stopped';
  pgPort = 5432;
  pgUser = 'postgres';
  pgPassword = 'postgres';
  showPassword = false;
  error = '';

  get logs(): string[] {
    return this.dashboardService.logs;
  }

  constructor(private dashboardService: DashboardService) {}

  ngOnInit() {
    const api = getElectronApi();
    if (api) {
      api.signalUiReady();
      api.getSettings().then((s) => {
        if (s?.ports?.postgres != null) this.pgPort = s.ports.postgres;
        this.pgUser = 'postgres'; // Username fixed for now
        if (s?.dbPassword != null) this.pgPassword = s.dbPassword;
      });
      this.refreshPostgresStatus();
      api.onLog((msg) => this.dashboardService.addLog(msg));
      api.onServiceExit(({ id }) => {
        if (id === 'postgres') this.pgStatus = 'stopped';
      });
    }
  }

  ngOnDestroy() {}

  refreshPostgresStatus(): void {
    const api = getElectronApi();
    if (api) {
      api.getPostgresStatus().then((r) => {
        this.pgStatus = r?.running ? 'running' : 'stopped';
      });
    }
  }

  saveConnectionSettings(): void {
    const api = getElectronApi();
    if (!api) return;
    api.getSettings().then((s) => {
      api.saveSettings({
        ports: { ...s?.ports, postgres: this.pgPort },
        dbUser: 'postgres', // Username fixed for now
        dbPassword: this.pgPassword ?? 'postgres',
      });
    });
  }

  clearLogs(): void {
    this.dashboardService.clearLogs();
  }

  async togglePostgres() {
    const api = getElectronApi();
    if (!api) return;
    this.error = '';
    if (this.pgStatus === 'running') {
      await api.stopPostgres();
      this.pgStatus = 'stopped';
    } else {
      const port = this.pgPort || 5432;
      const result = await api.startPostgres(port);
      if (result.success) this.pgStatus = 'running';
      else this.error = result.error || 'Failed to start';
    }
  }
}

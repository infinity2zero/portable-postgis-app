import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class DashboardService {
  /** In-memory logs so they persist when navigating away from Dashboard */
  logs: string[] = [];
  private maxLogs = 500;

  addLog(msg: string): void {
    this.logs = [...this.logs.slice(-(this.maxLogs - 1)), msg];
  }

  clearLogs(): void {
    this.logs = [];
  }
}

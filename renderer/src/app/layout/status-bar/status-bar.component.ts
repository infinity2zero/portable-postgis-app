import { Component, OnInit } from '@angular/core';
import { getElectronApi } from '../../core/electron-api';

@Component({
  selector: 'app-status-bar',
  standalone: true,
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss',
})
export class StatusBarComponent implements OnInit {
  pgPort = 5432;

  ngOnInit(): void {
    const api = getElectronApi();
    if (api) {
      api.getSettings().then((s) => {
        if (s?.ports?.postgres != null) this.pgPort = s.ports.postgres;
      });
    }
  }

  openGitHub(event: Event): void {
    event.preventDefault();
    const api = getElectronApi();
    if (api?.openExternal) {
      api.openExternal('https://github.com/infinity2zero');
    } else {
      window.open('https://github.com/infinity2zero', '_blank', 'noopener,noreferrer');
    }
  }
}

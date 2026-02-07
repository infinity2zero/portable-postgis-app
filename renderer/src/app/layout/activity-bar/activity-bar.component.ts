import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-activity-bar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './activity-bar.component.html',
  styleUrl: './activity-bar.component.scss',
})
export class ActivityBarComponent {}

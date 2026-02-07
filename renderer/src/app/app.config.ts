import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideMonacoEditor } from 'ngx-monaco-editor-v2';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideMonacoEditor({
      baseUrl: 'assets',
      defaultOptions: { scrollBeyondLastLine: false, minimap: { enabled: false }, fontSize: 13 },
      requireConfig: { preferScriptTags: true },
    }),
  ],
};

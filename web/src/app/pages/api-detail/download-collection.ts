import { Component, computed, input } from '@angular/core';
import { Api } from '../../core/models';
import { PostmanFile, postmanFiles } from '../../core/postman';

/** "Baixar coleção" (PRO-161): Postman/Insomnia collection and one environment file per environment. */
@Component({
  selector: 'app-download-collection',
  template: `
    <div class="card list">
      <p class="hint">Importe a coleção e o ambiente, depois preencha as variáveis de credencial ({{ credentialNames() }}).</p>
      @for (f of files(); track f.fileName) {
        <button type="button" class="item" (click)="download(f)">
          <span class="label">{{ f.label }}</span>
          <span class="file">{{ f.fileName }}</span>
        </button>
      }
      @if (files().length > 2) {
        <button type="button" class="item all" (click)="downloadAll()">Baixar todos os arquivos</button>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .list { padding: 6px; display: flex; flex-direction: column; gap: 2px; }
    .hint { margin: 8px 12px 8px; font-size: 0.85rem; color: var(--text-2); }
    .item { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; background: none; border: 0; border-radius: 8px; padding: 10px 12px; font: inherit; text-align: left; color: var(--text); cursor: pointer; }
    .item:hover, .item:focus-visible { background: var(--surface-hover); }
    .item:not(.all) { position: relative; padding-right: 96px; }
    .item:not(.all)::after { content: 'Baixar ↓'; position: absolute; right: 14px; top: 50%; transform: translateY(-50%); font-size: 0.82rem; font-weight: 600; color: var(--link); }
    .label { font-weight: 600; font-size: 0.9rem; }
    .file { font-family: var(--mono); font-size: 0.72rem; color: var(--text-3); word-break: break-all; }
    .all { border-top: 1px solid var(--border); border-radius: 0 0 8px 8px; margin-top: 4px; font-size: 0.85rem; font-weight: 600; color: var(--link); }
  `,
})
export class DownloadCollection {
  api = input.required<Api>();

  files = computed(() => postmanFiles(this.api()));
  credentialNames = computed(() => {
    const coll = this.files()[0].json as { variable: { key: string }[] };
    const names = coll.variable.map((v) => v.key).filter((k) => k !== 'baseUrl');
    return names.length ? names.join(', ') : 'nenhuma: API pública';
  });

  download(f: PostmanFile) {
    const blob = new Blob([JSON.stringify(f.json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = f.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  downloadAll() {
    this.files().forEach((f, i) => setTimeout(() => this.download(f), i * 250));
  }
}

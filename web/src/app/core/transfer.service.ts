import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** Exported file: APIs and ReceAPItos without ids, matched by slug on import. */
export interface TransferBundle {
  format: 'catalogo-de-apis';
  version: number;
  exportedAt: string;
  source: string;
  apis: unknown[];
  recipes: unknown[];
}

export type PlanAction = 'create' | 'update' | 'same' | 'invalid';

export interface PlanRow {
  slug: string;
  name: string;
  action: PlanAction;
  errors: string[];
  warnings: string[];
  missingGroups?: string[];
  /** ReceAPItos: APIs of the file that don't exist here yet (must be imported together). */
  needsApis?: string[];
}

export interface TransferPlan {
  exportedAt: string | null;
  source: string;
  apis: PlanRow[];
  recipes: PlanRow[];
  missingGroups: string[];
  canCreateGroups: boolean;
}

export interface TransferResult {
  kind: 'api' | 'recipe' | 'group';
  slug: string;
  name: string;
  action: 'created' | 'updated' | 'unchanged' | 'error';
  message?: string;
}

/** Export and import of APIs between catalogs (e.g. homologação → produção). */
@Injectable({ providedIn: 'root' })
export class TransferService {
  private http = inject(HttpClient);

  export(apiIds: string[] | null, recipes: boolean) {
    return firstValueFrom(this.http.post<TransferBundle>('/api/transfer/export', { ...(apiIds ? { apiIds } : {}), recipes }));
  }

  preview(bundle: unknown) {
    return firstValueFrom(this.http.post<TransferPlan>('/api/transfer/preview', { bundle }));
  }

  import(bundle: unknown, choice: { apis: string[]; recipes: string[]; createGroups: boolean }) {
    return firstValueFrom(this.http.post<{ results: TransferResult[] }>('/api/transfer/import', { bundle, ...choice }));
  }
}

/** Saves `text` as a file in the browser's downloads. */
export function downloadText(text: string, fileName: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Consumer, ConsumerSystem, SystemInput, SystemSuggestion } from './systems';

/** Consumer systems (PRO-166): managed by the team; the API page shows who uses each API. */
@Injectable({ providedIn: 'root' })
export class SystemsService {
  private http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<ConsumerSystem[]>('/api/admin/systems'));
  }
  suggestions() {
    return firstValueFrom(this.http.get<SystemSuggestion[]>('/api/admin/systems/suggestions'));
  }
  save(id: string | null, input: SystemInput) {
    return firstValueFrom(id ? this.http.put<ConsumerSystem>(`/api/admin/systems/${id}`, input) : this.http.post<ConsumerSystem>('/api/admin/systems', input));
  }
  remove(id: string) {
    return firstValueFrom(this.http.delete(`/api/admin/systems/${id}`));
  }
  consumersOf(api: string) {
    return firstValueFrom(this.http.get<Consumer[]>(`/api/apis/${encodeURIComponent(api)}/consumers`));
  }
}

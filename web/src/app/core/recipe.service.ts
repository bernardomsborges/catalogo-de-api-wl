import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Recipe, RecipeInput, RecipeStep } from './recipes';

/** What "Montar com IA" answers: a draft (or none, when it only has questions) and what to check. */
export interface RecipeDraft {
  recipe: (Omit<RecipeInput, 'slug' | 'steps'> & { steps: (RecipeStep & { bodyFromModel?: boolean })[] }) | null;
  message: string;
  questions: string[];
  warnings: string[];
  routes: number;
}

@Injectable({ providedIn: 'root' })
export class RecipeService {
  private http = inject(HttpClient);

  list(filter: { api?: string; q?: string } = {}) {
    const params: Record<string, string> = {};
    if (filter.api) params['api'] = filter.api;
    if (filter.q) params['q'] = filter.q;
    return firstValueFrom(this.http.get<Recipe[]>('/api/recipes', { params }));
  }
  get(idOrSlug: string) {
    return firstValueFrom(this.http.get<Recipe>(`/api/recipes/${encodeURIComponent(idOrSlug)}`));
  }
  create(input: RecipeInput) {
    return firstValueFrom(this.http.post<Recipe>('/api/recipes', input));
  }
  update(id: string, input: RecipeInput) {
    return firstValueFrom(this.http.put<Recipe>(`/api/recipes/${id}`, input));
  }
  /** Asks the AI to draft or adjust a ReceAPIto from an idea. Nothing is saved. */
  draft(idea: string, draft: RecipeInput | null, history: string[]) {
    return firstValueFrom(this.http.post<RecipeDraft>('/api/ai/recipe', { idea, draft, history }));
  }
  aiEnabled() {
    return firstValueFrom(this.http.get<{ model: string | null }>('/api/ai/status')).then((s) => !!s.model, () => false);
  }
  remove(id: string) {
    return firstValueFrom(this.http.delete(`/api/recipes/${id}`));
  }
}

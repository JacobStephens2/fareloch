import type { Recipe } from '../types';
import { textSpan } from './food-search-text';
import { createMountedLifetime } from '../mounted-lifetime';

// Each connected, exclusively owned host gets one read and one permanent lifetime.
export function mountRecipeList(host: HTMLElement, { kind, read, onSelect }: {
  kind: 'manage' | 'meal';
  read: () => Promise<{ recipes: Recipe[] }>;
  onSelect: (recipe: Recipe) => void;
}): () => void {
  const { isLive, signal, dispose } = createMountedLifetime(host);

  async function load() {
    if (!isLive()) return;
    host.innerHTML = '<div class="loading-spinner">Loading...</div>';
    try {
      const { recipes } = await read();
      if (!isLive()) return;
      if (!recipes.length) {
        host.innerHTML = kind === 'manage'
          ? '<p class="text-muted">No recipes yet. Create one to save your favorite meals!</p>'
          : '<p class="text-muted">No recipes yet. <a href="#/recipes">Create one</a></p>';
        return;
      }
      host.replaceChildren();
      for (const recipe of recipes) {
        const row = document.createElement('div');
        row.className = 'food-item';
        const info = document.createElement('div');
        info.className = 'food-item-info';
        const servings = `${recipe.total_servings} ${recipe.serving_unit || 'serving'}${recipe.total_servings !== 1 ? 's' : ''}`;
        const detail = recipe.manual_calories != null
          ? 'Manual macros'
          : `${recipe.ingredientCount} ingredient${recipe.ingredientCount !== 1 ? 's' : ''}`;
        info.append(textSpan('food-item-name', recipe.name), textSpan('food-serving', `${detail} · ${servings}`));
        const macros = document.createElement('div');
        macros.className = 'food-item-macros';
        macros.append(
          textSpan('macro-chip chip-calories', String(recipe.perServing.calories)),
          textSpan('macro-chip chip-carbs', `${recipe.perServing.carbsG}c`),
          textSpan('macro-chip chip-protein', `${recipe.perServing.proteinG}p`),
          textSpan('macro-chip chip-fat', `${recipe.perServing.fatG}f`),
        );
        row.append(info, macros);
        row.addEventListener('click', () => {
          if (isLive() && host.contains(row)) onSelect(recipe);
        }, { signal });
        host.append(row);
      }
    } catch {
      if (isLive()) host.innerHTML = '<p class="form-error">Failed to load recipes</p>';
    }
  }

  void load();
  return dispose;
}

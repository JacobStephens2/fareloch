import { createMountedLifetime } from '../mounted-lifetime';
import type { Food } from '../types';
import { macrosOf, scaleMacros } from '../../server/src/nutrition';
import { textSpan } from './food-search-text';

type IngredientListEntry = {
  food: Pick<Food, 'name' | 'serving_size' | 'serving_unit' | 'calories' | 'carbs_g' | 'protein_g' | 'fat_g'>;
  servings: number;
  unitLabel?: string;
};

// Rows own presentation and action eligibility; entries are only callback identities.
export function mountIngredientListSession<Entry extends IngredientListEntry>(container: HTMLElement, {
  entries, isParentLive, onEdit, onRemove,
}: {
  entries: readonly Entry[];
  isParentLive: () => boolean;
  onEdit: (entry: Entry) => void;
  onRemove: (entry: Entry) => void;
}): () => void {
  if (!container.isConnected || !isParentLive()) return () => {};
  const rows = [...entries].map((entry, index) => {
    const food = entry.food;
    const macros = scaleMacros(macrosOf(food), entry.servings);
    let unit = entry.unitLabel;
    if (!unit) {
      if (food.serving_size && food.serving_unit) {
        const totalAmount = Math.round(entry.servings * food.serving_size * 10) / 10;
        unit = `${totalAmount}${food.serving_unit}`;
      } else {
        unit = `${Math.round(entry.servings * 100) / 100} serving${entry.servings !== 1 ? 's' : ''}`;
      }
    }

    const element = document.createElement('div');
    element.className = 'ingredient-row';
    const info = document.createElement('div');
    info.className = 'ingredient-info ingredient-clickable';
    info.dataset.idx = String(index);
    info.append(textSpan('ingredient-name', food.name), textSpan('ingredient-unit', unit));
    element.appendChild(info);
    element.insertAdjacentHTML('beforeend', `
      <div class="ingredient-macros">
        <span class="macro-chip chip-calories">${Math.round(macros.calories)}</span>
        <span class="macro-chip chip-carbs">${Math.round(macros.carbsG)}c</span>
        <span class="macro-chip chip-protein">${Math.round(macros.proteinG)}p</span>
        <span class="macro-chip chip-fat">${Math.round(macros.fatG)}f</span>
      </div>
      <button type="button" class="btn-icon btn-remove-ing" data-idx="${index}">&times;</button>
    `);
    return { entry, element, info, remove: element.querySelector<HTMLButtonElement>('.btn-remove-ing')! };
  });
  container.replaceChildren(...rows.map(row => row.element));
  const lifetime = createMountedLifetime(container, { ownedNodes: [...container.querySelectorAll('*')] });
  const isLive = () => {
    if (!isParentLive()) lifetime.dispose();
    return lifetime.isLive();
  };
  const options = { signal: lifetime.signal };
  for (const { entry, info, remove } of rows) {
    let removeAccepted = false;
    info.addEventListener('click', () => {
      if (isLive()) onEdit(entry);
    }, options);
    remove.addEventListener('click', event => {
      event.stopPropagation();
      if (!isLive() || removeAccepted) return;
      removeAccepted = true;
      onRemove(entry);
    }, options);
  }
  return lifetime.dispose;
}

import { meals } from '../api';
import { createMountedLifetime } from '../mounted-lifetime';
import type { MealLog } from '../types';
import { macrosOf, roundMacros, scaleMacros } from '../../server/src/nutrition';

// The editor owns view effects; accepted writes notify the captured date session
// even after this editor has retired. Disposal itself never changes retained DOM.
export function mountMealEditSession(
  modal: HTMLElement,
  meal: MealLog,
  parentIsCurrent: () => boolean,
  onSaved: () => void,
): () => void {
  const title = modal.querySelector<HTMLElement>('#edit-meal-name')!;
  const close = modal.querySelector<HTMLButtonElement>('#edit-modal-close')!;
  const body = modal.querySelector<HTMLElement>('#edit-meal-body')!;
  const mealId = meal.id;
  const linked = meal.food_id || meal.recipe_id;
  const scale = meal.unit_scale || 1;
  const storedMacros = macrosOf(meal);
  // Preserve division before Unit scale multiplication, including tie rounding.
  const perUnit = meal.servings ? {
    calories: (meal.calories / meal.servings) * scale,
    carbsG: (meal.carbs_g / meal.servings) * scale,
    proteinG: (meal.protein_g / meal.servings) * scale,
    fatG: (meal.fat_g / meal.servings) * scale,
  } : storedMacros;
  const displayPerUnit = roundMacros(perUnit, 'display');
  const initialTotal = roundMacros(storedMacros, 'display');
  const mealTypeControl = `
    <div class="form-group">
      <label for="edit-meal-type">Meal</label>
      <select id="edit-meal-type">
        <option value="breakfast">Breakfast</option>
        <option value="lunch">Lunch</option>
        <option value="dinner">Dinner</option>
        <option value="snack">Snack</option>
      </select>
    </div>`;
  const actions = `
    <div class="form-row">
      <button type="button" id="edit-save-btn" class="btn btn-primary" style="flex:1">Save</button>
      <button type="button" id="edit-delete-btn" class="btn btn-danger" style="flex:0 0 auto">Delete</button>
    </div>`;

  title.textContent = meal.food_name || meal.recipe_name || meal.note || 'Quick entry';
  body.innerHTML = linked ? `
    ${meal.food_brand ? '<p class="food-brand"></p>' : ''}
    <div class="modal-macros">
      <div class="modal-macro"><strong>${displayPerUnit.calories}</strong> kcal</div>
      <div class="modal-macro"><strong>${displayPerUnit.carbsG}g</strong> carbs</div>
      <div class="modal-macro"><strong>${displayPerUnit.proteinG}g</strong> protein</div>
      <div class="modal-macro"><strong>${displayPerUnit.fatG}g</strong> fat</div>
    </div>
    <p class="text-muted" id="edit-per-label"></p>
    <div class="form-group">
      <label for="edit-servings" id="edit-qty-label"></label>
      <div class="servings-control">
        <button type="button" id="edit-serv-minus" class="btn-icon">-</button>
        <input type="number" id="edit-servings" value="${parseFloat((meal.servings / scale).toFixed(2))}" min="1" step="1" />
        <button type="button" id="edit-serv-plus" class="btn-icon">+</button>
      </div>
    </div>
    ${mealTypeControl}
    <div class="modal-total" id="edit-total">
      <span>${initialTotal.calories} kcal</span>
      <span>${initialTotal.carbsG}g C</span>
      <span>${initialTotal.proteinG}g P</span>
      <span>${initialTotal.fatG}g F</span>
    </div>
    ${actions}
  ` : `
    ${mealTypeControl}
    <div class="form-row">
      <div class="form-group">
        <label for="edit-carbs">Carbs (g)</label>
        <input type="number" id="edit-carbs" value="${meal.carbs_g}" min="0" step="0.1" />
      </div>
      <div class="form-group">
        <label for="edit-protein">Protein (g)</label>
        <input type="number" id="edit-protein" value="${meal.protein_g}" min="0" step="0.1" />
      </div>
      <div class="form-group">
        <label for="edit-fat">Fat (g)</label>
        <input type="number" id="edit-fat" value="${meal.fat_g}" min="0" step="0.1" />
      </div>
    </div>
    <div class="form-group">
      <label for="edit-cal">Calories</label>
      <input type="number" id="edit-cal" value="${meal.calories}" min="0" step="1" />
    </div>
    ${actions}
  `;

  // Capture controls once. No handler can discover a successor form by ID.
  const controls = new Map([...body.querySelectorAll<HTMLElement>('[id]')].map(node => [node.id, node]));
  const find = <T extends HTMLElement = HTMLElement>(id: string) => controls.get(id)! as T;
  const mealType = find<HTMLSelectElement>('edit-meal-type');
  mealType.value = meal.meal_type;
  const lifetime = createMountedLifetime(modal, {
    ownedNodes: [title, close, body, ...body.children, ...controls.values()],
  });
  const isLive = () => {
    if (!parentIsCurrent()) lifetime.dispose();
    return lifetime.isLive();
  };
  const eventOptions = { signal: lifetime.signal };
  const closeEditor = () => {
    if (!isLive()) return;
    lifetime.dispose();
    modal.classList.add('hidden');
    body.replaceChildren();
  };
  close.addEventListener('click', closeEditor, eventOptions);

  let readEdit: () => Parameters<typeof meals.update>[1];
  if (linked) {
    if (meal.food_brand) body.querySelector('.food-brand')!.textContent = meal.food_brand;
    const perUnitLabel = meal.unit_label
      || (meal.serving_size && meal.serving_unit ? `${meal.serving_size}${meal.serving_unit}` : 'serving');
    find('edit-per-label').textContent = `Per ${perUnitLabel}`;
    find('edit-qty-label').textContent = meal.unit_label || 'Servings';
    const quantity = find<HTMLInputElement>('edit-servings');
    const total = find('edit-total');
    const updateTotal = () => {
      if (!isLive()) return;
      const preview = roundMacros(scaleMacros(perUnit, parseFloat(quantity.value) || 1), 'display');
      total.innerHTML = `
        <span>${preview.calories} kcal</span>
        <span>${preview.carbsG}g C</span>
        <span>${preview.proteinG}g P</span>
        <span>${preview.fatG}g F</span>
      `;
    };
    quantity.addEventListener('input', updateTotal, eventOptions);
    find('edit-serv-minus').addEventListener('click', () => {
      if (!isLive()) return;
      quantity.value = String(Math.max(1, (parseFloat(quantity.value) || 1) - 1));
      updateTotal();
    }, eventOptions);
    find('edit-serv-plus').addEventListener('click', () => {
      if (!isLive()) return;
      quantity.value = String((parseFloat(quantity.value) || 1) + 1);
      updateTotal();
    }, eventOptions);
    readEdit = () => {
      const qty = parseFloat(quantity.value) || 1;
      return {
        servings: qty * scale,
        mealType: mealType.value,
        ...roundMacros(scaleMacros(perUnit, qty), 'stored'),
      };
    };
  } else {
    const calories = find<HTMLInputElement>('edit-cal');
    const carbs = find<HTMLInputElement>('edit-carbs');
    const protein = find<HTMLInputElement>('edit-protein');
    const fat = find<HTMLInputElement>('edit-fat');
    readEdit = () => ({
      mealType: mealType.value,
      calories: parseFloat(calories.value) || 0,
      carbsG: parseFloat(carbs.value) || 0,
      proteinG: parseFloat(protein.value) || 0,
      fatG: parseFloat(fat.value) || 0,
    });
  }

  const save = find<HTMLButtonElement>('edit-save-btn');
  save.addEventListener('click', async () => {
    if (!isLive() || save.disabled) return;
    const payload = readEdit();
    save.disabled = true;
    try {
      await meals.update(mealId, payload);
    } catch {
      if (!isLive()) return;
      save.disabled = false;
      save.textContent = 'Failed - Retry';
      return;
    }
    closeEditor();
    onSaved();
  }, eventOptions);

  find('edit-delete-btn').addEventListener('click', async () => {
    if (!isLive() || !confirm('Remove this entry?')) return;
    try {
      await meals.delete(mealId);
    } catch { return; }
    closeEditor();
    onSaved();
  }, eventOptions);

  if (isLive()) modal.classList.remove('hidden');
  return lifetime.dispose;
}

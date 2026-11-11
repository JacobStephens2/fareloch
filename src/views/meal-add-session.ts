import { meals } from '../api';
import { createMountedLifetime } from '../mounted-lifetime';
import type { Food, MealType, Recipe } from '../types';
import { roundMacros, scaleMacros } from '../../server/src/nutrition';
import { mountFoodQuantitySelection } from './food-quantity-selection';

type MealSelection = { kind: 'food'; food: Food } | { kind: 'recipe'; recipe: Recipe };

// Local controls retire together; an accepted write still notifies its Log Food owner.
export function mountMealAddSession(
  modal: HTMLElement,
  selection: MealSelection,
  date: string,
  mealType: MealType,
  isParentLive: () => boolean,
  onSaved: () => void,
): () => void {
  if (!modal.isConnected || !isParentLive()) return () => {};
  const title = modal.querySelector<HTMLElement>('#modal-food-name')!;
  const close = modal.querySelector<HTMLButtonElement>('#modal-close')!;
  const body = modal.querySelector<HTMLElement>('#modal-body')!;
  const identity = selection.kind === 'food' ? { foodId: selection.food.id } : { recipeId: selection.recipe.id };
  title.textContent = selection.kind === 'food' ? selection.food.name : selection.recipe.name;
  body.innerHTML = selection.kind === 'food' ? '<div id="food-quantity"></div>' : `
    <div class="modal-macros">
      <div class="modal-macro"><strong>${selection.recipe.perServing.calories}</strong> kcal</div>
      <div class="modal-macro"><strong>${selection.recipe.perServing.carbsG}g</strong> carbs</div>
      <div class="modal-macro"><strong>${selection.recipe.perServing.proteinG}g</strong> protein</div>
      <div class="modal-macro"><strong>${selection.recipe.perServing.fatG}g</strong> fat</div>
    </div>
    <p class="text-muted" id="recipe-per-label"></p>
    <div class="form-group">
      <label for="servings-input">Servings</label>
      <div class="servings-control">
        <button id="serv-minus" class="btn-icon">-</button>
        <input type="number" id="servings-input" value="1" min="1" step="1" />
        <button id="serv-plus" class="btn-icon">+</button>
      </div>
    </div>
    <div class="modal-total" id="modal-total">
      <span>${selection.recipe.perServing.calories} kcal</span>
      <span>${selection.recipe.perServing.carbsG}g C</span>
      <span>${selection.recipe.perServing.proteinG}g P</span>
      <span>${selection.recipe.perServing.fatG}g F</span>
    </div>
  `;
  const add = document.createElement('button');
  add.id = 'add-food-btn';
  add.className = 'btn btn-primary btn-block';
  add.textContent = `Add to ${mealType.charAt(0).toUpperCase() + mealType.slice(1)}`;
  body.append(add);

  const foodHost = body.querySelector<HTMLElement>('#food-quantity');
  const quantitySelection = selection.kind === 'food'
    ? mountFoodQuantitySelection(foodHost!, selection.food, { kind: 'meal', isParentLive: isLive })
    : undefined;
  const lifetime = createMountedLifetime(modal, {
    ownedNodes: [title, close, body, ...body.children, ...(foodHost?.children ?? []), ...body.querySelectorAll('[id]')],
    cleanup: () => quantitySelection?.dispose(),
  });
  function isLive(): boolean {
    if (!isParentLive()) lifetime.dispose();
    return lifetime.isLive();
  }
  const eventOptions = { signal: lifetime.signal };
  close.addEventListener('click', () => {
    if (!isLive()) return;
    lifetime.dispose();
    modal.classList.add('hidden');
  }, eventOptions);

  let readAmount: () => { servings: number; unitLabel?: string; unitScale?: number } | undefined;
  if (selection.kind === 'food') {
    readAmount = () => quantitySelection!.read();
  } else {
    const { perServing, serving_unit, total_servings } = selection.recipe;
    body.querySelector('#recipe-per-label')!.textContent = `Per ${serving_unit || 'serving'} (${total_servings} total)`;
    const quantity = body.querySelector<HTMLInputElement>('#servings-input')!;
    const total = body.querySelector<HTMLElement>('#modal-total')!;
    const minus = body.querySelector<HTMLButtonElement>('#serv-minus')!;
    const plus = body.querySelector<HTMLButtonElement>('#serv-plus')!;
    const servings = () => parseFloat(quantity.value) || 1;
    const updateTotal = () => {
      if (!isLive()) return;
      // Recipes multiply the received display-rounded Per-serving nutrition.
      const preview = roundMacros(scaleMacros(perServing, servings()), 'display');
      total.innerHTML = `
        <span>${preview.calories} kcal</span>
        <span>${preview.carbsG}g C</span>
        <span>${preview.proteinG}g P</span>
        <span>${preview.fatG}g F</span>
      `;
    };
    quantity.addEventListener('input', updateTotal, eventOptions);
    minus.addEventListener('click', () => {
      if (!isLive()) return;
      quantity.value = String(Math.max(1, servings() - 1));
      updateTotal();
    }, eventOptions);
    plus.addEventListener('click', () => {
      if (!isLive()) return;
      quantity.value = String(servings() + 1);
      updateTotal();
    }, eventOptions);
    readAmount = () => ({ servings: servings() });
  }

  let pending = false;
  add.addEventListener('click', async () => {
    if (!isLive() || pending) return;
    const amount = readAmount();
    if (!amount) return;
    const payload = { date, mealType, ...identity, servings: amount.servings, unitLabel: amount.unitLabel, unitScale: amount.unitScale };
    pending = true;
    add.disabled = true;
    add.textContent = 'Adding...';
    try {
      await meals.log(payload);
    } catch {
      if (!isLive()) return;
      pending = false;
      add.disabled = false;
      add.textContent = 'Failed - Retry';
      return;
    }
    onSaved();
  }, eventOptions);

  if (isLive()) modal.classList.remove('hidden');
  return lifetime.dispose;
}

import { createMountedLifetime } from '../mounted-lifetime';
import type { Food } from '../types';
import { mountFoodQuantitySelection } from './food-quantity-selection';

type IngredientFood = Pick<Food, 'name' | 'brand' | 'serving_size' | 'serving_unit' | 'calories' | 'carbs_g' | 'protein_g' | 'fat_g' | 'measures'>;
type IngredientSelection = { kind: 'add' } | {
  kind: 'edit';
  servings: number;
  quantity?: number;
};
type IngredientAction = { kind: 'remove' } | {
  kind: 'apply';
  servings: number;
  quantity: number;
  unitLabel?: string;
};

// One modal owns local controls; the parent owns the captured draft occurrence.
export function mountIngredientEditSession(
  modal: HTMLElement,
  food: IngredientFood,
  selection: IngredientSelection,
  isEligible: () => boolean,
  onAction: (action: IngredientAction) => void,
): () => void {
  if (!modal.isConnected || !isEligible()) return () => {};
  const title = modal.querySelector<HTMLElement>('#ing-modal-name')!;
  const close = modal.querySelector<HTMLButtonElement>('#ing-modal-close')!;
  const body = modal.querySelector<HTMLElement>('#ing-modal-body')!;
  title.textContent = food.name;
  body.innerHTML = `
    <div id="ingredient-quantity"></div>
    <div class="form-row">
      <button type="button" id="ing-add-btn" class="btn btn-primary" style="flex:1">${selection.kind === 'edit' ? 'Update' : 'Add Ingredient'}</button>
      ${selection.kind === 'edit' ? '<button type="button" id="ing-remove-btn" class="btn btn-danger" style="flex:0 0 auto">Remove</button>' : ''}
    </div>
  `;
  const quantityHost = body.querySelector<HTMLElement>('#ingredient-quantity')!;
  const quantity = mountFoodQuantitySelection(quantityHost, food, {
    kind: 'ingredient',
    stored: selection.kind === 'edit' ? selection : undefined,
    isParentLive: isLive,
  });
  const lifetime = createMountedLifetime(modal, {
    // Preview text children are replaceable; their containers and controls are fixed.
    ownedNodes: [title, close, body, ...body.children, ...quantityHost.children, ...body.querySelectorAll('[id]')],
    cleanup: quantity.dispose,
  });
  function isLive(): boolean {
    if (!isEligible()) lifetime.dispose();
    return lifetime.isLive();
  }
  function finish(action?: IngredientAction) {
    lifetime.dispose();
    modal.classList.add('hidden');
    if (action) onAction(action);
  }
  const options = { signal: lifetime.signal };
  close.addEventListener('click', () => {
    if (isLive()) finish();
  }, options);
  body.querySelector('#ing-add-btn')!.addEventListener('click', () => {
    if (!isLive()) return;
    const amount = quantity.read();
    if (amount) finish({ kind: 'apply', ...amount });
  }, options);
  body.querySelector('#ing-remove-btn')?.addEventListener('click', () => {
    if (isLive()) finish({ kind: 'remove' });
  }, options);
  if (isLive()) modal.classList.remove('hidden');
  return lifetime.dispose;
}

import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, recipes } from '../api';
import { route, startRouter } from '../router';
import { deferred, externalFood, food } from '../test/food-search-fixtures';
import { change, click, go, submit } from '../test/recipe-editor-fixtures';
import type { Recipe, RecipeIngredient } from '../types';
import { recipeEditView } from './recipes';

vi.mock('../api', () => ({
  foods: { search: vi.fn(), saveExternal: vi.fn() },
  recipes: { get: vi.fn(), create: vi.fn(), update: vi.fn(), copy: vi.fn(), delete: vi.fn() },
}));

function recipe(id = 1): Recipe {
  return {
    id, user_id: 1, name: `Recipe ${id}`, total_servings: 2, serving_unit: 'bowl',
    manual_calories: null, manual_carbs_g: null, manual_protein_g: null, manual_fat_g: null,
    ingredientCount: 1, perServing: { calories: 100, carbsG: 10, proteinG: 5, fatG: 4 },
  };
}

function loaded(id = 1) {
  const ingredient: RecipeIngredient = {
    ...food(`Ingredient ${id}`), id: 10, food_id: 1,
    servings: 2, qty: 1, unit_label: 'cup',
  };
  return { recipe: recipe(id), ingredients: [ingredient] };
}

const mutableParams = { id: '1' };

function input(id: string) {
  return document.querySelector<HTMLInputElement>(`#${id}`)!;
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/recipes/:id', recipeEditView);
  route('/captured', () => recipeEditView(mutableParams));
  route('/recipes', () => ({ html: '<p>Recipes destination</p>', init() {} }));
  route('/other', () => ({ html: '<p>Other view</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(recipes.get).mockReset().mockImplementation(async id => loaded(id));
  vi.mocked(recipes.create).mockReset().mockResolvedValue({ recipe: recipe(3) });
  vi.mocked(recipes.update).mockReset().mockResolvedValue({ success: true });
  vi.mocked(recipes.copy).mockReset().mockResolvedValue({ recipe: recipe(3) });
  vi.mocked(recipes.delete).mockReset().mockResolvedValue({ success: true });
  vi.mocked(foods.search).mockReset().mockResolvedValue({ foods: [], external: [] });
  vi.mocked(foods.saveExternal).mockReset().mockResolvedValue({ food: food('Saved') });
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(['2', 'new', '1'])('a late Recipe 1 load cannot hydrate a later %s editor', async next => {
  const old = deferred<ReturnType<typeof loaded>>();
  vi.mocked(recipes.get).mockReturnValueOnce(old.promise);
  go('/recipes/1');
  const oldRoot = document.querySelector('.page')!;
  go('/other');
  go(`/recipes/${next}`);
  await settle();
  input('recipe-name').value = 'Current draft';
  input('recipe-servings').value = '3';
  input('recipe-unit').value = 'plate';
  const before = document.querySelector('.page')!.outerHTML;
  const detached = oldRoot.outerHTML;
  const stale = loaded();
  stale.recipe.manual_calories = 999;
  stale.recipe.manual_carbs_g = 80;
  old.resolve(stale);
  await settle();
  expect(input('recipe-name').value).toBe('Current draft');
  expect(input('recipe-servings').value).toBe('3');
  expect(input('recipe-unit').value).toBe('plate');
  expect(document.querySelector('.page')!.outerHTML).toBe(before);
  expect(oldRoot.outerHTML).toBe(detached);
});

type Action = 'create' | 'update' | 'copy' | 'delete';
const actions: Action[] = ['create', 'update', 'copy', 'delete'];

function act(action: Action) {
  if (action === 'create' || action === 'update') submit();
  else click(action === 'copy' ? '#copy-recipe' : '#delete-recipe');
}

it.each(actions)('%s captures inputs and ignores stale successes and failures after departure or remount', async action => {
  for (const destination of ['/recipes/2', '/recipes/new', '/remount', '/other', '/missing']) {
    for (const outcome of ['success', 'failure']) {
      const pending = deferred<{ recipe: { id: number }; success: boolean }>();
      vi.mocked(recipes[action]).mockReturnValueOnce(pending.promise);
      const origin = action === 'create' ? '/recipes/new' : '/recipes/1';
      go(origin);
      await settle();
      change('recipe-name', 'Captured draft');
      change('recipe-servings', '3');
      change('recipe-unit', 'plate');
      const oldRoot = document.querySelector('.page')!;
      act(action);
      if (action === 'create' || action === 'update') {
        const payload = {
          name: 'Captured draft', totalServings: 3, servingUnit: 'plate',
          ingredients: action === 'create' ? [] : [{ foodId: 1, servings: 2, qty: 1, unitLabel: 'cup' }],
          manualCalories: null, manualCarbsG: null, manualProteinG: null, manualFatG: null,
        };
        expect(recipes[action]).toHaveBeenLastCalledWith(...(action === 'create' ? [payload] : [1, payload]));
      } else expect(recipes[action]).toHaveBeenLastCalledWith(1);
      change('recipe-name', 'Later draft');
      go(destination === '/remount' ? '/other' : destination);
      if (destination === '/remount') go(origin);
      await settle();
      const current = document.querySelector('#app')!.innerHTML;
      const detached = oldRoot.outerHTML;
      const hash = window.location.hash;
      if (outcome === 'success') pending.resolve({ recipe: { id: 99 }, success: true });
      else pending.reject(new Error('stale write'));
      await settle();
      expect(window.location.hash).toBe(hash);
      expect(document.querySelector('#app')!.innerHTML).toBe(current);
      expect(oldRoot.outerHTML).toBe(detached);
      expect(window.alert).not.toHaveBeenCalled();
    }
  }
});

it.each(actions)('current %s failure permits retry and its success navigates to the existing destination', async action => {
  vi.mocked(recipes[action]).mockRejectedValueOnce(new Error('try again'));
  go(action === 'create' ? '/recipes/new' : '/recipes/1');
  await settle();
  change('recipe-name', 'Retry draft');
  act(action);
  await settle();
  expect(window.location.hash).toBe(action === 'create' ? '#/recipes/new' : '#/recipes/1');
  if (action === 'create' || action === 'update') {
    expect(document.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(false);
    expect(document.querySelector('[type=submit]')!.textContent).toBe('Failed - Retry');
  } else if (action === 'copy') {
    expect(document.querySelector<HTMLButtonElement>('#copy-recipe')!.disabled).toBe(false);
    expect(document.querySelector('#copy-recipe')!.textContent).toBe('Duplicate Recipe');
  } else {
    expect(window.alert).toHaveBeenCalledWith('Failed to delete recipe');
    expect(input('recipe-name').value).toBe('Retry draft');
  }
  act(action);
  await settle();
  expect(window.location.hash).toBe(action === 'copy' ? '#/recipes/3' : '#/recipes');
});

async function selectExternal() {
  const selection = externalFood('External apple');
  vi.mocked(foods.search).mockResolvedValue({ foods: [], external: [selection] });
  change('ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  click('#ing-results .food-item');
  expect(foods.saveExternal).toHaveBeenLastCalledWith(selection);
}

it.each(['/recipes/2', '/recipes/new', '/remount', '/other', '/missing'])('external save cannot publish after departure to %s', async destination => {
  for (const outcome of ['success', 'failure']) {
    const pending = deferred<Awaited<ReturnType<typeof foods.saveExternal>>>();
    vi.mocked(foods.saveExternal).mockReturnValueOnce(pending.promise);
    go('/recipes/1');
    await settle();
    await selectExternal();
    const oldRoot = document.querySelector('.page')!;
    go(destination === '/remount' ? '/other' : destination);
    if (destination === '/remount') go('/recipes/1');
    await settle();
    const current = document.querySelector('#app')!.innerHTML;
    const detached = oldRoot.outerHTML;
    if (outcome === 'success') pending.resolve({ food: food('Old saved food') });
    else pending.reject(new Error('stale food'));
    await settle();
    expect(document.querySelector('#app')!.innerHTML).toBe(current);
    expect(oldRoot.outerHTML).toBe(detached);
    expect(window.alert).not.toHaveBeenCalled();
  }
});

it('a clicked external selection survives same-mount query/mode changes and can be added', async () => {
  const pending = deferred<Awaited<ReturnType<typeof foods.saveExternal>>>();
  vi.mocked(foods.saveExternal).mockReturnValueOnce(pending.promise);
  go('/recipes/new');
  await selectExternal();
  change('ing-search', 'pear');
  click('[data-mode="manual"]');
  pending.resolve({ food: food('Saved apple') });
  await settle();
  expect(document.querySelector('#ing-modal')!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#ing-modal-name')!.textContent).toBe('Saved apple');
  click('#ing-add-btn');
  expect(document.querySelector('#ingredients-list')!.textContent).toContain('Saved apple');
  expect(input('ing-search').value).toBe('');
  expect(document.querySelector('#ing-results')!.classList.contains('hidden')).toBe(true);
});

it('a current external save failure alerts and allows another selection', async () => {
  vi.mocked(foods.saveExternal).mockRejectedValueOnce(new Error('try again'));
  go('/recipes/new');
  await selectExternal();
  await settle();
  expect(window.alert).toHaveBeenCalledWith('Failed to save food');
  click('#ing-results .food-item');
  await settle();
  expect(document.querySelector('#ing-modal-name')!.textContent).toBe('Saved');
});

it.each(['/other', '/missing'])('retained static, ingredient, search and modal controls are inert after %s departure', async destination => {
  go('/recipes/1');
  await settle();
  vi.mocked(foods.search).mockResolvedValue({ foods: [food('Found')], external: [externalFood('External')] });
  change('ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  click('.ingredient-clickable');
  const oldRoot = document.querySelector<HTMLElement>('.page')!;
  const oldQty = input('ing-qty');
  const oldCalories = input('manual-cal');
  const controls = [...oldRoot.querySelectorAll('button, input, select, form, .ingredient-clickable, .food-item')];
  go(destination);
  go(destination); // A second departure consumes no additional editor cleanup.
  const current = document.querySelector('#app')!.innerHTML;
  const old = oldRoot.outerHTML;
  const operations = actions.map(action => vi.mocked(recipes[action]).mock.calls.length);
  const searches = vi.mocked(foods.search).mock.calls.length;
  const saves = vi.mocked(foods.saveExternal).mock.calls.length;
  const confirmations = vi.mocked(window.confirm).mock.calls.length;
  const hash = window.location.hash;
  // Reconnecting retained DOM must not revive a disposed editor.
  document.body.appendChild(oldRoot);
  for (const control of controls) {
    for (const type of ['click', 'input', 'change', 'submit']) {
      control.dispatchEvent(new Event(type, { cancelable: true }));
    }
  }
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(oldRoot.outerHTML).toBe(old);
  expect(oldQty.value).toBe('1');
  expect(oldCalories.value).toBe('');
  expect(actions.map(action => vi.mocked(recipes[action]).mock.calls.length)).toEqual(operations);
  expect(foods.search).toHaveBeenCalledTimes(searches);
  expect(foods.saveExternal).toHaveBeenCalledTimes(saves);
  expect(window.confirm).toHaveBeenCalledTimes(confirmations);
  expect(window.alert).not.toHaveBeenCalled();
  expect(window.location.hash).toBe(hash);
  oldRoot.remove();
});

it('hydrates zero-valued Manual macros and preserves calorie override, modes and Per-serving nutrition', async () => {
  const zero = loaded();
  zero.recipe.manual_calories = 0;
  zero.recipe.manual_carbs_g = 0;
  zero.recipe.manual_protein_g = 0;
  zero.recipe.manual_fat_g = 0;
  vi.mocked(recipes.get).mockResolvedValueOnce(zero);
  go('/recipes/1');
  await settle();
  expect(input('manual-cal').value).toBe('0');
  expect(input('manual-carbs').value).toBe('0');
  expect(input('manual-protein').value).toBe('0');
  expect(input('manual-fat').value).toBe('0');
  expect(document.querySelector('[data-mode].active')!.getAttribute('data-mode')).toBe('manual');
  expect([...document.querySelectorAll('#recipe-totals strong')].map(el => el.textContent)).toEqual(['0', '0g', '0g', '0g']);
  change('manual-carbs', '10');
  change('manual-protein', '5');
  change('manual-fat', '4');
  expect(input('manual-cal').value).toBe('96');
  change('recipe-servings', '3');
  expect([...document.querySelectorAll('#recipe-totals strong')].map(el => el.textContent)).toEqual(['32', '3.3g', '1.7g', '1.3g']);
  change('manual-cal', '0');
  change('manual-carbs', '20');
  expect(input('manual-cal').value).toBe('0');
  click('[data-mode="ingredients"]');
  click('[data-mode="manual"]');
  submit();
  expect(recipes.update).toHaveBeenLastCalledWith(1, expect.objectContaining({
    totalServings: 3, manualCalories: 0, manualCarbsG: 20, manualProteinG: 5, manualFatG: 4,
  }));
  await settle();
});

it('recovers legacy measure quantity and supports modal and row removal', async () => {
  const legacy = loaded();
  legacy.ingredients[0].qty = null;
  legacy.ingredients[0].unit_label = null;
  legacy.ingredients[0].servings = 4;
  vi.mocked(recipes.get).mockResolvedValueOnce(legacy);
  go('/recipes/1');
  await settle();
  expect(document.querySelector('.ingredient-unit')!.textContent).toBe('2x cup');
  click('.ingredient-clickable');
  expect(input('ing-qty').value).toBe('2');
  expect(document.querySelector('#ing-modal-total')!.textContent).toContain('400 kcal');
  click('#ing-qty-plus');
  expect(input('ing-qty').value).toBe('3');
  click('#ing-qty-minus');
  expect(input('ing-qty').value).toBe('2');
  click('#ing-add-btn');
  click('.ingredient-clickable');
  click('#ing-remove-btn');
  expect(document.querySelectorAll('.ingredient-row')).toHaveLength(0);
  vi.mocked(foods.search).mockResolvedValue({ foods: [food('Another')], external: [] });
  change('ing-search', 'another');
  await vi.advanceTimersByTimeAsync(400);
  click('#ing-results .food-item');
  click('#ing-add-btn');
  expect(document.querySelectorAll('.ingredient-row')).toHaveLength(1);
  click('.btn-remove-ing');
  expect(document.querySelectorAll('.ingredient-row')).toHaveLength(0);
});

it.each(actions)('%s keeps the mounted identity even when the caller changes its params', async action => {
  mutableParams.id = action === 'create' ? 'new' : '1';
  go('/captured');
  await settle();
  mutableParams.id = '99';
  change('recipe-name', 'Captured identity');
  act(action);
  if (action === 'update') expect(recipes.update).toHaveBeenLastCalledWith(1, expect.objectContaining({ name: 'Captured identity' }));
  else if (action === 'create') expect(recipes.create).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Captured identity' }));
  else expect(recipes[action]).toHaveBeenLastCalledWith(1);
  await settle();
});

it.each(actions)('%s completions are silent when the captured root is disconnected before router cleanup', async action => {
  const pending = deferred<{ recipe: { id: number }; success: boolean }>();
  vi.mocked(recipes[action]).mockReturnValueOnce(pending.promise);
  go(action === 'create' ? '/recipes/new' : '/recipes/1');
  await settle();
  act(action);
  const root = document.querySelector('.page')!;
  root.remove();
  const detached = root.outerHTML;
  const hash = window.location.hash;
  pending.resolve({ recipe: { id: 99 }, success: true });
  await settle();
  expect(root.outerHTML).toBe(detached);
  expect(window.location.hash).toBe(hash);
  expect(window.alert).not.toHaveBeenCalled();
});

it('a current duplicate can finish while save is pending, without reviving save effects', async () => {
  const save = deferred<Awaited<ReturnType<typeof recipes.update>>>();
  vi.mocked(recipes.update).mockReturnValueOnce(save.promise);
  go('/recipes/1');
  await settle();
  submit();
  const button = document.querySelector<HTMLButtonElement>('[type=submit]')!;
  click('#copy-recipe');
  await settle();
  expect(window.location.hash).toBe('#/recipes/3');
  expect(input('recipe-name').value).toBe('Recipe 3');
  save.reject(new Error('late save'));
  await settle();
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Save Changes');
  expect(input('recipe-name').value).toBe('Recipe 3');
  expect(window.alert).not.toHaveBeenCalled();
});

it('same-mount hydration still applies after input, while current and departed load failures stay silent', async () => {
  const hydration = deferred<ReturnType<typeof loaded>>();
  vi.mocked(recipes.get).mockReturnValueOnce(hydration.promise);
  go('/recipes/1');
  change('recipe-name', 'Early input');
  hydration.resolve(loaded());
  await settle();
  expect(input('recipe-name').value).toBe('Recipe 1');
  expect(document.querySelector('.ingredient-name')!.textContent).toBe('Ingredient 1');
  for (const depart of [false, true]) {
    const pending = deferred<ReturnType<typeof loaded>>();
    vi.mocked(recipes.get).mockReturnValueOnce(pending.promise);
    go('/recipes/1');
    if (depart) go('/recipes/new');
    change('recipe-name', 'Available draft');
    pending.reject(new Error('unavailable'));
    await settle();
    expect(input('recipe-name').value).toBe('Available draft');
    expect(document.querySelector('#ing-modal')!.classList.contains('hidden')).toBe(true);
    expect(window.alert).not.toHaveBeenCalled();
  }
});

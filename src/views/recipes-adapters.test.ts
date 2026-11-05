import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, recipes, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { deferred, externalFood, food } from '../test/food-search-fixtures';
import { recipeEditView } from './recipes';

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function click(selector: string) {
  document.querySelector<HTMLElement>(selector)!.click();
}

function change(id: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`#${id}`)!;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

function submit() {
  document.querySelector('#recipe-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/recipes/:id', recipeEditView);
  route('/recipes', () => ({ html: '<p>Recipes destination</p>', init() {} }));
  route('/other', () => ({ html: '<p>Other view</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  vi.useFakeTimers();
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seedRecipe() {
  const { food: saved } = await foods.create(food('Guest apple'));
  const { recipe } = await recipes.create({
    name: 'Guest recipe', totalServings: 2, servingUnit: 'bowl',
    ingredients: [{ foodId: saved.id, servings: 2, qty: 1, unitLabel: 'cup' }],
  });
  return { id: recipe.id, foodId: saved.id };
}

it('guest Recipe edit/save round trip retains ingredient identity, quantity and nutrition', async () => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const { id, foodId } = await seedRecipe();
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('.ingredient-name')!.textContent).toBe('Guest apple');
  click('.ingredient-clickable');
  change('ing-qty', '2');
  click('#ing-add-btn');
  change('recipe-name', 'Edited guest recipe');
  change('recipe-servings', '4');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect(window.location.hash).toBe('#/recipes');
  const saved = await recipes.get(id);
  expect(saved.recipe.name).toBe('Edited guest recipe');
  expect(saved.ingredients).toEqual([expect.objectContaining({ food_id: foodId, servings: 4, qty: 2 })]);
  expect(saved.recipe.perServing).toEqual({ calories: 100, carbsG: 10, proteinG: 5, fatG: 4 });
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector<HTMLInputElement>('#recipe-name')!.value).toBe('Edited guest recipe');
  expect(document.querySelectorAll('.ingredient-row')).toHaveLength(1);
  expect([...document.querySelectorAll('#recipe-totals strong')].map(el => el.textContent)).toEqual(['100', '10g', '5g', '4g']);
  expect(network).not.toHaveBeenCalled();
});

it('signed-in HTTP adapters preserve update and external-selection inputs across departure', async () => {
  const { id } = await seedRecipe();
  const existing = await recipes.get(id);
  setGuestMode(false);
  setToken('test-token');
  const external = externalFood('HTTP apple');
  const pendingSave = deferred<Response>();
  const pendingUpdate = deferred<Response>();
  const requests: { path: string; method: string; body: unknown }[] = [];
  const network = vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.replace('/api', '');
    const method = options?.method ?? 'GET';
    requests.push({ path, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (path.startsWith('/foods/search?')) return Response.json({ foods: [], external: [external] });
    if (path === '/foods/save-external') return pendingSave.promise;
    if (path === `/recipes/${id}` && method === 'GET') return Response.json(existing);
    if (path === `/recipes/${id}` && method === 'PUT') return pendingUpdate.promise;
    throw new Error(`Unexpected HTTP request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', network);
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  change('ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  click('#ing-results .food-item');
  pendingSave.resolve(Response.json({ food: { ...food('HTTP apple'), id: 91 } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#ing-modal-name')!.textContent).toBe('HTTP apple');
  click('#ing-add-btn');
  change('recipe-name', 'HTTP edit');
  submit();
  go('/recipes/new');
  change('recipe-name', 'Current draft');
  const current = document.querySelector('#app')!.innerHTML;
  pendingUpdate.resolve(Response.json({ success: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector<HTMLInputElement>('#recipe-name')!.value).toBe('Current draft');
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(window.location.hash).toBe('#/recipes/new');
  expect(requests).toContainEqual({ path: '/foods/save-external', method: 'POST', body: external });
  expect(requests).toContainEqual({ path: `/recipes/${id}`, method: 'PUT', body: {
    name: 'HTTP edit', totalServings: 2, servingUnit: 'bowl',
    ingredients: [
      { foodId: existing.ingredients[0].food_id, servings: 2, qty: 1, unitLabel: 'cup' },
      { foodId: 91, servings: 1, qty: 1, unitLabel: '100g' },
    ],
    manualCalories: null, manualCarbsG: null, manualProteinG: null, manualFatG: null,
  } });
  expect(network.mock.calls.every(([, options]) => options?.credentials === 'include'
    && new Headers(options.headers).get('Authorization') === 'Bearer test-token')).toBe(true);
});

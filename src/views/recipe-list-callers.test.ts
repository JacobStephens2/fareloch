import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, recipes, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { deferred, food } from '../test/food-search-fixtures';
import { change, click, go } from '../test/recipe-editor-fixtures';
import type { Recipe } from '../types';
import { recipesView } from './recipes';
import { logFoodView } from './log-food';

const recipe: Recipe = {
  id: 7, user_id: 1, name: 'Recipe bowl', total_servings: 1, serving_unit: 'bowl',
  manual_calories: null, manual_carbs_g: null, manual_protein_g: null, manual_fat_g: null,
  ingredientCount: 0, perServing: { calories: 101, carbsG: 10.1, proteinG: 5.1, fatG: 4.1 },
};
let decode: (code: string) => void;
vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class {
    start(_camera: unknown, _config: unknown, onDecode: (code: string) => void) {
      decode = onDecode;
      return Promise.resolve();
    }
    stop() { return Promise.resolve(); }
  },
}));

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/recipes', recipesView);
  route('/recipes/:id', () => ({ html: '<p>Recipe editor destination</p>', init() {} }));
  route('/log', logFoodView);
  route('/other', () => ({ html: '<p>Other view</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  localStorage.clear();
  setGuestMode(false);
  setToken('recipe-list-token');
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/recipes') return Response.json({ recipes: [recipe] });
    if (url === '/api/foods/recent') return Response.json({ foods: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  go('/other');
  document.querySelectorAll('body > aside').forEach(el => el.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

it('a late read cannot change the departed Recipes list', async () => {
  const pending = deferred<Awaited<ReturnType<typeof recipes.list>>>();
  vi.spyOn(recipes, 'list').mockReturnValueOnce(pending.promise);
  go('/recipes');
  const old = document.querySelector('#recipe-list')!;
  const before = old.innerHTML;
  go('/other');
  pending.resolve({ recipes: [recipe] });
  await settle();
  expect(old.innerHTML).toBe(before);
  expect(window.location.hash).toBe('#/other');
});

it('a retained departed Recipes row cannot navigate to its editor', async () => {
  go('/recipes');
  await settle();
  const old = document.querySelector<HTMLElement>('.food-item')!;
  go('/other');
  old.click();
  expect(window.location.hash).toBe('#/other');
});

it('the Log Food Recipes tab labels a zero-ingredient Ingredients recipe correctly', async () => {
  go('/log');
  click('[data-tab="recipes"]');
  await settle();
  expect(document.querySelector('.food-serving')!.textContent).toBe('0 ingredients · 1 bowl');
});

it('a retained Recipe-tab row reinserted after switching to Quick Add cannot open a modal', async () => {
  go('/log');
  click('[data-tab="recipes"]');
  await settle();
  const old = document.querySelector<HTMLElement>('.food-item')!;
  click('[data-tab="quick"]');
  document.querySelector('#tab-content')!.append(old);
  old.click();
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(true);
});

it('a late failure cannot change a departed Recipes list or a later mount', async () => {
  const pending = deferred<Awaited<ReturnType<typeof recipes.list>>>();
  vi.spyOn(recipes, 'list').mockReturnValueOnce(pending.promise);
  go('/recipes');
  const old = document.querySelector('#recipe-list')!;
  const before = old.innerHTML;
  go('/recipes');
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  pending.reject(new Error('Old read failed'));
  await settle();
  expect(old.innerHTML).toBe(before);
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
});

it('current Recipes rows and New Recipe navigate, while departed New Recipe controls stay inert after reinsertion', async () => {
  go('/recipes');
  await settle();
  click('.food-item');
  expect(window.location.hash).toBe('#/recipes/7');
  go('/recipes');
  const oldRoot = document.querySelector<HTMLElement>('#app .page')!;
  const newRecipe = oldRoot.querySelector<HTMLElement>('#new-recipe-btn')!;
  newRecipe.click();
  expect(window.location.hash).toBe('#/recipes/new');
  go('/other');
  document.querySelector('#app')!.append(oldRoot);
  newRecipe.click();
  expect(window.location.hash).toBe('#/other');
});

it.each(['manage', 'meal'] as const)('%s resolves and wires its own elements with matching IDs outside the router outlet', async kind => {
  const decoy = document.createElement('aside');
  decoy.innerHTML = kind === 'manage' ? recipesView().html : logFoodView().html;
  document.body.prepend(decoy);
  const before = decoy.innerHTML;
  go(kind === 'manage' ? '/recipes' : '/log');
  if (kind === 'meal') click('#app [data-tab="recipes"]');
  await settle();
  click('#app .food-item');
  if (kind === 'manage') expect(window.location.hash).toBe('#/recipes/7');
  else expect(document.querySelector('#app #modal-food-name')!.textContent).toBe('Recipe bowl');
  expect(decoy.innerHTML).toBe(before);
});

const replacements = ['quick', 'recent', 'custom', 'search', 'query', 'recipes', 'departure'] as const;
it.each(replacements.flatMap(replacement => (['success', 'failure'] as const).map(outcome => ({ replacement, outcome }))))(
  'Recipe read $outcome cannot overwrite $replacement', async ({ replacement, outcome }) => {
    const pending = deferred<Awaited<ReturnType<typeof recipes.list>>>();
    vi.spyOn(recipes, 'list').mockReturnValueOnce(pending.promise);
    go('/log');
    click('[data-tab="recipes"]');
    const old = document.querySelector('#tab-content')!.firstElementChild!;
    const before = old.innerHTML;
    if (replacement === 'query') change('food-search', 'apple');
    else if (replacement === 'departure') go('/other');
    else click(`[data-tab="${replacement}"]`);
    await settle();
    const current = document.querySelector('#app')!.innerHTML;
    if (outcome === 'success') pending.resolve({ recipes: [{ ...recipe, name: 'Obsolete recipe' }] });
    else pending.reject(new Error('Obsolete read'));
    await settle();
    expect(old.innerHTML).toBe(before);
    expect(document.querySelector('#app')!.innerHTML).toBe(current);
    if (replacement === 'recipes') expect(document.querySelector('.food-item-name')!.textContent).toBe('Recipe bowl');
  },
);

it('every Recipes selection gets a fresh child host; a retained old host stays inert inside the current tab', async () => {
  go('/log');
  click('[data-tab="recipes"]');
  await settle();
  const old = document.querySelector<HTMLElement>('#tab-content > .food-list')!;
  click('[data-tab="recipes"]');
  await settle();
  const current = document.querySelector('#tab-content > .food-list')!;
  expect(current).not.toBe(old);
  current.append(old);
  old.querySelector<HTMLElement>('.food-item')!.click();
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(true);
  current.querySelector<HTMLElement>(':scope > .food-item')!.click();
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('Recipe bowl');
});

it.each(['success', 'failure'] as const)('a late Recipe %s cannot overwrite pending barcode feedback', async outcome => {
  const pending = deferred<Awaited<ReturnType<typeof recipes.list>>>();
  const barcode = deferred<Awaited<ReturnType<typeof foods.barcode>>>();
  vi.spyOn(recipes, 'list').mockReturnValueOnce(pending.promise);
  vi.spyOn(foods, 'barcode').mockReturnValueOnce(barcode.promise);
  go('/log');
  click('[data-tab="recipes"]');
  const old = document.querySelector('#tab-content')!.firstElementChild!;
  const before = old.innerHTML;
  click('#scan-btn');
  await settle();
  decode('12345');
  await settle();
  expect(document.querySelector('#tab-content')!.textContent).toBe('Looking up barcode...');
  if (outcome === 'success') pending.resolve({ recipes: [recipe] });
  else pending.reject(new Error('Obsolete read'));
  await settle();
  expect(document.querySelector('#tab-content')!.textContent).toBe('Looking up barcode...');
  expect(old.innerHTML).toBe(before);
  barcode.resolve({ food: food('Scanned apple') });
  await settle();
  expect(document.querySelector('#tab-content')!.textContent).toBe('Found: Scanned apple');
});

it.each(['success', 'failure'] as const)('a late Recipe %s cannot overwrite completed barcode feedback', async outcome => {
  const pending = deferred<Awaited<ReturnType<typeof recipes.list>>>();
  vi.spyOn(recipes, 'list').mockReturnValueOnce(pending.promise);
  vi.spyOn(foods, 'barcode').mockRejectedValueOnce(new Error('Not found'));
  go('/log');
  click('[data-tab="recipes"]');
  click('#scan-btn');
  await settle();
  decode('12345');
  await settle();
  expect(document.querySelector('#tab-content')!.textContent).toBe('No product found for barcode 12345');
  if (outcome === 'success') pending.resolve({ recipes: [recipe] });
  else pending.reject(new Error('Obsolete read'));
  await settle();
  expect(document.querySelector('#tab-content')!.textContent).toBe('No product found for barcode 12345');
});

it('closing a modal and opening/closing the scanner leave a surviving Recipe list selectable', async () => {
  go('/log');
  click('[data-tab="recipes"]');
  await settle();
  const row = document.querySelector<HTMLElement>('.food-item')!;
  row.click();
  click('#modal-close');
  click('#scan-btn');
  await settle();
  click('#scanner-close');
  await settle();
  row.click();
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('Recipe bowl');
});

it.each(['manage', 'meal'] as const)('guest %s reads real Recipe storage without network access', async kind => {
  setGuestMode(true);
  const network = vi.fn(() => { throw new Error('Guest list must not use the network'); });
  vi.stubGlobal('fetch', network);
  await recipes.create({
    name: 'Guest list recipe', totalServings: 2, servingUnit: 'bowl', ingredients: [],
    manualCalories: 202, manualCarbsG: 20.2, manualProteinG: 10.2, manualFatG: 8.2,
  });
  go(kind === 'manage' ? '/recipes' : '/log');
  if (kind === 'meal') click('[data-tab="recipes"]');
  await settle();
  expect(document.querySelector('.food-item-name')!.textContent).toBe('Guest list recipe');
  expect(document.querySelector('.chip-calories')!.textContent).toBe('101');
  expect(network).not.toHaveBeenCalled();
});

it.each(['manage', 'meal'] as const)('signed-in %s reads once with existing request credentials', async kind => {
  go(kind === 'manage' ? '/recipes' : '/log');
  if (kind === 'meal') click('[data-tab="recipes"]');
  await settle();
  const requests = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/recipes');
  expect(requests).toHaveLength(1);
  const [, options] = requests[0];
  expect(options?.credentials).toBe('include');
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer recipe-list-token');
  expect(document.querySelector('.food-item-name')!.textContent).toBe('Recipe bowl');
});

import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, recipes } from '../api';
import { route, setCleanup, startRouter } from '../router';
import { logFoodView } from './log-food';
import { recipeEditView } from './recipes';
import { deferred, food, result } from '../test/food-search-fixtures';
import type { FoodSearchResult } from '../food-search-session';
import type { ExternalFood, Recipe } from '../types';

vi.mock('../api', () => ({
  foods: { search: vi.fn(), recent: vi.fn(), custom: vi.fn(), saveExternal: vi.fn() },
  recipes: { list: vi.fn(), get: vi.fn(), create: vi.fn() },
  meals: { log: vi.fn() },
}));

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function input(selector: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(selector)!;
  el.value = value;
  el.dispatchEvent(new Event('input'));
  return el;
}

function click(selector: string) {
  document.querySelector<HTMLElement>(selector)!.click();
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  route('/log', logFoodView);
  route('/recipe', () => recipeEditView({ id: 'new' }));
  route('/existing', () => recipeEditView({ id: '1' }));
  route('/other', () => ({ html: '<p>Other view</p>', init() {} }));
  startRouter();
});

it('router consumes cleanup once before matched and unmatched departures', () => {
  const cleanup = vi.fn();
  setCleanup(cleanup);
  go('/missing');
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#app')!.textContent).toContain('Page not found');
  go('/other');
  expect(cleanup).toHaveBeenCalledTimes(1);
  setCleanup(cleanup);
  go('/log');
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it('cleared ingredient suggestions cannot be reopened by an old search', async () => {
  const pending = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValue(pending.promise);
  go('/recipe');
  const search = input('#ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  input('#ing-search', '');
  pending.resolve(result('Old apple'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#ing-results')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector('#ing-results')!.textContent).toBe('');
  expect(search.classList.contains('searching')).toBe(false);
});

beforeEach(() => {
  go('/other');
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.mocked(foods.recent).mockResolvedValue({ foods: [] });
  vi.mocked(foods.search).mockResolvedValue({ foods: [], external: [] });
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
});

it('Log Food clears stale choices immediately and only renders the latest search', async () => {
  const old = deferred<FoodSearchResult>();
  const current = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  go('/log');
  const search = input('#food-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  input('#food-search', 'pear');
  await vi.advanceTimersByTimeAsync(400);
  current.resolve(result('New pear'));
  await vi.advanceTimersByTimeAsync(0);
  old.resolve(result('Old apple'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#tab-content')!.textContent).toContain('New pear');
  expect(document.querySelector('#tab-content')!.textContent).not.toContain('Old apple');
  input('#food-search', 'plum');
  expect(document.querySelectorAll('#tab-content .food-item')).toHaveLength(0);
  expect(search.classList.contains('searching')).toBe(true);
});

it.each(['/log', '/recipe'])('%s ignores old failures while the current search loads, then permits retry', async path => {
  const old = deferred<FoodSearchResult>();
  const current = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  go(path);
  const selector = path === '/log' ? '#food-search' : '#ing-search';
  const container = path === '/log' ? '#tab-content' : '#ing-results';
  const search = input(selector, 'old');
  await vi.advanceTimersByTimeAsync(400);
  input(selector, 'new');
  await vi.advanceTimersByTimeAsync(400);
  old.reject(new Error('obsolete'));
  await vi.advanceTimersByTimeAsync(0);
  expect(search.classList.contains('searching')).toBe(true);
  expect(document.querySelector(container)!.textContent).not.toContain('Search failed');
  current.reject(new Error('current'));
  await vi.advanceTimersByTimeAsync(0);
  expect(search.classList.contains('searching')).toBe(false);
  expect(document.querySelector(container)!.textContent).toContain('Search failed');
  vi.mocked(foods.search).mockResolvedValue(result('Retry food'));
  input(selector, 'new');
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector(container)!.textContent).toContain('Retry food');
});

it('Log Food starts with Recent and short queries restore defaults without a searching indicator', async () => {
  vi.mocked(foods.recent).mockResolvedValue({ foods: [food('Recent apple')] });
  go('/log');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#tab-content h4')!.textContent).toBe('Recent');
  expect(document.querySelector('#tab-content')!.textContent).toContain('Recent apple');
  input('#food-search', 'pear');
  expect(document.querySelectorAll('#tab-content .food-item')).toHaveLength(0);
  const search = input('#food-search', 'a');
  expect(search.classList.contains('searching')).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#tab-content')!.textContent).toContain('Recent apple');
  vi.mocked(foods.recent).mockRejectedValue(new Error('offline'));
  input('#food-search', '');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#tab-content')!.textContent).toBe('Type to search for foods');
  vi.mocked(foods.recent).mockResolvedValue({ foods: [] });
  input('#food-search', '');
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#tab-content')!.textContent).toBe('Type to search for foods');
});

it('Log Food ignores an old recent default after starting a search', async () => {
  const recent = deferred<{ foods: ReturnType<typeof food>[] }>();
  vi.mocked(foods.recent).mockReturnValue(recent.promise);
  vi.mocked(foods.search).mockResolvedValue(result('Search pear'));
  go('/log');
  input('#food-search', 'pear');
  await vi.advanceTimersByTimeAsync(400);
  recent.resolve({ foods: [food('Old recent')] });
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#tab-content')!.textContent).toContain('Search pear');
  expect(document.querySelector('#tab-content')!.textContent).not.toContain('Old recent');
});

it('Log Food deactivates Search for other tabs and typing selects Search again', async () => {
  const pending = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValueOnce(pending.promise).mockResolvedValue(result('Resumed pear'));
  go('/log');
  input('#food-search', 'pear');
  await vi.advanceTimersByTimeAsync(400);
  click('[data-tab="quick"]');
  pending.resolve(result('Obsolete pear'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#quick-form')).not.toBeNull();
  expect(document.querySelector('#food-search')!.classList.contains('searching')).toBe(false);
  click('[data-tab="search"]');
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector('#tab-content')!.textContent).toContain('Resumed pear');
  click('[data-tab="quick"]');
  input('#food-search', 'apple');
  expect(document.querySelector('.tab.active')!.getAttribute('data-tab')).toBe('search');
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector('#tab-content')!.textContent).toContain('Resumed pear');
});

it.each(['recent', 'custom', 'recipes'])('late %s tab results and failures cannot overwrite a newly selected tab or Search', async tab => {
  go('/log');
  await vi.advanceTimersByTimeAsync(0);
  const pending = deferred<{ foods: ReturnType<typeof food>[]; recipes: Recipe[] }>();
  if (tab === 'recent') vi.mocked(foods.recent).mockReturnValue(pending.promise);
  if (tab === 'custom') vi.mocked(foods.custom).mockReturnValue(pending.promise);
  if (tab === 'recipes') vi.mocked(recipes.list).mockReturnValue(pending.promise);
  click(`[data-tab="${tab}"]`);
  click('[data-tab="quick"]');
  pending.resolve({ foods: [food('Obsolete tab')], recipes: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#quick-form')).not.toBeNull();
  const failure = deferred<{ foods: ReturnType<typeof food>[]; recipes: Recipe[] }>();
  if (tab === 'recent') vi.mocked(foods.recent).mockReturnValue(failure.promise);
  if (tab === 'custom') vi.mocked(foods.custom).mockReturnValue(failure.promise);
  if (tab === 'recipes') vi.mocked(recipes.list).mockReturnValue(failure.promise);
  click(`[data-tab="${tab}"]`);
  input('#food-search', 'pear');
  vi.mocked(foods.search).mockResolvedValue(result('Current pear'));
  await vi.advanceTimersByTimeAsync(400);
  failure.reject(new Error('old tab'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#tab-content')!.textContent).toContain('Current pear');
});

it('manual mode invalidates pending ingredient work and returning resumes the current query', async () => {
  const old = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValueOnce(old.promise).mockResolvedValue(result('Resumed apple'));
  go('/recipe');
  input('#ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  click('[data-mode="manual"]');
  old.resolve(result('Old apple'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#ing-results')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector('#ing-search')!.classList.contains('searching')).toBe(false);
  click('[data-mode="ingredients"]');
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector('#ing-results')!.textContent).toContain('Resumed apple');
});

it('loading an existing manual recipe deactivates ingredient search', async () => {
  const existing = deferred<Awaited<ReturnType<typeof recipes.get>>>();
  const pending = deferred<FoodSearchResult>();
  vi.mocked(recipes.get).mockReturnValue(existing.promise);
  vi.mocked(foods.search).mockReturnValue(pending.promise);
  go('/existing');
  input('#ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  existing.resolve({ recipe: {
    id: 1, user_id: 1, name: 'Manual recipe', total_servings: 1, serving_unit: 'serving',
    manual_calories: 200, manual_carbs_g: 20, manual_protein_g: 10, manual_fat_g: 8,
    ingredientCount: 0, perServing: { calories: 200, carbsG: 20, proteinG: 10, fatG: 8 },
  }, ingredients: [] });
  await vi.advanceTimersByTimeAsync(0);
  pending.resolve(result('Old apple'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('[data-mode].active')!.getAttribute('data-mode')).toBe('manual');
  expect(document.querySelector('#ing-results')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector('#ing-search')!.classList.contains('searching')).toBe(false);
});

it('adding and editing ingredients preserves measures and invalidates concurrent search', async () => {
  vi.mocked(foods.search).mockResolvedValue(result('Apple'));
  go('/recipe');
  input('#ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  click('#ing-results .food-item');
  const select = document.querySelector<HTMLSelectElement>('#ing-unit-select')!;
  select.value = '0';
  select.dispatchEvent(new Event('change'));
  const adding = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValueOnce(adding.promise);
  input('#ing-search', 'pear');
  await vi.advanceTimersByTimeAsync(400);
  click('#ing-add-btn');
  adding.resolve(result('Obsolete pear'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#ingredients-list')!.textContent).toContain('cup');
  expect(document.querySelector('#ing-results')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector<HTMLInputElement>('#ing-search')!.value).toBe('');
  click('.ingredient-clickable');
  const editUnit = document.querySelector<HTMLSelectElement>('#ing-unit-select')!;
  editUnit.value = '0';
  editUnit.dispatchEvent(new Event('change'));
  input('#ing-qty', '2');
  const editing = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValueOnce(editing.promise);
  input('#ing-search', 'plum');
  await vi.advanceTimersByTimeAsync(400);
  click('#ing-add-btn');
  editing.resolve(result('Obsolete plum'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelectorAll('.ingredient-row')).toHaveLength(1);
  expect(document.querySelector('#ing-results')!.classList.contains('hidden')).toBe(true);
  document.querySelector('#recipe-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(recipes.create).toHaveBeenCalledWith(expect.objectContaining({
    ingredients: [{ foodId: 1, servings: 4, qty: 2, unitLabel: '2x cup' }],
  }));
  await vi.advanceTimersByTimeAsync(0);
});

it.each(['/other', '/missing'])('pending searches and tab loads cannot publish after departure to %s', async destination => {
  const pending = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValue(pending.promise);
  go('/log');
  input('#food-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  const content = document.querySelector('#tab-content')!;
  go(destination);
  const departed = content.innerHTML;
  pending.resolve(result('Old apple'));
  await vi.advanceTimersByTimeAsync(0);
  expect(content.innerHTML).toBe(departed);
  go('/recipe');
  const ingredients = deferred<FoodSearchResult>();
  vi.mocked(foods.search).mockReturnValue(ingredients.promise);
  input('#ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  const suggestions = document.querySelector('#ing-results')!;
  go(destination);
  const hidden = suggestions.innerHTML;
  ingredients.resolve(result('Old ingredient'));
  await vi.advanceTimersByTimeAsync(0);
  expect(suggestions.innerHTML).toBe(hidden);
  go('/log');
  const custom = deferred<{ foods: ReturnType<typeof food>[] }>();
  vi.mocked(foods.custom).mockReturnValue(custom.promise);
  click('[data-tab="custom"]');
  const tabContent = document.querySelector('#tab-content')!;
  go(destination);
  const previous = tabContent.innerHTML;
  custom.resolve({ foods: [food('Old tab food')] });
  await vi.advanceTimersByTimeAsync(0);
  expect(tabContent.innerHTML).toBe(previous);
});

it.each(['/log', '/recipe'])('%s shows search result name, brand, serving unit, and source label as text', async path => {
  const tag = (field: string) => `${field}<img alt="${field}">`;
  const saved = food(tag('saved-name'));
  saved.brand = tag('saved-brand');
  saved.serving_unit = tag('saved-unit');
  saved.source = tag('saved-source');
  const external: ExternalFood = {
    name: tag('external-name'), brand: tag('external-brand'), barcode: null,
    servingSize: 100, servingUnit: tag('external-unit'),
    calories: 100, carbsG: 10, proteinG: 5, fatG: 4, fiberG: 0, sugarG: 0,
    source: tag('external-source'), sourceId: '1',
  };
  vi.mocked(foods.search).mockResolvedValue({ foods: [saved], external: [external] });
  go(path);
  input(path === '/log' ? '#food-search' : '#ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  const container = document.querySelector(path === '/log' ? '#tab-content' : '#ing-results')!;
  expect(container.querySelector('img')).toBeNull();
  for (const field of ['saved-name', 'saved-brand', 'saved-unit', 'saved-source', 'external-name', 'external-brand', 'external-unit', 'external-source']) {
    expect(container.textContent).toContain(tag(field));
  }
});

it('Log Food retains saved/external selection, source badges, attribution and meal context', async () => {
  const external: ExternalFood = {
    name: 'External apple', brand: null, barcode: null, servingSize: 100, servingUnit: 'g',
    calories: 100, carbsG: 10, proteinG: 5, fatG: 4, fiberG: 0, sugarG: 0,
    source: 'fatsecret', sourceId: '123', measures: [{ label: 'cup', gramWeight: 200 }],
  };
  vi.mocked(foods.search).mockResolvedValue({ foods: [food('Saved apple')], external: [external] });
  vi.mocked(foods.saveExternal).mockResolvedValue({ food: food('External apple') });
  go('/log?meal=lunch&date=2026-10-20');
  input('#food-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector('#tab-content')!.textContent).toContain('Saved Foods');
  expect(document.querySelector('#tab-content')!.textContent).toContain('External Results');
  expect(document.querySelector('#tab-content .food-source.source-fatsecret')!.textContent).toBe('FatSecret');
  expect(document.querySelector('.api-attribution a')!.getAttribute('href')).toBe('https://platform.fatsecret.com');
  click('#tab-content .food-item');
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('Saved apple');
  click('#modal-close');
  document.querySelectorAll<HTMLElement>('#tab-content .food-item')[1].click();
  await vi.advanceTimersByTimeAsync(0);
  expect(foods.saveExternal).toHaveBeenCalledWith(external);
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('External apple');
  const unit = document.querySelector<HTMLSelectElement>('#unit-select')!;
  unit.value = '0';
  unit.dispatchEvent(new Event('change'));
  click('#add-food-btn');
  expect(meals.log).toHaveBeenCalledWith({ date: '2026-10-20', mealType: 'lunch', foodId: 1, servings: 2, unitLabel: 'cup', unitScale: 2 });
  await vi.advanceTimersByTimeAsync(0);
});

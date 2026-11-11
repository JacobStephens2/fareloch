import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, recipes } from '../api';
import { route, startRouter } from '../router';
import { deferred, externalFood, food } from '../test/food-search-fixtures';
import { change, click, go } from '../test/recipe-editor-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { logFoodView } from './log-food';
import { mountLogFood } from './log-food-session';
import type { Recipe } from '../types';

const recipe: Recipe = {
  id: 7, user_id: 1, name: 'Recipe bowl', total_servings: 3, serving_unit: 'bowl',
  manual_calories: null, manual_carbs_g: null, manual_protein_g: null, manual_fat_g: null,
  ingredientCount: 2, perServing: { calories: 101, carbsG: 10.1, proteinG: 5.1, fatG: 4.1 },
};
const completion = {
  food: food('Completed apple'),
  meal: {
    id: 9, user_id: 1, date: '2026-04-01', meal_type: 'lunch' as const,
    food_id: 1, recipe_id: null, servings: 4, calories: 400, carbs_g: 40, protein_g: 20, fat_g: 16,
    note: null, food_name: 'Apple', food_brand: null, serving_size: 100, serving_unit: 'g',
    unit_label: 'cup', unit_scale: 2, created_at: null, recipe_name: null,
  },
};
type Operation = 'external' | 'custom' | 'food' | 'recipe' | 'quick';

vi.mock('../api', () => ({
  foods: { search: vi.fn(), recent: vi.fn(), custom: vi.fn(), saveExternal: vi.fn(), barcode: vi.fn(), create: vi.fn() },
  recipes: { list: vi.fn() },
  meals: { log: vi.fn(), quickLog: vi.fn() },
}));

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/log', logFoodView);
  route('/', () => ({ html: '<p>Dashboard destination</p>', init() {} }));
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.mocked(foods.recent).mockResolvedValue({ foods: [] });
  vi.mocked(foods.custom).mockResolvedValue({ foods: [] });
  vi.mocked(recipes.list).mockResolvedValue({ recipes: [recipe] });
  vi.mocked(foods.search).mockResolvedValue({ foods: [], external: [externalFood('External apple')] });
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

it.each(['root', 'ancestor', '#modal-body', '#scanner-video', '[data-tab="quick"]', '#food-search', '#tab-content'])(
  'retained Back stays retired after synchronous %s departure and reconnection', async departure => {
  go('/log?date=2026-04-01&meal=lunch');
  await settle();
  const root = document.querySelector<HTMLElement>('.log-page')!;
  const back = document.querySelector<HTMLElement>('#back-btn')!;
  departAndReconnect(root, departure);
  back.click();
  expect(window.location.hash).toBe('#/log?date=2026-04-01&meal=lunch');
});

it('an initially disconnected Log Food mount stays inert after connection, and a fresh mount is independent', async () => {
  go('/other');
  const host = document.createElement('div');
  host.innerHTML = logFoodView().html;
  const root = host.querySelector<HTMLElement>('.log-page')!;
  const before = root.outerHTML;
  const dispose = mountLogFood(root, '2026-04-01', 'lunch');
  expect(root.outerHTML).toBe(before);
  document.querySelector('#app')!.append(root);
  click('#scan-btn');
  click('[data-tab="quick"]');
  click('#back-btn');
  expect(root.outerHTML).toBe(before);
  expect(foods.recent).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('#/other');
  dispose();
  dispose();
  const fresh = mountLogFood(root, '2026-04-01', 'lunch');
  click('[data-tab="quick"]');
  expect(root.querySelector('#quick-form')).not.toBeNull();
  fresh();
});

it('fixed parent departure stops retained child Macros edits before observer delivery', async () => {
  go('/log');
  click('[data-tab="quick"]');
  change('quick-carbs', '10');
  const calories = document.querySelector<HTMLInputElement>('#quick-cal')!;
  const back = document.querySelector('#back-btn')!;
  back.replaceWith(back.cloneNode(true));
  change('quick-carbs', '20');
  expect(calories.value).toBe('40');
});

it.each(['recent', 'custom', 'recipes'] as const)('%s read cannot render after fixed parent replacement before observer delivery', async tab => {
  go('/log');
  await settle();
  const read = deferred<{ foods: ReturnType<typeof food>[]; recipes: Recipe[] }>();
  if (tab === 'recipes') vi.mocked(recipes.list).mockReturnValueOnce(read.promise);
  else vi.mocked(foods[tab]).mockReturnValueOnce(read.promise);
  click(`[data-tab="${tab}"]`);
  await settle();
  read.resolve({ foods: [food('Retired result')], recipes: [recipe] });
  const back = document.querySelector('#back-btn')!;
  back.replaceWith(back.cloneNode(true));
  const root = document.querySelector('.log-page')!;
  const before = root.outerHTML;
  await settle();
  expect(root.outerHTML).toBe(before);
});

function submitForm(selector: string) {
  document.querySelector(selector)!.dispatchEvent(new Event('submit', { cancelable: true }));
}

async function begin(operation: Operation, pending: ReturnType<typeof deferred<typeof completion>>) {
  go('/log?date=2026-04-01&meal=lunch');
  await settle();
  if (operation === 'external') {
    vi.mocked(foods.saveExternal).mockReturnValue(pending.promise);
    await selectExternal();
    expect(foods.saveExternal).toHaveBeenCalledWith(externalFood('External apple'));
  } else if (operation === 'custom') {
    vi.mocked(foods.create).mockReturnValue(pending.promise);
    click('[data-tab="custom"]');
    await settle();
    click('#create-food-btn');
    change('cf-name', 'Created apple');
    change('cf-brand', 'Farm');
    change('cf-serving', '50');
    change('cf-unit', 'g');
    change('cf-carbs', '10');
    change('cf-protein', '5');
    change('cf-fat', '4');
    submitForm('#create-food-form');
    expect(foods.create).toHaveBeenCalledWith({
      name: 'Created apple', brand: 'Farm', serving_size: 50, serving_unit: 'g',
      calories: 96, carbs_g: 10, protein_g: 5, fat_g: 4,
    });
  } else if (operation === 'quick') {
    vi.mocked(meals.quickLog).mockReturnValue(pending.promise);
    click('[data-tab="quick"]');
    change('quick-name', 'Snack');
    change('quick-carbs', '10');
    change('quick-protein', '5');
    change('quick-fat', '4');
    submitForm('#quick-form');
    expect(meals.quickLog).toHaveBeenCalledWith({
      date: '2026-04-01', mealType: 'lunch', name: 'Snack', calories: 96, carbsG: 10, proteinG: 5, fatG: 4,
    });
  } else {
    vi.mocked(meals.log).mockReturnValue(pending.promise);
    if (operation === 'food') {
      vi.mocked(foods.recent).mockResolvedValue({ foods: [food('Saved apple')] });
      click('[data-tab="recent"]');
    } else click('[data-tab="recipes"]');
    await settle();
    click('.food-item');
    change('servings-input', '2');
    if (operation === 'food') {
      const unit = document.querySelector<HTMLSelectElement>('#unit-select')!;
      unit.value = '0';
      unit.dispatchEvent(new Event('change'));
      expect(document.querySelector('#modal-total')!.textContent).toBe('400 kcal40g C20g P16g F');
    } else expect(document.querySelector('#modal-total')!.textContent?.replace(/\s/g, '')).toBe('202kcal20.2gC10.2gP8.2gF');
    click('#add-food-btn');
    expect(meals.log).toHaveBeenCalledWith(operation === 'food' ? {
      date: '2026-04-01', mealType: 'lunch', foodId: 1, servings: 4, unitLabel: 'cup', unitScale: 2,
    } : { date: '2026-04-01', mealType: 'lunch', recipeId: 7, servings: 2 });
  }
}

async function selectExternal() {
  change('food-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  click('.food-item');
}

const staleCases = (['external', 'custom', 'food', 'recipe', 'quick'] as const).flatMap(operation =>
  (['success', 'failure'] as const).flatMap(outcome =>
    ['/other', '/missing', '/log?date=2026-04-01&meal=lunch', '/log?date=2026-05-02&meal=dinner']
      .map(destination => ({ operation, outcome, destination }))));

it.each(staleCases)('$operation $outcome stays silent after $destination', async ({ operation, outcome, destination }) => {
  const pending = deferred<typeof completion>();
  await begin(operation, pending);
  const oldRoot = document.querySelector('.log-page')!;
  go(destination);
  await settle();
  const oldHTML = oldRoot.innerHTML;
  const currentHTML = document.querySelector('#app')!.innerHTML;
  if (outcome === 'success') pending.resolve(completion);
  else pending.reject(new Error('Obsolete operation'));
  await settle();
  expect(oldRoot.innerHTML).toBe(oldHTML);
  expect(document.querySelector('#app')!.innerHTML).toBe(currentHTML);
  expect(window.location.hash).toBe(`#${destination}`);
  expect(window.alert).not.toHaveBeenCalled();
});

it.each(['external', 'custom', 'food', 'recipe', 'quick'] as const)(
  '%s accepted completion is silent after raw departure even before observer delivery', async operation => {
  for (const outcome of ['success', 'failure']) {
    for (const departure of ['root', 'ancestor', 'fixed replacement']) {
      const pending = deferred<typeof completion>();
      await begin(operation, pending);
      const root = document.querySelector<HTMLElement>('.log-page')!;
      const hash = window.location.hash;
      // Queue the continuation ahead of the mutation observer.
      if (outcome === 'success') pending.resolve(completion);
      else pending.reject(new Error('Retired write'));
      departAndReconnect(root, departure);
      const oldHTML = root.outerHTML;
      await settle();
      expect(root.outerHTML).toBe(oldHTML);
      expect(window.location.hash).toBe(hash);
      expect(window.alert).not.toHaveBeenCalled();
    }
  }
});

it.each(['external', 'custom', 'food', 'recipe', 'quick'] as const)('%s retains live failure/retry and success behavior', async operation => {
  const pending = deferred<typeof completion>();
  await begin(operation, pending);
  pending.reject(new Error('Current operation'));
  await settle();
  if (operation === 'external') expect(window.alert).toHaveBeenCalledWith('Failed to save food');
  else {
    const button = document.querySelector<HTMLButtonElement>(operation === 'custom' ? '#create-food-form button[type=submit]' : operation === 'quick' ? '#quick-form button' : '#add-food-btn')!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Failed - Retry');
  }
  vi.mocked(foods.saveExternal).mockResolvedValue(completion);
  vi.mocked(foods.create).mockResolvedValue(completion);
  vi.mocked(meals.log).mockResolvedValue(completion);
  vi.mocked(meals.quickLog).mockResolvedValue(completion);
  if (operation === 'external') click('.food-item');
  else if (operation === 'custom' || operation === 'quick') submitForm(operation === 'custom' ? '#create-food-form' : '#quick-form');
  else click('#add-food-btn');
  await settle();
  if (operation === 'external' || operation === 'custom') {
    expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('#modal-food-name')!.textContent).toBe('Completed apple');
  } else expect(window.location.hash).toBe('#/');
});

it.each(['external', 'custom'] as const)('%s already submitted can finish across live tab/query/modal changes', async operation => {
  const pending = deferred<typeof completion>();
  await begin(operation, pending);
  click('[data-tab="quick"]');
  change('food-search', 'new query');
  click('#modal-close');
  pending.resolve(completion);
  await settle();
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('Completed apple');
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(false);
  expect(window.location.hash).toBe('#/log?date=2026-04-01&meal=lunch');
});

it.each(['food', 'recipe', 'quick'] as const)('%s submission keeps its captured input and Dashboard return across live changes', async operation => {
  const pending = deferred<typeof completion>();
  await begin(operation, pending);
  if (operation !== 'quick') change('servings-input', '9');
  else change('quick-cal', '999');
  click('#modal-close');
  click('[data-tab="custom"]');
  await settle();
  pending.resolve(completion);
  await settle();
  expect(window.location.hash).toBe('#/');
  expect(window.alert).not.toHaveBeenCalled();
});

it.each(['external', 'custom', 'food', 'recipe', 'quick'] as const)('%s retained controls are inert after disposal or reconnection following observer delivery', async operation => {
  for (const departure of ['disposal', 'raw ancestor']) {
    const pending = deferred<typeof completion>();
    await begin(operation, pending);
    pending.resolve(completion);
    await settle();
    // Mount again to retain unsubmitted controls, including dynamically rendered ones.
    const next = deferred<typeof completion>();
    await begin(operation, next);
    const root = document.querySelector('.log-page')!;
    const retained = [...root.querySelectorAll<HTMLElement>('button, .food-item, input, select, form')];
    if (departure === 'disposal') go('/other');
    else {
      const ancestor = root.parentElement!;
      ancestor.remove();
      await settle();
      document.body.append(ancestor);
    }
    const hash = window.location.hash;
    for (const element of retained) {
      if (element.tagName === 'BUTTON') (element as HTMLButtonElement).disabled = false;
    }
    const currentHTML = document.querySelector('#app')!.innerHTML;
    const oldHTML = root.innerHTML;
    vi.clearAllMocks();
    for (const element of retained) {
      element.dispatchEvent(new Event(element.tagName === 'FORM' ? 'submit' : 'click', { cancelable: true }));
      element.dispatchEvent(new Event('input'));
      element.dispatchEvent(new Event('change'));
    }
    next.reject(new Error('Departed'));
    await settle();
    expect(foods.search).not.toHaveBeenCalled();
    expect(foods.saveExternal).not.toHaveBeenCalled();
    expect(foods.create).not.toHaveBeenCalled();
    expect(meals.log).not.toHaveBeenCalled();
    expect(meals.quickLog).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
    expect(document.querySelector('#app')!.innerHTML).toBe(currentHTML);
    expect(root.innerHTML).toBe(oldHTML);
    expect(window.location.hash).toBe(hash);
  }
});

it.each(['quick', 'custom'] as const)('%s replaced form stays inert when reattached, and Quick Add returns with fresh fields', async kind => {
  go('/log?date=2026-04-01&meal=lunch');
  await settle();
  click(`[data-tab="${kind}"]`);
  if (kind === 'custom') { await settle(); click('#create-food-btn'); }
  const prefix = kind === 'quick' ? 'quick' : 'cf';
  change(`${prefix}-carbs`, '10');
  const oldForm = document.querySelector<HTMLFormElement>(kind === 'quick' ? '#quick-form' : '#create-food-form')!;
  const oldCarbs = oldForm.querySelector<HTMLInputElement>(`#${prefix}-carbs`)!;
  const oldCalories = oldForm.querySelector<HTMLInputElement>(`#${prefix}-cal`)!;
  // A query replaces either form without going through a dedicated entry cleanup path.
  change('food-search', 'apple');
  document.querySelector('.log-page')!.append(oldForm);
  oldCarbs.value = '20';
  oldCarbs.dispatchEvent(new Event('input'));
  expect(oldCalories.value).toBe('40');
  oldForm.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(meals.quickLog).not.toHaveBeenCalled();
  expect(foods.create).not.toHaveBeenCalled();
  oldForm.remove();
  click('[data-tab="quick"]');
  expect(document.querySelector<HTMLInputElement>('#quick-cal')!.value).toBe('');
  expect(document.querySelector<HTMLInputElement>('#quick-carbs')!.value).toBe('');
  change('quick-cal', '200');
  click('[data-tab="recent"]');
  click('[data-tab="quick"]');
  change('quick-carbs', '10');
  expect(document.querySelector<HTMLInputElement>('#quick-cal')!.value).toBe('40');
});

import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, recipes, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { deferred, externalFood, food } from '../test/food-search-fixtures';
import { change, click, go } from '../test/recipe-editor-fixtures';
import { logFoodView } from './log-food';

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/log', logFoodView);
  route('/', () => ({ html: '<p>Dashboard destination</p>', init() {} }));
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
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

const settle = () => vi.advanceTimersByTimeAsync(0);

it.each(['recent', 'custom'] as const)('guest explicit %s reads saved Foods and selects without network access', async tab => {
  const network = vi.fn(() => { throw new Error('Guest saved reads must stay local'); });
  vi.stubGlobal('fetch', network);
  const { food: saved } = await foods.create(food('Guest saved apple'));
  go('/log');
  click(`[data-tab="${tab}"]`);
  await settle();
  expect(document.querySelector('#tab-content .food-item-name')!.textContent).toBe('Guest saved apple');
  expect(document.querySelector('#tab-content .loading-spinner, #tab-content .food-source')).toBeNull();
  click('#tab-content .food-item');
  expect(document.querySelector('#modal-food-name')!.textContent).toBe(saved.name);
  expect(network).not.toHaveBeenCalled();
});

it.each(['recent', 'custom'] as const)('signed-in explicit %s uses its existing authenticated read adapter', async tab => {
  setGuestMode(false);
  setToken('saved-read-token');
  const network = vi.fn(async (url: string) => {
    if (url === '/api/foods/recent') return Response.json({ foods: [food('HTTP recent')] });
    if (url === '/api/foods/custom') return Response.json({ foods: [food('HTTP custom')] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', network);
  go('/log');
  await settle();
  network.mockClear();
  click(`[data-tab="${tab}"]`);
  await settle();
  expect(network).toHaveBeenCalledExactlyOnceWith(`/api/foods/${tab}`, expect.objectContaining({
    credentials: 'include', headers: expect.objectContaining({ Authorization: 'Bearer saved-read-token' }),
  }));
  expect(document.querySelector('#tab-content .food-item-name')!.textContent).toBe(`HTTP ${tab}`);
  click('#tab-content .food-item');
  expect(document.querySelector('#modal-food-name')!.textContent).toBe(`HTTP ${tab}`);
});

it.each(['food', 'recipe', 'quick'] as const)('guest %s logging preserves captured values when its write settles after departure', async kind => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const { food: saved } = await foods.create(food('Guest apple'));
  const { recipe } = await recipes.create({
    name: 'Guest recipe', totalServings: 2, servingUnit: 'bowl',
    ingredients: [{ foodId: saved.id, servings: 2, qty: 1, unitLabel: 'cup' }],
  });
  const wait = deferred<void>();
  // The real local write runs immediately; only delivery of its result is delayed.
  const operation = kind === 'quick' ? meals.quickLog : meals.log;
  const delayed = vi.spyOn(meals, kind === 'quick' ? 'quickLog' : 'log').mockImplementation(async data => {
    const result = await operation(data);
    await wait.promise;
    return result;
  });
  go('/log?date=2026-04-01&meal=dinner');
  await settle();
  if (kind === 'quick') {
    click('[data-tab="quick"]');
    change('quick-name', 'Guest snack');
    change('quick-carbs', '10');
    change('quick-protein', '5');
    change('quick-fat', '4');
    change('quick-cal', '123');
    document.querySelector('#quick-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  } else {
    click(kind === 'food' ? '[data-tab="custom"]' : '[data-tab="recipes"]');
    await settle();
    click('.food-item');
    change('servings-input', '2');
    if (kind === 'food') {
      const select = document.querySelector<HTMLSelectElement>('#unit-select')!;
      select.value = '0';
      select.dispatchEvent(new Event('change'));
    }
    click('#add-food-btn');
  }
  go('/log?date=2026-05-02&meal=breakfast');
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  wait.resolve();
  await settle();
  expect(delayed).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(window.location.hash).toBe('#/log?date=2026-05-02&meal=breakfast');
  const logged = (await meals.getByDate('2026-04-01')).meals;
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ date: '2026-04-01', meal_type: 'dinner', ...(
    kind === 'food' ? {
      food_id: saved.id, recipe_id: null, servings: 4, unit_label: 'cup', unit_scale: 2,
      calories: 400, carbs_g: 40, protein_g: 20, fat_g: 16,
    } : kind === 'recipe' ? {
      food_id: null, recipe_id: recipe.id, servings: 2, calories: 200, carbs_g: 20, protein_g: 10, fat_g: 8,
    } : {
      food_id: null, recipe_id: null, note: 'Guest snack', servings: 1,
      calories: 123, carbs_g: 10, protein_g: 5, fat_g: 4,
    }) });
  expect((await meals.getByDate('2026-05-02')).meals).toHaveLength(0);
  expect(network).not.toHaveBeenCalled();
});

it('signed-in external selection and meal logging preserve HTTP inputs and credentials across departure', async () => {
  setGuestMode(false);
  setToken('test-token');
  const external = externalFood('HTTP apple');
  const saving = deferred<Response>();
  const logging = deferred<Response>();
  const requests: { path: string; method: string; body: unknown }[] = [];
  const network = vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.replace('/api', '');
    requests.push({ path, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : null });
    if (path === '/foods/recent') return Response.json({ foods: [] });
    if (path.startsWith('/foods/search?')) return Response.json({ foods: [], external: [external] });
    if (path === '/foods/save-external') return saving.promise;
    if (path === '/meals') return logging.promise;
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', network);
  go('/log?date=2026-04-01&meal=breakfast');
  change('food-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  click('.food-item');
  saving.resolve(Response.json({ food: { ...food('HTTP apple'), id: 91 } }));
  await settle();
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('HTTP apple');
  change('servings-input', '3');
  const select = document.querySelector<HTMLSelectElement>('#unit-select')!;
  select.value = '0';
  select.dispatchEvent(new Event('change'));
  click('#add-food-btn');
  go('/other');
  const current = document.querySelector('#app')!.innerHTML;
  logging.resolve(Response.json({ meal: { id: 17 } }));
  await settle();
  expect(window.location.hash).toBe('#/other');
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(requests).toContainEqual({ path: '/foods/save-external', method: 'POST', body: external });
  expect(requests).toContainEqual({ path: '/meals', method: 'POST', body: {
    date: '2026-04-01', mealType: 'breakfast', foodId: 91, servings: 6, unitLabel: 'cup', unitScale: 2,
  } });
  expect(network.mock.calls.every(([, options]) => options?.credentials === 'include'
    && new Headers(options.headers).get('Authorization') === 'Bearer test-token')).toBe(true);
});

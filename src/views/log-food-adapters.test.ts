import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, recipes, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { state } from '../state';
import { deferred, externalFood, food } from '../test/food-search-fixtures';
import { change, click, go } from '../test/recipe-editor-fixtures';
import { logFoodView } from './log-food';
import { dashboardView } from './dashboard';

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/log', logFoodView);
  route('/', dashboardView);
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

it('signed-in quick-log sends one authenticated default-serving write while the same Food is pending', async () => {
  setGuestMode(false);
  setToken('quick-log-token');
  const first = deferred<Response>();
  const saved = food('HTTP apple');
  const write = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(Response.json({ meal: { id: 17 } }));
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => {
    if (url === '/api/meals') return write(url, options);
    if (url === '/api/foods/recent' || url === '/api/foods/custom') return Promise.resolve(Response.json({ foods: [saved] }));
    throw new Error(`Unexpected request: ${url}`);
  });
  const quickLog = () => click('button[aria-label="Quick-log one serving of HTTP apple"]');
  const summary = () => document.querySelector('[role="status"]')!.textContent;
  go('/log?date=2026-04-01&meal=lunch');
  click('[data-tab="recent"]');
  await settle();
  quickLog();
  quickLog();
  click('[data-tab="custom"]');
  await settle();
  quickLog();
  expect(write).toHaveBeenCalledExactlyOnceWith('/api/meals', expect.objectContaining({
    method: 'POST', credentials: 'include',
    headers: expect.objectContaining({ Authorization: 'Bearer quick-log-token' }),
    body: JSON.stringify({ date: '2026-04-01', mealType: 'lunch', foodId: saved.id, servings: 1 }),
  }));
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(true);
  first.resolve(Response.json({ error: 'Unavailable' }, { status: 503 }));
  await settle();
  expect(summary()).toContain('0 entries added');
  expect(summary()).toContain('retry');
  quickLog();
  await settle();
  expect(write).toHaveBeenCalledTimes(2);
  expect(summary()).toContain('1 entry added');
  expect(summary()).toContain('Added HTTP apple');
});

it('Guest meal adds stay mounted and Done waits for all writes before showing the selected date', async () => {
  const date = '2026-04-01';
  state.selectedDate = '2026-04-02';
  const network = vi.fn((url: string) => {
    if (url === '/api/foods/search?q=Guest%20apple') return Promise.resolve(Response.json({ foods: [], external: [] }));
    throw new Error(`Unexpected Guest request: ${url}`);
  });
  vi.stubGlobal('fetch', network);
  await foods.create(food('Guest apple'));
  const { recipe } = await recipes.create({
    name: 'Guest bowl', totalServings: 2, ingredients: [], manualCalories: 200,
  });
  const recipeWrite = deferred<void>();
  const quickWrite = deferred<void>();
  const log = meals.log;
  const quickLog = meals.quickLog;
  vi.spyOn(meals, 'log').mockImplementation(async data => {
    const result = await log(data);
    if (data.recipeId === recipe.id) await recipeWrite.promise;
    return result;
  });
  vi.spyOn(meals, 'quickLog').mockImplementation(async data => {
    const result = await quickLog(data);
    await quickWrite.promise;
    return result;
  });

  const path = `#/log?date=${date}&meal=lunch`;
  go(path.slice(1));
  const session = document.querySelector('.log-page');
  const summary = () => document.querySelector('[role="status"]')!.textContent;
  const submit = (selector: string) => document.querySelector(selector)!.dispatchEvent(new Event('submit', { cancelable: true }));
  change('food-search', 'Guest apple');
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector('#tab-content button[aria-label^="Quick-log"]')).toBeNull();
  click('.food-item');
  change('servings-input', '2');
  click('#add-food-btn');
  await settle();
  expect(summary()).toContain('1 entry added');
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(true);

  click('[data-tab="custom"]');
  await settle();
  click('#create-food-btn');
  change('cf-name', 'Packed orange');
  change('cf-carbs', '14');
  submit('#create-food-form');
  await settle();
  expect(summary()).toContain('1 entry added');
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('Packed orange');
  click('#add-food-btn');
  await settle();
  expect(summary()).toContain('2 entries added');
  expect(document.querySelector('#create-food-btn')).not.toBeNull();
  expect(document.querySelector('#tab-content')!.textContent).toContain('Packed orange');

  click('[data-tab="recipes"]');
  await settle();
  click('button[aria-label="Quick-log one serving of Guest bowl"]');
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(true);
  click('[data-tab="quick"]');
  change('quick-name', 'Milk');
  change('quick-cal', '120');
  submit('#quick-form');
  click('#log-food-done');
  expect(window.location.hash).toBe(path);
  quickWrite.resolve();
  await settle();
  expect(window.location.hash).toBe(path);
  expect(document.querySelector('.log-page')).toBe(session);
  expect(summary()).toContain('3 entries added');
  recipeWrite.resolve();
  await settle();

  expect(window.location.hash).toBe('#/');
  const lunch = document.querySelector('.btn-add-meal[data-meal-type="lunch"]')!;
  expect(lunch.getAttribute('data-date')).toBe(date);
  expect(Array.from(lunch.closest('.meal-section')!.querySelectorAll('.meal-item-name'), item => item.textContent))
    .toEqual(['2x Guest apple', 'Packed orange', 'Guest bowl', 'Milk']);
  const { meals: entries } = await meals.getByDate(date);
  expect(entries.find(entry => entry.recipe_id === recipe.id)).toMatchObject({ servings: 1, calories: 100 });
  expect(network).toHaveBeenCalledExactlyOnceWith('/api/foods/search?q=Guest%20apple', expect.anything());
});

it('replacing Recipe A with B permanently retires A Add without touching B or persisting A', async () => {
  for (const name of ['Recipe A', 'Recipe B']) await recipes.create({
    name, totalServings: 1, ingredients: [], manualCalories: 100,
  });
  go('/log?date=2026-04-01&meal=dinner');
  click('[data-tab="recipes"]');
  await settle();
  const rows = [...document.querySelectorAll<HTMLElement>('.food-item')];
  rows.find(row => row.textContent!.includes('Recipe A'))!.click();
  change('servings-input', '3');
  const oldAdd = document.querySelector<HTMLButtonElement>('#add-food-btn')!;
  rows.find(row => row.textContent!.includes('Recipe B'))!.click();
  const modal = document.querySelector('#food-detail-modal')!;
  const currentAdd = modal.querySelector<HTMLButtonElement>('#add-food-btn')!;
  modal.append(oldAdd);
  const before = modal.outerHTML;
  oldAdd.click();
  expect(modal.outerHTML).toBe(before);
  expect(currentAdd.disabled).toBe(false);
  expect((await meals.getByDate('2026-04-01')).meals).toHaveLength(0);
});

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

it.each((['food', 'recipe', 'quick'] as const).flatMap(kind =>
  (['route', 'raw ancestor'] as const).map(departure => ({ kind, departure }))))(
  'guest $kind logging preserves captured values when its write settles after $departure departure', async ({ kind, departure }) => {
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
  if (departure === 'route') go('/log?date=2026-05-02&meal=breakfast');
  else {
    const ancestor = document.querySelector('#app')!;
    ancestor.remove();
    document.body.append(ancestor);
  }
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  wait.resolve();
  await settle();
  expect(delayed).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(window.location.hash).toBe(departure === 'route'
    ? '#/log?date=2026-05-02&meal=breakfast' : '#/log?date=2026-04-01&meal=dinner');
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

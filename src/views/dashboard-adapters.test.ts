import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, workoutDays, setToken } from '../api';
import { seedSampleData, setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { state, todayStr } from '../state';
import { dashboardView } from './dashboard';
import { deferred } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';

async function showFoodMeal() {
  const { food } = await foods.create({ name: 'Apple', serving_size: 100, serving_unit: 'g', calories: 100, protein_g: 5 });
  await meals.log({ date: '2026-04-01', mealType: 'breakfast', foodId: food.id, servings: 2 });
  go('/');
  await ready(1);
  return document.querySelector<HTMLElement>('.meal-item')!;
}

function tap(item: HTMLElement) {
  item.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 10 }));
}

async function openFoodMeal() {
  tap(await showFoodMeal());
  return document.querySelector<HTMLElement>('#app .dashboard-page')!;
}

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function click(id: string) {
  document.querySelector<HTMLButtonElement>(`#${id}`)!.click();
}

async function ready(count: number) {
  await vi.waitFor(() => expect(document.querySelectorAll('.meal-item')).toHaveLength(count));
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/', dashboardView);
  route('/other', () => ({ html: '<p>Other</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  state.user = null;
  state.selectedDate = '2026-04-01';
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['root', 'fixed replacement'])('Dashboard permanently retires on same-turn %s before router cleanup', async departure => {
  const root = await openFoodMeal();
  const saved = await meals.getByDate('2026-04-01');
  departAndReconnect(root, departure, '#workout-toggle');
  const before = root.innerHTML;
  click('edit-serv-plus');
  click('edit-save-btn');
  click('edit-delete-btn');
  click('edit-modal-close');
  click('date-label');
  click('date-prev');
  click('copy-prev-btn');
  await Promise.resolve();
  expect(root.innerHTML).toBe(before);
  expect(state.selectedDate).toBe('2026-04-01');
  expect(document.querySelector('body > input[type="date"]')).toBeNull();
  expect(await meals.getByDate('2026-04-01')).toEqual(saved);
  expect(window.confirm).not.toHaveBeenCalled();
});

it.each(['edit-serv-minus', 'edit-serv-plus', 'edit-modal-close', 'date-label'])(
  '%s checks retirement before its first view effect', async action => {
    const root = await openFoodMeal();
    const quantity = root.querySelector<HTMLInputElement>('#edit-servings')!;
    departAndReconnect(root, 'root');
    const before = root.innerHTML;
    click(action);
    expect(quantity.value).toBe('2');
    expect(root.innerHTML).toBe(before);
    expect(document.querySelector('body > input[type="date"]')).toBeNull();
  },
);

it.each(['movement', 'cancellation'])('Dashboard rejects gesture %s after same-turn ancestor departure', async action => {
  const item = await showFoodMeal();
  item.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, clientY: 10 }));
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  departAndReconnect(root, 'ancestor');
  const before = item.getAttribute('style');
  if (action === 'movement') document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 10 }));
  else item.dispatchEvent(new Event('touchcancel'));
  document.dispatchEvent(new MouseEvent('mouseup'));
  expect(item.getAttribute('style')).toBe(before);
  expect((await meals.getByDate('2026-04-01')).meals).toHaveLength(1);
});

it('guest copy persists before ancestor retirement and its completion precedes observer delivery', async () => {
  await meals.quickLog({ date: '2026-03-31', mealType: 'lunch', name: 'Copy source', calories: 300 });
  const root = await openFoodMeal();
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    write.call(this, key, value);
    // Schedule departure before the accepted write queues its continuation.
    if (key === 'guest_meals') queueMicrotask(() => departAndReconnect(root, 'ancestor'));
  });
  click('copy-prev-btn');
  const before = root.innerHTML;
  await Promise.resolve();
  await Promise.resolve();
  expect(root.innerHTML).toBe(before);
  expect((await meals.getByDate('2026-04-01')).meals).toHaveLength(2);
  go('/');
  await ready(2);
  click('date-prev');
  expect(state.selectedDate).toBe('2026-03-31');
});

it('a late HTTP copy failure stays silent after observer retirement', async () => {
  setGuestMode(false);
  const pending = deferred<Response>();
  const network = vi.fn((url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return pending.promise;
    return Promise.resolve(Response.json(url.includes('/workout-days/') ? { isWorkoutDay: false }
      : url.includes('/daily-checks/') ? { checks: [] } : { meals: [] }));
  });
  vi.stubGlobal('fetch', network);
  go('/');
  await vi.waitFor(() => expect(document.querySelectorAll('.meal-section')).toHaveLength(4));
  click('copy-prev-btn');
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  const before = root.innerHTML;
  departAndReconnect(root, 'ancestor');
  await Promise.resolve();
  const requests = network.mock.calls.length;
  pending.reject(new Error('Late copy failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(root.innerHTML).toBe(before);
  expect(network).toHaveBeenCalledTimes(requests);
  expect(network).toHaveBeenCalledWith('/api/meals/copy', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ fromDate: '2026-03-31', toDate: '2026-04-01' }),
  }));
});

it.each(['missing', 'replacement'])('Dashboard retirement leaves a %s modal and its successor alone', async mode => {
  await openFoodMeal();
  const modal = document.querySelector<HTMLElement>('#edit-meal-modal')!;
  const close = document.querySelector<HTMLButtonElement>('#edit-modal-close')!;
  const replacement = modal.cloneNode(true) as HTMLElement;
  replacement.querySelector('#edit-meal-body')!.textContent = 'Successor content';
  if (mode === 'missing') modal.remove();
  else modal.replaceWith(replacement);
  const oldHTML = modal.innerHTML;
  const newHTML = replacement.innerHTML;
  close.click();
  click('date-prev');
  await Promise.resolve();
  expect(modal.innerHTML).toBe(oldHTML);
  expect(replacement.innerHTML).toBe(newHTML);
  expect(state.selectedDate).toBe('2026-04-01');
});

it('temporary picker removal and modal rendering leave Dashboard live', async () => {
  await openFoodMeal();
  click('edit-serv-plus');
  expect(document.querySelector<HTMLInputElement>('#edit-servings')!.value).toBe('3');
  click('edit-modal-close');
  tap(document.querySelector<HTMLElement>('.meal-item')!);
  expect(document.querySelector<HTMLInputElement>('#edit-servings')!.value).toBe('2');
  click('date-label');
  document.querySelector('body > input[type="date"]')!.remove();
  await Promise.resolve();
  click('date-label');
  const picker = document.querySelector<HTMLInputElement>('body > input[type="date"]')!;
  picker.value = '2026-03-30';
  picker.dispatchEvent(new Event('change'));
  expect(state.selectedDate).toBe('2026-03-30');
  expect(document.querySelector('#edit-meal-body')!.children).toHaveLength(0);
});

it('ancestor retirement releases swipe timers, frames and the temporary picker', async () => {
  const item = await showFoodMeal();
  click('date-label');
  const picker = document.querySelector<HTMLInputElement>('body > input[type="date"]')!;
  vi.useFakeTimers();
  item.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup'));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  departAndReconnect(root, 'ancestor');
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  expect(picker.isConnected).toBe(false);
  picker.value = '2025-01-01';
  picker.dispatchEvent(new Event('change'));
  expect(state.selectedDate).toBe('2026-04-01');
});

it('guest Dashboard selects, copies, edits and deletes through the local adapters', async () => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  await meals.quickLog({ date: '2026-03-31', mealType: 'lunch', name: 'Guest lunch', calories: 321.4, proteinG: 30.2 });
  await workoutDays.set('2026-03-31', true);
  go('/');
  click('date-prev');
  await ready(1);
  expect(document.querySelector('.meal-item-name')!.textContent).toBe('Guest lunch');
  expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(true);
  click('date-next');
  await ready(0);
  click('copy-prev-btn');
  await ready(1);
  expect(document.querySelector('#cal-value')!.textContent).toBe('321');
  const item = document.querySelector('.meal-item')!;
  item.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 10, clientY: 10 }));
  document.querySelector<HTMLInputElement>('#edit-protein')!.value = '42.3';
  click('edit-save-btn');
  await vi.waitFor(() => expect(document.querySelector('#protein-value')!.textContent).toBe('42 / 150g'));
  expect((await meals.getByDate('2026-04-01')).meals[0].protein_g).toBe(42.3);
  const saved = document.querySelector('.meal-item')!;
  saved.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 10, clientY: 10 }));
  click('edit-delete-btn');
  await ready(0);
  expect((await meals.getByDate('2026-03-31')).meals).toHaveLength(1);
  expect(network).not.toHaveBeenCalled();
});

it('sample dismissal refreshes this session and supersedes its pending meal read', async () => {
  state.selectedDate = todayStr();
  seedSampleData();
  await meals.quickLog({ date: state.selectedDate, mealType: 'lunch', name: 'Personal lunch', calories: 500 });
  const old = await meals.getByDate(state.selectedDate);
  let finish!: (value: typeof old) => void;
  vi.spyOn(meals, 'getByDate').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  go('/');
  click('sample-dismiss-btn');
  await ready(1);
  finish(old);
  await Promise.resolve();
  expect(document.querySelector('#sample-banner')).toBeNull();
  expect(document.querySelectorAll('.meal-item')).toHaveLength(1);
  expect(document.querySelector('.meal-item-name')!.textContent).toBe('Personal lunch');
  expect(document.querySelector('#cal-value')!.textContent).toBe('500');
});

it('signed-in Dashboard uses dated HTTP reads and captures workout and copy writes', async () => {
  setGuestMode(false);
  setToken('test-token');
  const requests: { path: string; method: string; body: unknown }[] = [];
  const network = vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.replace('/api', '');
    const method = options?.method ?? 'GET';
    requests.push({ path, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (path.startsWith('/workout-days/')) return Response.json({ isWorkoutDay: path.endsWith('03-31') });
    if (path.startsWith('/daily-checks/')) return Response.json({ checks: [] });
    if (path === '/meals/copy') return Response.json({ copied: 2 });
    return Response.json({ meals: [] });
  });
  vi.stubGlobal('fetch', network);
  go('/');
  await vi.waitFor(() => expect(document.querySelector('[data-check-key]')!.hasAttribute('disabled')).toBe(false));
  click('workout-toggle');
  click('date-prev');
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(true));
  click('copy-prev-btn');
  await vi.waitFor(() => expect(document.querySelector('#copy-prev-btn')!.textContent).toBe('Copied 2 items!'));
  expect(requests).toContainEqual({ path: '/meals/2026-04-01', method: 'GET', body: null });
  expect(requests).toContainEqual({ path: '/meals/2026-03-31', method: 'GET', body: null });
  expect(requests).toContainEqual({ path: '/daily-checks/2026-03-31', method: 'GET', body: null });
  expect(requests).toContainEqual({ path: '/workout-days/2026-04-01', method: 'PUT', body: { isWorkoutDay: true } });
  expect(requests).toContainEqual({ path: '/meals/copy', method: 'POST', body: { fromDate: '2026-03-30', toDate: '2026-03-31' } });
  expect(network.mock.calls.every(([, options]) => options?.credentials === 'include'
    && new Headers(options.headers).get('Authorization') === 'Bearer test-token')).toBe(true);
});

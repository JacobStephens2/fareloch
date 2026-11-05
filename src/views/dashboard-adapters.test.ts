import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { meals, workoutDays, setToken } from '../api';
import { seedSampleData, setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { state, todayStr } from '../state';
import { dashboardView } from './dashboard';

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

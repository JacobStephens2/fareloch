import { Chart } from 'chart.js';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { auth, setToken, weight } from '../api';
import { getGuestUser, localAuth, localWeight, setGuestMode } from '../local-db';
import { deferred } from '../test/food-search-fixtures';
import { go, input, reading, ResizeObserverStub, startWeightRoutes, submit, submitReading } from '../test/weight-fixtures';

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeAll(startWeightRoutes);

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  go('/other');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('guest Weight persists captured readings, saves and disables the ceiling, and deletes through its controls', async () => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go('/weight');
  await settle();
  submitReading();
  await settle();
  expect((await weight.list()).logs).toEqual([{
    id: 1, date: '2026-11-03', time: '18:45', weight_lbs: 180, waist_inches: 31.2, notes: null,
  }]);
  expect(document.querySelector('.weight-entry')!.textContent).toContain('180 lbs');
  input('waist-ceiling', '31.25');
  submit('waist-ceiling-form');
  await settle();
  expect((await auth.me()).user.targetWaistInches).toBe(31.25);
  expect(document.querySelector('#waist-summary')!.textContent).toContain('At or below ceiling (31.25")');
  input('waist-ceiling', '');
  submit('waist-ceiling-form');
  await settle();
  expect((await auth.me()).user.targetWaistInches).toBeNull();
  expect(document.querySelector('#waist-ceiling-message')!.textContent).toBe('Ceiling disabled.');
  document.querySelector<HTMLButtonElement>('.btn-delete-weight')!.click();
  await settle();
  expect((await weight.list()).logs).toEqual([]);
  expect(document.querySelector('#weight-trend-value')!.textContent).toBe('No logs yet');
  expect(network).not.toHaveBeenCalled();
});

type Operation = 'log' | 'ceiling' | 'delete';

function begin(operation: Operation) {
  if (operation === 'log') submitReading();
  else if (operation === 'ceiling') {
    input('waist-ceiling', '31.25');
    submit('waist-ceiling-form');
  } else document.querySelector<HTMLButtonElement>('.btn-delete-weight')!.click();
}

it.each(['log', 'ceiling', 'delete'] as const)('guest %s remains persisted when result delivery outlives its mount', async operation => {
  await weight.log({ date: '2026-11-04', weightLbs: 165 });
  go('/weight');
  await settle();
  const delivery = deferred<void>();
  const log = localWeight.log;
  const save = localAuth.updateProfile;
  const remove = localWeight.delete;
  if (operation === 'log') vi.spyOn(localWeight, 'log').mockImplementationOnce(async data => {
    const result = await log(data);
    await delivery.promise;
    return result;
  });
  else if (operation === 'ceiling') vi.spyOn(localAuth, 'updateProfile').mockImplementationOnce(async data => {
    const result = await save(data);
    await delivery.promise;
    return result;
  });
  else vi.spyOn(localWeight, 'delete').mockImplementationOnce(async id => {
    const result = await remove(id);
    await delivery.promise;
    return result;
  });
  begin(operation);
  await settle();
  const root = document.querySelector('.page')!;
  go('/weight');
  await settle();
  if (operation === 'log') {
    expect((await weight.list()).logs).toContainEqual({
      id: 2, date: '2026-11-03', time: '18:45', weight_lbs: 180, waist_inches: 31.2, notes: null,
    });
    expect(document.querySelectorAll('.weight-entry')).toHaveLength(2);
  } else if (operation === 'ceiling') expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('31.25');
  else expect((await weight.list()).logs).toEqual([]);
  input('weight-lbs', '181');
  input('waist-ceiling', '33');
  const oldHTML = root.innerHTML;
  const html = document.querySelector('#app')!.innerHTML;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const chart = Chart.getChart(canvas);
  delivery.resolve();
  await settle();
  expect(root.innerHTML).toBe(oldHTML);
  expect(document.querySelector('#app')!.innerHTML).toBe(html);
  expect(document.querySelector<HTMLInputElement>('#weight-lbs')!.value).toBe('181');
  expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('33');
  expect(Chart.getChart(canvas)).toBe(chart);
  expect(window.alert).not.toHaveBeenCalled();
});

const httpCases = (['log', 'ceiling', 'delete'] as const).flatMap(operation =>
  (['success', 'failure'] as const).map(outcome => ({ operation, outcome })));

it.each(httpCases)('signed-in $operation preserves its HTTP inputs and consumes late $outcome', async ({ operation, outcome }) => {
  setGuestMode(false);
  setToken('weight-test-token');
  const delivery = deferred<Response>();
  const requests: { path: string; method: string; body: unknown }[] = [];
  let logs = [reading()];
  let targetWaistInches: number | null = null;
  const network = vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.replace('/api', '');
    const method = options?.method ?? 'GET';
    requests.push({ path, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (method !== 'GET') {
      // The request has reached the adapter before its response is delivered.
      if (outcome === 'success') {
        if (operation === 'log') logs = [reading(180)];
        else if (operation === 'ceiling') targetWaistInches = 31.25;
        else logs = [];
      }
      return delivery.promise;
    }
    if (path === '/weight?limit=90') return Response.json({ logs });
    if (path === '/auth/me') return Response.json({ user: { ...getGuestUser(), targetWaistInches } });
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', network);
  go('/weight');
  await settle();
  begin(operation);
  const expected = operation === 'log'
    ? { path: '/weight', method: 'POST', body: { date: '2026-11-03', time: '18:45', weightLbs: 180, waistInches: 31.2 } }
    : operation === 'ceiling'
      ? { path: '/auth/me', method: 'PUT', body: { targetWaistInches: 31.25 } }
      : { path: '/weight/7', method: 'DELETE', body: null };
  expect(requests).toContainEqual(expected);
  const root = document.querySelector('.page')!;
  go('/weight');
  await settle();
  input('weight-lbs', '181');
  input('waist-ceiling', '33');
  const oldHTML = root.innerHTML;
  const html = document.querySelector('#app')!.innerHTML;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const chart = Chart.getChart(canvas);
  const captured = [...requests];
  if (outcome === 'success') delivery.resolve(Response.json({ log: reading(180), user: getGuestUser(), success: true }));
  else delivery.resolve(Response.json({ error: 'Write failed' }, { status: 500 }));
  await settle();
  expect(root.innerHTML).toBe(oldHTML);
  expect(document.querySelector('#app')!.innerHTML).toBe(html);
  expect(document.querySelector<HTMLInputElement>('#weight-lbs')!.value).toBe('181');
  expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('33');
  expect(Chart.getChart(canvas)).toBe(chart);
  expect(requests).toEqual(captured);
  expect(network.mock.calls.every(([, options]) => options?.credentials === 'include'
    && new Headers(options.headers).get('Authorization') === 'Bearer weight-test-token')).toBe(true);
  expect(window.alert).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('#/weight');
});

const httpReadCases = (['/weight?limit=90', '/auth/me'] as const).flatMap(path =>
  (['success', 'failure'] as const).map(outcome => ({ path, outcome })));

it.each(httpReadCases)('signed-in late $path $outcome cannot replace the remounted snapshot', async ({ path, outcome }) => {
  setGuestMode(false);
  setToken('weight-read-token');
  const delivery = deferred<Response>();
  let delayed = false;
  const network = vi.fn(async (url: string) => {
    const requested = url.replace('/api', '');
    if (requested === path && !delayed) {
      delayed = true;
      return delivery.promise;
    }
    if (requested === '/weight?limit=90') return Response.json({ logs: [reading(180)] });
    if (requested === '/auth/me') return Response.json({ user: { ...getGuestUser(), targetWaistInches: 32 } });
    throw new Error(`Unexpected read: ${requested}`);
  });
  vi.stubGlobal('fetch', network);
  go('/weight');
  await settle();
  const root = document.querySelector('.page')!;
  go('/weight');
  await settle();
  expect(document.querySelector('#weight-trend-value')!.textContent).toBe('180.0 lbs');
  input('waist-ceiling', '33');
  const oldHTML = root.innerHTML;
  const html = document.querySelector('#app')!.innerHTML;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const chart = Chart.getChart(canvas);
  if (outcome === 'failure') delivery.reject(new Error('Late network failure'));
  else delivery.resolve(Response.json(path === '/auth/me'
    ? { user: { ...getGuestUser(), targetWaistInches: 40 } }
    : { logs: [] }));
  await settle();
  expect(root.innerHTML).toBe(oldHTML);
  expect(document.querySelector('#app')!.innerHTML).toBe(html);
  expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('33');
  expect(Chart.getChart(canvas)).toBe(chart);
  expect(window.alert).not.toHaveBeenCalled();
});

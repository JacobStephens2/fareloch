import { Chart } from 'chart.js';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { auth, setToken, weight } from '../api';
import { getGuestUser, localAuth, localWeight, setGuestMode } from '../local-db';
import { deferred } from '../test/food-search-fixtures';
import { beginWeightOperation, go, input, reading, ResizeObserverStub, startWeightRoutes, submit, submitReading } from '../test/weight-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { mountWeight } from './weight-session';
import { weightView } from './weight';

const settle = () => vi.advanceTimersByTimeAsync(0);

function presentation(root: Element) {
  const copy = document.createElement('div');
  copy.innerHTML = root.innerHTML;
  // Chart.destroy restores its canvas attributes as part of resource release.
  copy.querySelector('canvas')?.replaceWith(document.createElement('canvas'));
  return copy.innerHTML;
}

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
  document.querySelector('#retained')?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['root', 'fixed replacement'])('Weight permanently retires on same-turn %s before router cleanup', async departure => {
  await weight.log({ date: '2026-11-04', weightLbs: 165 });
  go('/weight');
  await settle();
  const root = document.querySelector<HTMLElement>('#app .page')!;
  const chart = Chart.getChart(root.querySelector<HTMLCanvasElement>('canvas')!)!;
  const destroy = vi.spyOn(chart, 'destroy');
  input('weight-lbs', '180');
  input('waist-ceiling', '32');
  const logs = await weight.list();
  departAndReconnect(root, departure, '#weight-lbs');
  const before = presentation(root);
  submit('weight-form', root);
  submit('waist-ceiling-form', root);
  root.querySelector<HTMLButtonElement>('.btn-delete-weight')!.click();
  await settle();
  expect(await weight.list()).toEqual(logs);
  expect((await auth.me()).user.targetWaistInches).toBeNull();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(presentation(root)).toBe(before);
  expect(destroy).toHaveBeenCalledTimes(1);
  go('/other');
  expect(destroy).toHaveBeenCalledTimes(1);
});

it('guest Weight persists an accepted log whose continuation precedes ancestor observer delivery', async () => {
  go('/weight');
  await settle();
  const root = document.querySelector<HTMLElement>('#app .page')!;
  submitReading();
  const before = presentation(root);
  // The real guest adapter has persisted and queued its fulfilled continuation.
  departAndReconnect(root, 'ancestor');
  const reads = vi.spyOn(Storage.prototype, 'getItem');
  await settle();
  expect(reads.mock.calls.filter(([key]) => key === 'guest_weight' || key === 'guest_user')).toHaveLength(0);
  expect(presentation(root)).toBe(before);
  expect(root.querySelector<HTMLInputElement>('#weight-lbs')!.value).toBe('180');
  expect(root.querySelector<HTMLButtonElement>('#weight-form button')!.disabled).toBe(true);
  expect((await weight.list()).logs).toEqual([{
    id: 1, date: '2026-11-03', time: '18:45', weight_lbs: 180, waist_inches: 31.2, notes: null,
  }]);
  expect(Chart.getChart(root.querySelector<HTMLCanvasElement>('canvas')!)).toBeUndefined();
  expect(window.alert).not.toHaveBeenCalled();
});

it('Weight consumes a late HTTP log failure after ancestor observer retirement', async () => {
  setGuestMode(false);
  const pending = deferred<Response>();
  const network = vi.fn((url: string, options?: RequestInit) => options?.method === 'POST'
    ? pending.promise : Promise.resolve(Response.json(url.includes('/weight') ? { logs: [reading()] } : { user: getGuestUser() })));
  vi.stubGlobal('fetch', network);
  go('/weight');
  await settle();
  const root = document.querySelector<HTMLElement>('#app .page')!;
  submitReading();
  const before = presentation(root);
  departAndReconnect(root, 'ancestor');
  await Promise.resolve();
  const requests = network.mock.calls.length;
  pending.reject(new Error('Late log failure'));
  await settle();
  expect(presentation(root)).toBe(before);
  expect(root.querySelector<HTMLInputElement>('#weight-lbs')!.value).toBe('180');
  expect(network).toHaveBeenCalledTimes(requests);
  expect(window.alert).not.toHaveBeenCalled();
  expect(Chart.getChart(root.querySelector<HTMLCanvasElement>('canvas')!)).toBeUndefined();
});

it('an initially disconnected Weight mount starts no reads or chart and a fresh mount works', async () => {
  go('/other');
  const holder = document.createElement('div');
  holder.innerHTML = weightView().html;
  const root = holder.querySelector<HTMLElement>('.page')!;
  const reads = vi.spyOn(Storage.prototype, 'getItem');
  const dispose = mountWeight(root);
  document.querySelector('#app')!.append(root);
  input('weight-lbs', '180', root);
  submit('weight-form', root);
  await settle();
  expect(reads.mock.calls.filter(([key]) => key === 'guest_weight' || key === 'guest_user')).toHaveLength(0);
  expect(Chart.getChart(root.querySelector<HTMLCanvasElement>('canvas')!)).toBeUndefined();
  expect((await weight.list()).logs).toEqual([]);
  dispose();
  dispose();
  go('/weight');
  await settle();
  expect(document.querySelector('#app #weight-trend-value')!.textContent).toBe('No logs yet');
  expect(Chart.getChart(document.querySelector<HTMLCanvasElement>('#app canvas')!)).toBeDefined();
});

it('Weight initializes the current outlet while an older screen stays connected before it', async () => {
  await weight.log({ date: '2026-11-04', weightLbs: 165 });
  const retained = document.createElement('div');
  retained.id = 'retained';
  retained.innerHTML = weightView().html;
  document.body.prepend(retained);
  go('/weight');
  await settle();
  const root = document.querySelector<HTMLElement>('#app .page')!;
  expect(Chart.getChart(retained.querySelector<HTMLCanvasElement>('canvas')!)).toBeUndefined();
  expect(retained.querySelector('#weight-trend-value')!.textContent).toBe('Loading...');
  expect(root.querySelector('#weight-trend-value')!.textContent).toBe('165.0 lbs');
  input('weight-lbs', '180', retained);
  submit('weight-form', retained);
  expect((await weight.list()).logs).toHaveLength(1);
  input('weight-lbs', '181', root);
  submit('weight-form', root);
  await settle();
  expect((await weight.list()).logs.map(log => log.weight_lbs)).toEqual([181, 165]);
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  go('/other');
  expect(Chart.getChart(canvas)).toBeUndefined();
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
  beginWeightOperation(operation);
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
  beginWeightOperation(operation);
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

it.each(['persistence', 'result delivery'] as const)('guest delete refreshes its live parent after history replacement with delayed %s', async timing => {
  await weight.log({ date: '2026-11-04', weightLbs: 165 });
  go('/weight');
  await settle();
  const root = document.querySelector('.page')!;
  const retained = root.querySelector<HTMLButtonElement>('.btn-delete-weight')!;
  const delivery = deferred<void>();
  const remove = localWeight.delete;
  vi.spyOn(localWeight, 'delete').mockImplementationOnce(async id => {
    if (timing === 'persistence') await delivery.promise;
    const result = await remove(id);
    if (timing === 'result delivery') await delivery.promise;
    return result;
  });
  retained.click();
  await settle();
  input('waist-ceiling', '32');
  submit('waist-ceiling-form');
  await settle();
  expect(document.querySelector('.page')).toBe(root);
  expect(root.querySelector('.btn-delete-weight')).not.toBe(retained);
  expect(root.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('32');
  // Make the rendered successor stale even when persistence preceded replacement.
  await weight.log({ date: '2026-11-05', weightLbs: 180 });
  const oldChart = Chart.getChart(root.querySelector<HTMLCanvasElement>('canvas')!);
  retained.click();
  expect(window.confirm).toHaveBeenCalledTimes(1);
  delivery.resolve();
  await settle();
  expect(root.querySelectorAll('.weight-entry')).toHaveLength(1);
  expect(root.querySelector('.weight-entry')!.textContent).toContain('180 lbs');
  expect(root.querySelector('#weight-trend-value')!.textContent).toBe('180.0 lbs');
  expect(Chart.getChart(root.querySelector<HTMLCanvasElement>('canvas')!)).not.toBe(oldChart);
  expect((await weight.list()).logs.map(log => log.weight_lbs)).toEqual([180]);
  expect(window.alert).not.toHaveBeenCalled();
});

it.each(['live parent', 'retired parent'] as const)('signed-in delayed delete success after history replacement refreshes only a %s', async owner => {
  setGuestMode(false);
  setToken('weight-delete-token');
  const delivery = deferred<Response>();
  let logs = [reading()];
  let targetWaistInches: number | null = null;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.replace('/api', '');
    const method = options?.method ?? 'GET';
    requests.push(`${method} ${path}`);
    if (method === 'DELETE' && path === '/weight/7') return delivery.promise;
    if (method === 'PUT' && path === '/auth/me') {
      targetWaistInches = 32;
      return Response.json({ user: { ...getGuestUser(), targetWaistInches } });
    }
    if (method === 'GET' && path === '/weight?limit=90') return Response.json({ logs });
    if (method === 'GET' && path === '/auth/me') return Response.json({ user: { ...getGuestUser(), targetWaistInches } });
    throw new Error(`Unexpected request: ${method} ${path}`);
  }));
  go('/weight');
  await settle();
  const root = document.querySelector('.page')!;
  const retained = root.querySelector<HTMLButtonElement>('.btn-delete-weight')!;
  retained.click();
  input('waist-ceiling', '32');
  submit('waist-ceiling-form');
  await settle();
  expect(root.querySelector('.btn-delete-weight')).not.toBe(retained);
  expect(root.querySelector('.weight-entry')!.textContent).toContain('165 lbs');
  if (owner === 'retired parent') {
    go('/weight');
    await settle();
    input('waist-ceiling', '33');
  }
  const before = root.innerHTML;
  const successor = document.querySelector('#app')!.innerHTML;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const chart = Chart.getChart(canvas);
  const reads = requests.length;
  logs = [];
  delivery.resolve(Response.json({ success: true }));
  await settle();
  expect(requests.filter(request => request === 'DELETE /weight/7')).toHaveLength(1);
  if (owner === 'live parent') {
    expect(requests.slice(reads)).toEqual(['GET /weight?limit=90', 'GET /auth/me']);
    expect(root.querySelectorAll('.weight-entry')).toHaveLength(0);
    expect(root.querySelector('#weight-trend-value')!.textContent).toBe('No logs yet');
    expect(Chart.getChart(canvas)).not.toBe(chart);
  } else {
    expect(requests).toHaveLength(reads);
    expect(root.innerHTML).toBe(before);
    expect(document.querySelector('#app')!.innerHTML).toBe(successor);
    expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('33');
    expect(Chart.getChart(canvas)).toBe(chart);
  }
  expect(window.alert).not.toHaveBeenCalled();
});

it.each([false, true])('guest delayed delete stays persisted and silent after same-parent replacement and ancestor retirement (observer delivered: %s)', async delivered => {
  await weight.log({ date: '2026-11-04', weightLbs: 165 });
  go('/weight');
  await settle();
  const delivery = deferred<void>();
  const remove = localWeight.delete;
  vi.spyOn(localWeight, 'delete').mockImplementationOnce(async id => {
    const result = await remove(id);
    await delivery.promise;
    return result;
  });
  const root = document.querySelector('.page')!;
  root.querySelector<HTMLButtonElement>('.btn-delete-weight')!.click();
  await settle();
  submit('waist-ceiling-form');
  await settle();
  expect(root.querySelectorAll('.weight-entry')).toHaveLength(0);
  departAndReconnect(root, 'ancestor');
  if (delivered) await Promise.resolve();
  const before = presentation(root);
  const reads = vi.spyOn(Storage.prototype, 'getItem');
  delivery.resolve();
  await settle();
  expect(reads.mock.calls.filter(([key]) => key === 'guest_weight' || key === 'guest_user')).toHaveLength(0);
  expect(presentation(root)).toBe(before);
  expect(Chart.getChart(root.querySelector<HTMLCanvasElement>('canvas')!)).toBeUndefined();
  expect((await weight.list()).logs).toEqual([]);
  expect(window.alert).not.toHaveBeenCalled();
});

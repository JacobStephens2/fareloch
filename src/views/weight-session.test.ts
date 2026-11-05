import { Chart } from 'chart.js';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { auth, weight } from '../api';
import { getGuestUser } from '../local-db';
import * as router from '../router';
import { deferred } from '../test/food-search-fixtures';
import { go, input, reading, ResizeObserverStub, startWeightRoutes, submit, submitReading } from '../test/weight-fixtures';

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeAll(startWeightRoutes);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.spyOn(weight, 'list').mockResolvedValue({ logs: [reading()] });
  vi.spyOn(auth, 'me').mockResolvedValue({ user: getGuestUser() });
  vi.spyOn(weight, 'log').mockResolvedValue({ log: reading() });
  vi.spyOn(auth, 'updateProfile').mockResolvedValue({ user: getGuestUser() });
  vi.spyOn(weight, 'delete').mockResolvedValue({ success: true });
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

const refreshCases = (['success', 'history rejection', 'profile rejection'] as const).flatMap(older =>
  (['success', 'failure'] as const).map(newer => ({ older, newer })));

it.each(refreshCases)('older $older cannot replace a newer $newer refresh', async ({ older, newer }) => {
  const history = deferred<Awaited<ReturnType<typeof weight.list>>>();
  const profile = deferred<Awaited<ReturnType<typeof auth.me>>>();
  vi.mocked(weight.list).mockReturnValueOnce(history.promise);
  vi.mocked(auth.me).mockReturnValueOnce(profile.promise);
  go('/weight');
  vi.mocked(weight.list).mockResolvedValue({ logs: [reading(180)] });
  vi.mocked(auth.me).mockResolvedValue({ user: { ...getGuestUser(), targetWaistInches: 32 } });
  if (newer === 'failure') vi.mocked(weight.list).mockRejectedValueOnce(new Error('Current load'));
  input('weight-lbs', '180');
  submit('weight-form');
  await settle();
  if (newer === 'success') {
    expect(document.querySelector('#weight-trend-value')!.textContent).toBe('180.0 lbs');
    expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('32');
  } else expect(document.querySelector('#weight-history')!.textContent).toBe('Failed to load weight data');
  const currentHTML = document.querySelector('#app')!.innerHTML;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const chart = Chart.getChart(canvas);
  if (older === 'history rejection') history.reject(new Error('Obsolete history'));
  else history.resolve({ logs: [] });
  if (older === 'profile rejection') profile.reject(new Error('Obsolete profile'));
  else profile.resolve({ user: { ...getGuestUser(), targetWaistInches: 40 } });
  await settle();
  expect(document.querySelector('#app')!.innerHTML).toBe(currentHTML);
  expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe(newer === 'success' ? '32' : '');
  expect(Chart.getChart(canvas)).toBe(chart);
  expect(weight.list).toHaveBeenCalledWith(90);
});

afterEach(() => {
  go('/other');
  Object.values(Chart.instances).forEach(chart => chart.destroy());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['/other', '/missing', '/weight'])('releases its chart synchronously before entering %s and mounts again', async destination => {
  go('/weight');
  await settle();
  const canvas = document.querySelector<HTMLCanvasElement>('#weight-chart')!;
  expect(Chart.getChart(canvas)).toBeDefined();
  go(destination);
  expect(Chart.getChart(canvas)).toBeUndefined();
  await settle();
  go('/weight');
  await settle();
  expect(document.querySelector('#weight-trend-value')!.textContent).toBe('165.0 lbs');
  expect(Chart.getChart(document.querySelector<HTMLCanvasElement>('#weight-chart')!)).toBeDefined();
});

const readCases = (['history', 'profile'] as const).flatMap(source =>
  (['success', 'failure'] as const).flatMap(outcome =>
    ['/other', '/missing', '/weight'].map(destination => ({ source, outcome, destination }))));

it.each(readCases)('a departed $source $outcome stays silent across $destination and remount', async ({ source, outcome, destination }) => {
  const history = deferred<Awaited<ReturnType<typeof weight.list>>>();
  const profile = deferred<Awaited<ReturnType<typeof auth.me>>>();
  vi.mocked(weight.list).mockReturnValueOnce(history.promise);
  vi.mocked(auth.me).mockReturnValueOnce(profile.promise);
  go('/weight');
  const oldRoot = document.querySelector('.page')!;
  const oldCanvas = oldRoot.querySelector<HTMLCanvasElement>('canvas')!;
  if (source === 'history') profile.resolve({ user: getGuestUser() });
  else history.resolve({ logs: [] });
  await settle();
  expect(Chart.getChart(oldCanvas)).toBeUndefined();
  go(destination);
  if (destination !== '/weight') go('/weight');
  await settle();
  const oldHTML = oldRoot.innerHTML;
  const currentHTML = document.querySelector('#app')!.innerHTML;
  const currentCanvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const currentChart = Chart.getChart(currentCanvas);
  if (source === 'history') {
    if (outcome === 'success') history.resolve({ logs: [] });
    else history.reject(new Error('Departed history'));
  } else {
    if (outcome === 'success') profile.resolve({ user: { ...getGuestUser(), targetWaistInches: 40 } });
    else profile.reject(new Error('Departed profile'));
  }
  await settle();
  expect(oldRoot.innerHTML).toBe(oldHTML);
  expect(document.querySelector('#app')!.innerHTML).toBe(currentHTML);
  expect(Chart.getChart(oldCanvas)).toBeUndefined();
  expect(Chart.getChart(currentCanvas)).toBe(currentChart);
});

type Operation = 'log' | 'ceiling' | 'delete';

function begin(operation: Operation) {
  if (operation === 'log') {
    submitReading();
    expect(weight.log).toHaveBeenCalledWith({ date: '2026-11-03', time: '18:45', weightLbs: 180, waistInches: 31.2 });
  } else if (operation === 'ceiling') {
    input('waist-ceiling', '31.25');
    submit('waist-ceiling-form');
    expect(auth.updateProfile).toHaveBeenCalledWith({ targetWaistInches: 31.25 });
  } else {
    document.querySelector<HTMLButtonElement>('.btn-delete-weight')!.click();
    expect(weight.delete).toHaveBeenCalledWith(7);
  }
}

function delayOperation(operation: Operation) {
  const pending = deferred<{ log: ReturnType<typeof reading>; user: ReturnType<typeof getGuestUser>; success: boolean }>();
  if (operation === 'log') vi.mocked(weight.log).mockReturnValueOnce(pending.promise);
  else if (operation === 'ceiling') vi.mocked(auth.updateProfile).mockReturnValueOnce(pending.promise);
  else vi.mocked(weight.delete).mockReturnValueOnce(pending.promise);
  return pending;
}

const writeCases = (['log', 'ceiling', 'delete'] as const).flatMap(operation =>
  (['success', 'failure'] as const).flatMap(outcome =>
    ['/other', '/missing', '/weight'].map(destination => ({ operation, outcome, destination }))));

it.each(writeCases)('$operation $outcome cannot publish across $destination and remount', async ({ operation, outcome, destination }) => {
  go('/weight');
  await settle();
  const pending = delayOperation(operation);
  begin(operation);
  const oldRoot = document.querySelector('.page')!;
  go(destination);
  if (destination !== '/weight') go('/weight');
  await settle();
  input('weight-lbs', '181');
  input('weight-waist', '32.1');
  input('waist-ceiling', '33.25');
  const oldHTML = oldRoot.innerHTML;
  const currentHTML = document.querySelector('#app')!.innerHTML;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const chart = Chart.getChart(canvas);
  // Any obsolete refresh would change the successor or the detached root.
  vi.mocked(weight.list).mockResolvedValue({ logs: [reading(199)] });
  vi.mocked(weight.list).mockClear();
  vi.mocked(auth.me).mockClear();
  if (outcome === 'success') pending.resolve({ log: reading(), user: getGuestUser(), success: true });
  else pending.reject(new Error('Departed write'));
  await settle();
  expect(oldRoot.innerHTML).toBe(oldHTML);
  expect(oldRoot.querySelector<HTMLInputElement>('#weight-lbs')!.value).toBe(operation === 'log' ? '180' : '');
  expect(document.querySelector('#app')!.innerHTML).toBe(currentHTML);
  expect(document.querySelector<HTMLInputElement>('#weight-lbs')!.value).toBe('181');
  expect(document.querySelector<HTMLInputElement>('#weight-waist')!.value).toBe('32.1');
  expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('33.25');
  expect(Chart.getChart(canvas)).toBe(chart);
  expect(window.alert).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('#/weight');
  expect(weight.list).not.toHaveBeenCalled();
  expect(auth.me).not.toHaveBeenCalled();
});

it.each(['route departure', 'disconnected root', 'history refresh'] as const)('retained controls cannot issue operations after %s', async departure => {
  go('/weight');
  await settle();
  const root = document.querySelector('.page')!;
  const oldDelete = root.querySelector<HTMLButtonElement>('.btn-delete-weight')!;
  input('weight-lbs', '180');
  input('waist-ceiling', '32');
  if (departure === 'route departure') go('/other');
  else if (departure === 'disconnected root') root.remove();
  else {
    submit('waist-ceiling-form');
    await settle();
  }
  vi.mocked(weight.log).mockClear();
  vi.mocked(auth.updateProfile).mockClear();
  vi.mocked(weight.delete).mockClear();
  vi.mocked(window.confirm).mockClear();
  const html = root.innerHTML;
  if (departure !== 'history refresh') {
    submit('weight-form', root);
    submit('waist-ceiling-form', root);
  }
  oldDelete.click();
  await settle();
  expect(weight.log).not.toHaveBeenCalled();
  expect(auth.updateProfile).not.toHaveBeenCalled();
  expect(weight.delete).not.toHaveBeenCalled();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(root.innerHTML).toBe(html);
});

it('disposes before the next view initializes and repeated cleanup leaves the successor chart alone', async () => {
  const registerCleanup = router.setCleanup;
  let cleanup: (() => void) | undefined;
  vi.spyOn(router, 'setCleanup').mockImplementation(fn => {
    cleanup = fn;
    registerCleanup(fn);
  });
  go('/weight');
  await settle();
  const firstCleanup = cleanup!;
  const oldCanvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  let initialized = false;
  router.route('/inspect-chart-release', () => ({ html: '<p>Next view</p>', init() {
    initialized = true;
    expect(Chart.getChart(oldCanvas)).toBeUndefined();
  } }));
  go('/inspect-chart-release');
  expect(initialized).toBe(true);
  go('/weight');
  await settle();
  const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const chart = Chart.getChart(canvas);
  firstCleanup();
  firstCleanup();
  expect(Chart.getChart(canvas)).toBe(chart);
  input('weight-lbs', '180');
  vi.mocked(weight.list).mockResolvedValue({ logs: [reading(180)] });
  submit('weight-form');
  await settle();
  expect(document.querySelector('#weight-trend-value')!.textContent).toBe('180.0 lbs');
});

it.each(['log', 'ceiling', 'delete'] as const)('%s preserves live failure, retry and success feedback', async operation => {
  go('/weight');
  await settle();
  const pending = delayOperation(operation);
  begin(operation);
  pending.reject(new Error('Current write failed'));
  await settle();
  if (operation === 'log') {
    expect(window.alert).toHaveBeenCalledWith('Failed to log weight');
    expect(document.querySelector<HTMLInputElement>('#weight-lbs')!.value).toBe('180');
    expect(document.querySelector<HTMLInputElement>('#weight-waist')!.value).toBe('31.2');
  } else if (operation === 'ceiling') {
    expect(document.querySelector('#waist-ceiling-message')!.textContent).toBe('Failed to save waist ceiling.');
    expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('31.25');
    expect(window.alert).not.toHaveBeenCalled();
  } else {
    expect(document.querySelectorAll('.weight-entry')).toHaveLength(1);
    expect(window.alert).not.toHaveBeenCalled();
  }
  expect(document.querySelector<HTMLButtonElement>('#weight-form button')!.disabled).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('#waist-ceiling-form button')!.disabled).toBe(false);
  vi.mocked(weight.list).mockResolvedValue({ logs: operation === 'delete' ? [] : [reading(180)] });
  vi.mocked(auth.me).mockResolvedValue({ user: { ...getGuestUser(), targetWaistInches: 31.25 } });
  begin(operation);
  await settle();
  if (operation === 'ceiling') expect(document.querySelector('#waist-ceiling-message')!.textContent).toBe('Ceiling saved.');
  else if (operation === 'log') {
    expect(document.querySelector<HTMLInputElement>('#weight-lbs')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#weight-waist')!.value).toBe('');
  }
  expect(document.querySelector('#weight-trend-value')!.textContent).toBe(operation === 'delete' ? 'No logs yet' : '180.0 lbs');
  expect(document.querySelector<HTMLButtonElement>('#weight-form button')!.disabled).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('#waist-ceiling-form button')!.disabled).toBe(false);
});

it.each(['log', 'ceiling', 'delete'] as const)('%s cannot publish after departure during its follow-up refresh', async operation => {
  go('/weight');
  await settle();
  const history = deferred<Awaited<ReturnType<typeof weight.list>>>();
  const profile = deferred<Awaited<ReturnType<typeof auth.me>>>();
  vi.mocked(weight.list).mockReturnValueOnce(history.promise);
  vi.mocked(auth.me).mockReturnValueOnce(profile.promise);
  begin(operation);
  await settle();
  const root = document.querySelector('.page')!;
  go('/weight');
  await settle();
  const oldHTML = root.innerHTML;
  const html = document.querySelector('#app')!.innerHTML;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
  const chart = Chart.getChart(canvas);
  history.resolve({ logs: [] });
  profile.reject(new Error('Departed follow-up load'));
  await settle();
  expect(root.innerHTML).toBe(oldHTML);
  expect(document.querySelector('#app')!.innerHTML).toBe(html);
  expect(Chart.getChart(canvas)).toBe(chart);
  expect(window.alert).not.toHaveBeenCalled();
});

it('publishes no part of a superseded or incomplete combined snapshot', async () => {
  const oldHistory = deferred<Awaited<ReturnType<typeof weight.list>>>();
  const oldProfile = deferred<Awaited<ReturnType<typeof auth.me>>>();
  const newHistory = deferred<Awaited<ReturnType<typeof weight.list>>>();
  const newProfile = deferred<Awaited<ReturnType<typeof auth.me>>>();
  vi.mocked(weight.list).mockReturnValueOnce(oldHistory.promise).mockReturnValueOnce(newHistory.promise);
  vi.mocked(auth.me).mockReturnValueOnce(oldProfile.promise).mockReturnValueOnce(newProfile.promise);
  go('/weight');
  input('weight-lbs', '180');
  submit('weight-form');
  await settle();
  oldHistory.resolve({ logs: [] });
  oldProfile.resolve({ user: { ...getGuestUser(), targetWaistInches: 40 } });
  newHistory.resolve({ logs: [reading(180)] });
  await settle();
  expect(document.querySelector('#weight-trend-value')!.textContent).toBe('Loading...');
  expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('');
  expect(document.querySelector('#weight-history .loading-spinner')).not.toBeNull();
  expect(Chart.getChart(document.querySelector<HTMLCanvasElement>('canvas')!)).toBeUndefined();
  newProfile.resolve({ user: { ...getGuestUser(), targetWaistInches: 32 } });
  await settle();
  expect(document.querySelector('#weight-trend-value')!.textContent).toBe('180.0 lbs');
  expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('32');
  expect(document.querySelector('#waist-summary')!.textContent).toContain('At or below ceiling (32")');
});

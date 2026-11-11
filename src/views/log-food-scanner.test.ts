import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferred, food } from '../test/food-search-fixtures';
import { click, go } from '../test/recipe-editor-fixtures';
import { scannerAdapter } from '../test/barcode-scanner-fixtures';

let adapter: ReturnType<typeof scannerAdapter>;
const barcode = vi.fn();
let listeners: ReturnType<typeof listenForRoutes>;
function listenForRoutes() { return vi.spyOn(window, 'addEventListener'); }

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  adapter = scannerAdapter();
  barcode.mockReset().mockResolvedValue({ food: food('Scanned apple') });
  vi.doMock('../api', () => ({
    foods: { recent: vi.fn().mockResolvedValue({ foods: [] }), barcode },
    meals: {}, recipes: {},
  }));
  vi.doMock('html5-qrcode', async () => ({ Html5Qrcode: await adapter.loadScanner() }));
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  listeners = listenForRoutes();
  const { route, startRouter } = await import('../router');
  const { logFoodView } = await import('./log-food');
  route('/log', logFoodView);
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
  startRouter();
  go('/log');
  await settle();
});

afterEach(async () => {
  go('/other');
  await settle();
  for (const [type, listener] of listeners.mock.calls) {
    if (type === 'hashchange') window.removeEventListener(type, listener);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(['/other', '/missing', '/log?date=2026-04-01&meal=lunch'])('departure to %s during startup releases only the captured instance', async destination => {
  const startup = deferred<void>();
  adapter.camera.startup = () => startup.promise;
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  go(destination);
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  first.decode('obsolete');
  startup.resolve();
  await settle();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(first.track.readyState).toBe('ended');
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(barcode).not.toHaveBeenCalled();
});

it('Log Food looks up an accepted barcode only after camera release and presents the Food', async () => {
  click('#scan-btn');
  await settle();
  const scanner = adapter.instances[0];
  const stopping = deferred<void>();
  adapter.camera.shutdown = () => stopping.promise;
  barcode.mockImplementationOnce(async () => {
    expect(scanner.track.readyState).toBe('ended');
    return { food: food('Scanned apple') };
  });
  scanner.decode('012345');
  scanner.decode('duplicate');
  await settle();
  expect(barcode).not.toHaveBeenCalled();
  stopping.resolve();
  await settle();
  expect(barcode.mock.calls).toEqual([['012345']]);
  expect(scanner.stop).toHaveBeenCalledTimes(1);
  expect(scanner.track.readyState).toBe('ended');
  expect(document.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#tab-content')!.textContent).toBe('Found: Scanned apple');
});

it.each(['success', 'failure'])('barcode lookup %s belongs to the live Log Food mount across tab changes', async outcome => {
  const lookup = deferred<{ food: ReturnType<typeof food> }>();
  barcode.mockReturnValueOnce(lookup.promise);
  click('#scan-btn');
  await settle();
  adapter.instances[0].decode('captured-<code>');
  await settle();
  click('[data-tab="quick"]');
  if (outcome === 'success') lookup.resolve({ food: food('Scanned <apple>') });
  else lookup.reject(new Error('No match'));
  await settle();
  expect(document.querySelector('#tab-content')!.textContent).toBe(outcome === 'success'
    ? 'Found: Scanned <apple>' : 'No product found for barcode captured-<code>');
  expect(document.querySelector('#tab-content apple, #tab-content code')).toBeNull();
  if (outcome === 'success') expect(document.querySelector('#modal-food-name')!.textContent).toBe('Scanned <apple>');
});

it.each(['success', 'failure'])('barcode lookup %s cannot publish after departure or remount', async outcome => {
  for (const destination of ['/other', '/missing', '/log', '/log?date=2026-04-01&meal=lunch']) {
    go('/log?date=2026-04-01&meal=lunch');
    const lookup = deferred<{ food: ReturnType<typeof food> }>();
    barcode.mockReturnValueOnce(lookup.promise);
    click('#scan-btn');
    await settle();
    adapter.instances[adapter.instances.length - 1].decode('captured-code');
    await settle();
    expect(barcode).toHaveBeenLastCalledWith('captured-code');
    const oldRoot = document.querySelector('.log-page')!;
    go(destination);
    await settle();
    const oldHTML = oldRoot.innerHTML;
    const current = document.querySelector('#app')!.innerHTML;
    if (outcome === 'success') lookup.resolve({ food: food('Obsolete barcode') });
    else lookup.reject(new Error('Obsolete barcode failure'));
    await settle();
    expect(oldRoot.innerHTML).toBe(oldHTML);
    expect(document.querySelector('#app')!.innerHTML).toBe(current);
    expect(window.location.hash).toBe(`#${destination}`);
  }
});

it('retained scanner controls and callbacks cannot restart capture or lookup after disposal', async () => {
  click('#scan-btn');
  await settle();
  const scan = document.querySelector<HTMLButtonElement>('#scan-btn')!;
  const close = document.querySelector<HTMLButtonElement>('#scanner-close')!;
  const torch = document.querySelector<HTMLButtonElement>('#torch-btn')!;
  go('/other');
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  scan.click();
  close.click();
  torch.click();
  adapter.instances[0].decode('obsolete');
  await settle();
  expect(adapter.instances).toHaveLength(1);
  expect(adapter.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(adapter.instances[0].track.applyConstraints).toHaveBeenCalledTimes(2);
  expect(barcode).not.toHaveBeenCalled();
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(window.location.hash).toBe('#/other');
});

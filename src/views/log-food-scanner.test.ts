import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deferred, food } from '../test/food-search-fixtures';
import { click, go } from '../test/recipe-editor-fixtures';

const camera = {
  loading: Promise.resolve(),
  startup: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  constraints: () => Promise.resolve(),
};
const instances: Scanner[] = [];
const events: string[] = [];
const barcode = vi.fn();
let listeners: ReturnType<typeof listenForRoutes>;

function listenForRoutes() { return vi.spyOn(window, 'addEventListener'); }

class Scanner {
  decode!: (code: string) => void;
  track = {
    readyState: 'live',
    stop: vi.fn(() => { this.track.readyState = 'ended'; events.push(`release:${this.id}`); }),
    getCapabilities: () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 3 }, torch: true }),
    applyConstraints: vi.fn(() => camera.constraints()),
  };
  constructor(readonly id: string) { instances.push(this); }
  start = vi.fn((_camera: unknown, _config: unknown, decode: (code: string) => void) => {
    events.push(`start:${this.id}`);
    this.decode = decode;
    const video = document.createElement('video');
    Object.defineProperty(video, 'srcObject', { value: { getTracks: () => [this.track], getVideoTracks: () => [this.track] } });
    document.getElementById(this.id)!.append(video);
    return camera.startup();
  });
  stop = vi.fn(() => { events.push(`stop:${this.id}`); return camera.shutdown(); });
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  instances.length = 0;
  events.length = 0;
  camera.loading = Promise.resolve();
  camera.startup = () => Promise.resolve();
  camera.shutdown = () => Promise.resolve();
  camera.constraints = () => Promise.resolve();
  barcode.mockReset().mockResolvedValue({ food: food('Scanned apple') });
  vi.doMock('../api', () => ({
    foods: { recent: vi.fn().mockResolvedValue({ foods: [] }), barcode },
    meals: {}, recipes: {},
  }));
  vi.doMock('html5-qrcode', async () => { await camera.loading; return { Html5Qrcode: Scanner }; });
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

it('close during startup waits for settlement and releases the captured camera once', async () => {
  const startup = deferred<void>();
  camera.startup = () => startup.promise;
  click('#scan-btn');
  await settle();
  expect(instances).toHaveLength(1);
  click('#scanner-close');
  click('#scanner-close');
  expect(instances[0].stop).not.toHaveBeenCalled();
  startup.resolve();
  await settle();
  expect(instances[0].stop).toHaveBeenCalledTimes(1);
  expect(instances[0].track.readyState).toBe('ended');
  expect(barcode).not.toHaveBeenCalled();
  expect(document.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
});

it.each(['close', 'matched departure', 'unmatched departure', 'remount'])('deferred import cannot start a camera after %s', async how => {
  const loading = deferred<void>();
  camera.loading = loading.promise;
  click('#scan-btn');
  await settle();
  if (how === 'close') click('#scanner-close');
  else go(how === 'remount' ? '/log' : how === 'matched departure' ? '/other' : '/missing');
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  loading.resolve();
  await settle();
  expect(instances).toHaveLength(0);
  if (how !== 'close') expect(document.querySelector('#app')!.innerHTML).toBe(current);
  else expect(document.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
  expect(barcode).not.toHaveBeenCalled();
  if (how !== 'close') go('/log');
  click('#scan-btn');
  await settle();
  expect(instances).toHaveLength(1);
  instances[0].decode('retry');
  await settle();
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('Scanned apple');
});

it.each(['/other', '/missing', '/log?date=2026-04-01&meal=lunch'])('departure to %s during startup releases only the captured instance', async destination => {
  const startup = deferred<void>();
  camera.startup = () => startup.promise;
  click('#scan-btn');
  await settle();
  const first = instances[0];
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

it.each(['reopen', 'remount'])('pending stop serializes the next %s until tracks are released', async how => {
  click('#scan-btn');
  await settle();
  const first = instances[0];
  const stopping = deferred<void>();
  camera.shutdown = () => stopping.promise;
  click('#scanner-close');
  if (how === 'remount') go('/log');
  click('#scan-btn');
  await settle();
  expect(instances).toHaveLength(1);
  expect(first.track.readyState).toBe('live');
  first.decode('obsolete');
  stopping.resolve();
  await settle();
  expect(instances).toHaveLength(2);
  const second = instances[1];
  expect(second.id).not.toBe(first.id);
  expect(events.indexOf(`release:${first.id}`)).toBeLessThan(events.indexOf(`start:${second.id}`));
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(document.getElementById(second.id)?.querySelector('video')).not.toBeNull();
  expect(document.querySelector('#torch-btn')!.textContent).toBe('Flashlight');
  second.decode('current');
  second.decode('duplicate');
  await settle();
  expect(barcode.mock.calls).toEqual([['current']]);
  expect(second.track.readyState).toBe('ended');
});

it.each(['throw', 'reject'])('handled stop %s releases tracks and allows a current retry', async how => {
  click('#scan-btn');
  await settle();
  const first = instances[0];
  camera.shutdown = () => {
    if (how === 'throw') throw new Error('Synchronous stop failure');
    return Promise.reject(new Error('Rejected stop'));
  };
  click('#scanner-close');
  click('#scanner-close');
  await settle();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(first.track.readyState).toBe('ended');
  camera.shutdown = () => Promise.resolve();
  click('#scan-btn');
  await settle();
  instances[1].decode('retry');
  await settle();
  expect(barcode.mock.calls).toEqual([['retry']]);
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('Scanned apple');
});

it.each(['current', 'departed'])('startup rejection is handled for a %s attempt and permits retry', async how => {
  const startup = deferred<void>();
  camera.startup = () => startup.promise;
  click('#scan-btn');
  await settle();
  if (how === 'departed') go('/log');
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  startup.reject(new Error('Camera unavailable'));
  await settle();
  expect(instances[0].track.readyState).toBe('ended');
  expect(document.querySelector('#scanner-close')).not.toBeNull();
  if (how === 'current') expect(document.querySelector('#scanner-container')!.textContent).toContain('Camera access denied or not available.');
  else expect(document.querySelector('#app')!.innerHTML).toBe(current);
  camera.startup = () => Promise.resolve();
  click('#scan-btn');
  await settle();
  instances[1].decode('retry');
  await settle();
  expect(barcode.mock.calls).toEqual([['retry']]);
});

it('a current scan consumes duplicates, closes, then publishes the captured barcode result', async () => {
  click('#scan-btn');
  await settle();
  const scanner = instances[0];
  expect(scanner.start.mock.calls[0].slice(0, 2)).toEqual([
    { facingMode: 'environment' },
    { fps: 15, qrbox: { width: 300, height: 150 }, aspectRatio: 1.777778 },
  ]);
  expect(scanner.track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }, { zoom: 1.5 }] });
  scanner.decode('012345');
  scanner.decode('duplicate');
  await settle();
  expect(barcode.mock.calls).toEqual([['012345']]);
  expect(scanner.stop).toHaveBeenCalledTimes(1);
  expect(scanner.track.readyState).toBe('ended');
  expect(document.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector('#food-detail-modal')!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#tab-content')!.textContent).toBe('Found: Scanned apple');
});

it.each(['success', 'failure'])('barcode lookup %s cannot publish after departure or remount', async outcome => {
  for (const destination of ['/other', '/missing', '/log', '/log?date=2026-04-01&meal=lunch']) {
    go('/log?date=2026-04-01&meal=lunch');
    const lookup = deferred<{ food: ReturnType<typeof food> }>();
    barcode.mockReturnValueOnce(lookup.promise);
    click('#scan-btn');
    await settle();
    instances[instances.length - 1].decode('captured-code');
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

it('optional constraint rejection stays nonfatal and flashlight keeps its last applied state', async () => {
  camera.constraints = () => Promise.reject(new Error('Unsupported optional constraints'));
  click('#scan-btn');
  await settle();
  expect(document.querySelector('#torch-btn')!.textContent).toBe('Flashlight');
  click('#torch-btn');
  await settle();
  expect(document.querySelector('#torch-btn')!.textContent).toBe('Flashlight');
  camera.constraints = () => Promise.resolve();
  click('#torch-btn');
  await settle();
  expect(document.querySelector('#torch-btn')!.textContent).toBe('Flashlight Off');
  instances[0].decode('still-scanning');
  await settle();
  expect(document.querySelector('#modal-food-name')!.textContent).toBe('Scanned apple');
});

it('delayed optional constraints cannot change successor flashlight controls', async () => {
  click('#scan-btn');
  await settle();
  const constraints = deferred<void>();
  camera.constraints = () => constraints.promise;
  const oldButton = document.querySelector<HTMLButtonElement>('#torch-btn')!;
  oldButton.click();
  go('/log');
  camera.constraints = () => Promise.resolve();
  click('#scan-btn');
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  constraints.resolve();
  await settle();
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(oldButton.textContent).toBe('Flashlight');
  oldButton.click();
  expect(instances[0].track.applyConstraints).toHaveBeenCalledTimes(2);
});

it.each(['current', 'departed'])('scanner import rejection is handled for a %s attempt', async how => {
  const loading = deferred<void>();
  camera.loading = loading.promise;
  click('#scan-btn');
  await settle();
  if (how === 'departed') go('/log');
  await settle();
  const current = document.querySelector('#app')!.innerHTML;
  loading.reject(new Error('Scanner module unavailable'));
  await settle();
  expect(instances).toHaveLength(0);
  if (how === 'departed') expect(document.querySelector('#app')!.innerHTML).toBe(current);
  else {
    expect(document.querySelector('#scanner-container')!.textContent).toContain('Camera access denied or not available.');
    click('#scanner-close');
    expect(document.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
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
  instances[0].decode('obsolete');
  await settle();
  expect(instances).toHaveLength(1);
  expect(instances[0].stop).toHaveBeenCalledTimes(1);
  expect(instances[0].track.applyConstraints).toHaveBeenCalledTimes(1);
  expect(barcode).not.toHaveBeenCalled();
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(window.location.hash).toBe('#/other');
});

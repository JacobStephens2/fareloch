import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountBarcodeScanner } from './barcode-scanner-session';
import { scannerAdapter } from '../test/barcode-scanner-fixtures';
import { deferred } from '../test/food-search-fixtures';

let adapter: ReturnType<typeof scannerAdapter>;
let root: HTMLElement;
let onBarcode: ReturnType<typeof vi.fn>;
const disposers: (() => void)[] = [];
const pendingWork: (() => void)[] = [];
const settle = () => vi.advanceTimersByTimeAsync(0);
const click = (selector: string, owner = root) => owner.querySelector<HTMLButtonElement>(selector)!.click();

function pending() {
  const work = deferred<void>();
  pendingWork.push(() => work.resolve());
  return work;
}

function mount() {
  const ancestor = document.createElement('main');
  const host = document.createElement('section');
  host.innerHTML = '<div class="search"><button id="scan-btn">Scan</button></div><div id="scanner-container" class="hidden"><div id="scanner-video"></div><button id="scanner-close">Close</button></div>';
  ancestor.append(host);
  document.body.append(ancestor);
  disposers.push(mountBarcodeScanner(host, { onBarcode, loadScanner: adapter.loadScanner }));
  return host;
}

beforeEach(() => {
  vi.useFakeTimers();
  adapter = scannerAdapter();
  onBarcode = vi.fn();
  root = mount();
});

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose());
  pendingWork.splice(0).forEach(finish => finish());
  await settle();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('an initially disconnected scanner mount never loads hardware and disposes repeatedly', async () => {
  const root = document.createElement('section');
  root.innerHTML = '<button id="scan-btn">Scan</button><div id="scanner-container" class="hidden"><div id="scanner-video"></div><button id="scanner-close">Close</button></div>';
  const loadScanner = vi.fn();
  const dispose = mountBarcodeScanner(root, { onBarcode: vi.fn(), loadScanner });
  document.body.append(root);
  root.querySelector<HTMLButtonElement>('#scan-btn')!.click();
  await Promise.resolve();
  expect(loadScanner).not.toHaveBeenCalled();
  expect(root.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
  dispose();
  dispose();
});

it('close during startup waits for settlement and releases the captured camera once', async () => {
  const startup = pending();
  adapter.camera.startup = () => startup.promise;
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  expect(first.connectedAtConstruction).toBe(true);
  click('#scanner-close');
  click('#scanner-close');
  expect(first.stop).not.toHaveBeenCalled();
  startup.resolve();
  await settle();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(first.track.readyState).toBe('ended');
  expect(document.getElementById(first.id)).toBeNull();
  expect(onBarcode).not.toHaveBeenCalled();
  expect(root.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
});

it.each(['close', 'dispose', 'root', 'ancestor', '.search', '#scan-btn', '#scanner-container', '#scanner-video', '#scanner-close'])(
  'a deferred loader cannot construct hardware after %s, including synchronous reconnection', async how => {
    const loading = pending();
    adapter.camera.loading = loading.promise;
    click('#scan-btn');
    await settle();
    expect(adapter.loadScanner).toHaveBeenCalledTimes(1);
    if (how === 'close') click('#scanner-close');
    else if (how === 'dispose') { disposers[0](); disposers[0](); }
    else {
      const node = how === 'root' ? root : how === 'ancestor' ? root.parentElement! : root.querySelector(how)!;
      const parent = node.parentNode!;
      const next = node.nextSibling;
      node.remove();
      parent.insertBefore(node, next);
      // Exercise takeRecords before MutationObserver delivery.
      click('#scan-btn');
    }
    loading.resolve();
    await settle();
    expect(adapter.instances).toHaveLength(0);
    expect(onBarcode).not.toHaveBeenCalled();
    if (how === 'close') click('#scan-btn');
    else { root = mount(); click('#scan-btn'); }
    await settle();
    expect(adapter.instances).toHaveLength(1);
  },
);

it.each(['root', 'ancestor', '#scan-btn', '#scanner-container', '#scanner-video', '#scanner-close'])(
  'departure of %s during startup retires retained controls and releases after settlement', async how => {
    const startup = pending();
    adapter.camera.startup = () => startup.promise;
    click('#scan-btn');
    await settle();
    const first = adapter.instances[0];
    const node = how === 'root' ? root : how === 'ancestor' ? root.parentElement! : root.querySelector(how)!;
    const parent = node.parentNode!;
    const next = node.nextSibling;
    node.remove();
    parent.insertBefore(node, next);
    first.decode('obsolete');
    click('#scan-btn');
    expect(first.stop).not.toHaveBeenCalled();
    startup.resolve();
    await settle();
    expect(first.track.readyState).toBe('ended');
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(first.track.applyConstraints).not.toHaveBeenCalled();
    expect(onBarcode).not.toHaveBeenCalled();
    click('#scan-btn');
    await settle();
    expect(adapter.instances).toHaveLength(1);
  },
);

it('consumes duplicate decodes and delivers only after its camera is released', async () => {
  vi.stubGlobal('innerWidth', 320);
  click('#scan-btn');
  await settle();
  vi.unstubAllGlobals();
  const first = adapter.instances[0];
  expect(first.start.mock.calls[0].slice(0, 2)).toEqual([
    { facingMode: 'environment' }, { fps: 15, qrbox: { width: 280, height: 150 } },
  ]);
  expect(first.track.applyConstraints).toHaveBeenCalledWith({ aspectRatio: 1.777778 });
  expect(first.track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }, { zoom: 1.5 }] });
  const stopping = pending();
  adapter.camera.shutdown = () => stopping.promise;
  first.decode('accepted');
  first.decode('duplicate');
  await settle();
  expect(root.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
  expect(onBarcode).not.toHaveBeenCalled();
  stopping.resolve();
  await settle();
  expect(onBarcode.mock.calls).toEqual([['accepted']]);
  expect(first.track.readyState).toBe('ended');
  expect(document.getElementById(first.id)).toBeNull();
});

it.each(['reopen', 'competing mount'])('serializes %s behind startup, shutdown and track release', async how => {
  const startup = pending();
  const stopping = pending();
  adapter.camera.startup = () => startup.promise;
  adapter.camera.shutdown = () => stopping.promise;
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  click('#scanner-close');
  if (how === 'competing mount') root = mount();
  click('#scan-btn');
  await settle();
  expect(adapter.loadScanner).toHaveBeenCalledTimes(1);
  startup.resolve();
  await settle();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(adapter.instances).toHaveLength(1);
  expect(first.track.readyState).toBe('live');
  stopping.resolve();
  await settle();
  const second = adapter.instances[1];
  expect(second.id).not.toBe(first.id);
  expect(second.connectedAtConstruction).toBe(true);
  expect(adapter.events.indexOf(`release:${first.id}`)).toBeLessThan(adapter.events.indexOf(`start:${second.id}`));
  expect(document.getElementById(second.id)?.querySelector('video')).not.toBeNull();
});

it('rechecks a queued attempt before lazy loading when its mount departs', async () => {
  click('#scan-btn');
  await settle();
  const stopping = pending();
  adapter.camera.shutdown = () => stopping.promise;
  click('#scanner-close');
  root = mount();
  click('#scan-btn');
  disposers[1]();
  stopping.resolve();
  await settle();
  expect(adapter.loadScanner).toHaveBeenCalledTimes(1);
  expect(adapter.instances).toHaveLength(1);
});

it('a competing mount waits for an obsolete loader to settle before loading its own adapter', async () => {
  const loading = pending();
  adapter.camera.loading = loading.promise;
  click('#scan-btn');
  await settle();
  disposers[0]();
  root = mount();
  click('#scan-btn');
  await settle();
  expect(adapter.loadScanner).toHaveBeenCalledTimes(1);
  expect(adapter.instances).toHaveLength(0);
  loading.resolve();
  await settle();
  expect(adapter.loadScanner).toHaveBeenCalledTimes(2);
  expect(adapter.instances).toHaveLength(1);
  expect(root.querySelector('video')).not.toBeNull();
});

it('captures tracks before and after shutdown while leaving unrelated video tracks alone', async () => {
  const unrelatedStop = vi.fn();
  const unrelated = document.createElement('video');
  Object.defineProperty(unrelated, 'srcObject', { value: { getTracks: () => [{ stop: unrelatedStop }] } });
  document.body.prepend(unrelated);
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  const lateTrack = { readyState: 'live', stop: vi.fn() };
  const host = document.getElementById(first.id)!;
  adapter.camera.shutdown = async () => {
    Object.defineProperty(host.querySelector('video')!, 'srcObject', { value: { getTracks: () => [lateTrack] } });
  };
  click('#scanner-close');
  await settle();
  expect(first.track.readyState).toBe('ended');
  expect(lateTrack.stop).toHaveBeenCalledTimes(1);
  expect(unrelatedStop).not.toHaveBeenCalled();
  expect(unrelated.isConnected).toBe(true);
});

it.each(['current', 'retired'])('a deferred startup rejection releases the %s captured camera', async how => {
  const startup = pending();
  adapter.camera.startup = () => startup.promise;
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  if (how === 'retired') disposers[0]();
  startup.reject(new Error('Late camera failure'));
  await settle();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(first.track.readyState).toBe('ended');
  expect(onBarcode).not.toHaveBeenCalled();
  expect(!!root.querySelector('.form-error')).toBe(how === 'current');
});

it.each(['throw', 'reject'])('handled stop %s releases retained tracks even if shutdown detaches the stream', async how => {
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  const host = document.getElementById(first.id)!;
  adapter.camera.shutdown = () => {
    host.querySelector('video')!.srcObject = null;
    if (how === 'throw') throw new Error('Synchronous stop failure');
    return Promise.reject(new Error('Rejected stop'));
  };
  click('#scanner-close');
  click('#scanner-close');
  await settle();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(first.track.readyState).toBe('ended');
  adapter.camera.shutdown = () => Promise.resolve();
  click('#scan-btn');
  await settle();
  expect(adapter.instances).toHaveLength(2);
});

it.each(['throw', 'reject'])('startup %s leaves closable feedback, releases owned tracks and permits retry', async how => {
  adapter.camera.startup = () => {
    if (how === 'throw') throw new Error('Synchronous start failure');
    return Promise.reject(new Error('Camera unavailable'));
  };
  click('#scan-btn');
  await settle();
  expect(adapter.instances[0].track.readyState).toBe('ended');
  expect(adapter.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(root.querySelector('.form-error')!.textContent).toBe('Camera access denied or not available.');
  click('#scanner-close');
  expect(root.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(true);
  adapter.camera.startup = () => Promise.resolve();
  click('#scan-btn');
  await settle();
  expect(root.querySelector('.form-error')).toBeNull();
  expect(adapter.instances).toHaveLength(2);
});

it.each(['current', 'retired'])('loader rejection is handled for a %s mount', async how => {
  const loading = pending();
  adapter.camera.loading = loading.promise;
  click('#scan-btn');
  await settle();
  if (how === 'retired') disposers[0]();
  loading.reject(new Error('Scanner unavailable'));
  await settle();
  expect(adapter.instances).toHaveLength(0);
  if (how === 'current') {
    expect(root.querySelector('.form-error')!.textContent).toBe('Camera access denied or not available.');
    click('#scanner-close');
  } else expect(root.querySelector('.form-error')).toBeNull();
});

it.each(['deliver', 'close', 'dispose'])('an accepted decode awaiting stop handles reopening then %s', async action => {
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  const stopping = pending();
  adapter.camera.shutdown = () => stopping.promise;
  first.decode('accepted');
  await settle();
  click('#scan-btn');
  if (action === 'close') click('#scanner-close');
  if (action === 'dispose') disposers[0]();
  expect(adapter.instances).toHaveLength(1);
  stopping.resolve();
  await settle();
  expect(onBarcode.mock.calls).toEqual(action === 'dispose' ? [] : [['accepted']]);
  expect(adapter.instances).toHaveLength(action === 'deliver' ? 2 : 1);
  if (action === 'deliver') expect(root.querySelector('#scanner-container')!.classList.contains('hidden')).toBe(false);
});

it('close cancels a consumed barcode when no reopening replaced it', async () => {
  click('#scan-btn');
  await settle();
  const stopping = pending();
  adapter.camera.shutdown = () => stopping.promise;
  adapter.instances[0].decode('cancelled');
  await settle();
  click('#scanner-close');
  stopping.resolve();
  await settle();
  expect(onBarcode).not.toHaveBeenCalled();
});

it('optional constraint rejection stays nonfatal and flashlight reflects its last successful application', async () => {
  adapter.camera.constraints = () => Promise.reject(new Error('Unsupported optional constraint'));
  click('#scan-btn');
  await settle();
  expect(root.querySelector('#torch-btn')!.textContent).toBe('Flashlight');
  click('#torch-btn');
  await settle();
  expect(root.querySelector('#torch-btn')!.textContent).toBe('Flashlight');
  adapter.camera.constraints = () => Promise.resolve();
  click('#torch-btn');
  await settle();
  expect(root.querySelector('#torch-btn')!.textContent).toBe('Flashlight Off');
  adapter.camera.constraints = () => Promise.reject(new Error('Torch failed'));
  click('#torch-btn');
  await settle();
  expect(root.querySelector('#torch-btn')!.textContent).toBe('Flashlight Off');
  adapter.instances[0].decode('still-scanning');
  await settle();
  expect(onBarcode.mock.calls).toEqual([['still-scanning']]);
});

it.each(['aspect', 'focus', 'torch'])('pending optional %s constraints never delay release or alter successor controls', async kind => {
  const constraints = pending();
  adapter.camera.constraints = config => {
    if ((kind === 'aspect' && config.aspectRatio) || (kind === 'focus' && config.advanced?.length === 2)) return constraints.promise;
    return Promise.resolve();
  };
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  const oldButton = root.querySelector<HTMLButtonElement>('#torch-btn');
  if (kind === 'torch') {
    adapter.camera.constraints = () => constraints.promise;
    oldButton!.click();
  }
  click('#scanner-close');
  adapter.camera.constraints = () => Promise.resolve();
  click('#scan-btn');
  await settle();
  expect(first.track.readyState).toBe('ended');
  expect(adapter.instances).toHaveLength(2);
  const current = root.innerHTML;
  const applied = first.track.applyConstraints.mock.calls.length;
  constraints.resolve();
  await settle();
  oldButton?.click();
  expect(first.track.applyConstraints).toHaveBeenCalledTimes(applied);
  expect(root.innerHTML).toBe(current);
  expect(root.querySelector('#torch-btn')!.textContent).toBe('Flashlight');
});

it('retirement releases active capture and retained flashlight and decode callbacks stay inert', async () => {
  click('#scan-btn');
  await settle();
  const first = adapter.instances[0];
  const button = root.querySelector<HTMLButtonElement>('#torch-btn')!;
  root.remove();
  document.body.append(root);
  button.click();
  first.decode('obsolete');
  click('#scan-btn');
  await settle();
  expect(first.track.readyState).toBe('ended');
  expect(first.track.applyConstraints).toHaveBeenCalledTimes(2);
  expect(onBarcode).not.toHaveBeenCalled();
  expect(adapter.instances).toHaveLength(1);
});

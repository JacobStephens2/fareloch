import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dailyChecks, meals, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { state } from '../state';
import { dashboardView } from './dashboard';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
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
  state.selectedDate = '2026-11-04';
});

afterEach(() => {
  go('/other');
  document.querySelectorAll('.dashboard-page').forEach(root => root.remove());
  setToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function chip(key: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-check-key="${key}"]`);
  expect(button).not.toBeNull();
  return button!;
}

async function ready() {
  await vi.waitFor(() => expect(chip('creatine').disabled).toBe(false));
}

function renderDashboard() {
  go('/');
}

async function showDashboard() {
  renderDashboard();
  await ready();
}

it.each(['detached', 'reattached', 'removed from container'])('guest pills retained %s cannot save after losing ownership', async how => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  await showDashboard();
  const oldRoot = document.querySelector('.dashboard-page')!;
  const oldChip = chip('creatine');
  if (how === 'removed from container') oldChip.remove();
  else {
    go('/other');
    if (how === 'reattached') document.body.append(oldRoot);
  }
  oldChip.dispatchEvent(new MouseEvent('click'));
  await Promise.resolve();
  expect(await dailyChecks.get('2026-11-04')).toEqual({ checks: [] });
  expect(oldChip.getAttribute('aria-pressed')).toBe('false');
  oldRoot.remove();
  expect(network).not.toHaveBeenCalled();
});

it('reattaching disposed Dashboard before the router outlet must not steal the replacement mount', async () => {
  await showDashboard();
  const oldRoot = document.querySelector<HTMLElement>('.dashboard-page')!;
  go('/other');
  document.body.prepend(oldRoot);
  const disposedDOM = oldRoot.innerHTML;
  renderDashboard();
  await settle();
  const replacement = document.querySelector('#app .dashboard-page')!;
  expect(replacement.querySelector('[data-check-key="creatine"]')).not.toBeNull();
  expect(replacement.querySelector<HTMLButtonElement>('[data-check-key="creatine"]')!.disabled).toBe(false);
  expect(oldRoot.innerHTML).toBe(disposedDOM);
  oldRoot.querySelector<HTMLButtonElement>('[data-check-key="creatine"]')!.click();
  await settle();
  expect(await dailyChecks.get('2026-11-04')).toEqual({ checks: [] });
});

it('toggles daily pills independently and reloads each date through arrows and the date picker', async () => {
  await dailyChecks.set('2026-11-03', 'carotenoids', true);
  await meals.quickLog({ date: state.selectedDate, mealType: 'breakfast', name: 'Breakfast', calories: 300, proteinG: 20 });
  const before = await meals.getByDate(state.selectedDate);
  await showDashboard();
  expect(chip('creatine').textContent).toBe('Creatine 5g');
  expect(chip('carotenoids').textContent).toBe('Carotenoids + Fat 3x');
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  const macros = document.querySelector('#macro-summary')!.textContent;
  chip('creatine').click();
  await ready();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('true');
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('false');
  expect(await meals.getByDate(state.selectedDate)).toEqual(before);
  expect(document.querySelector('#macro-summary')!.textContent).toBe(macros);
  await showDashboard();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('true');
  document.querySelector<HTMLButtonElement>('#date-prev')!.click();
  await ready();
  expect(state.selectedDate).toBe('2026-11-03');
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('true');
  document.querySelector<HTMLButtonElement>('#date-next')!.click();
  await ready();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('true');
  chip('creatine').click();
  await ready();
  expect(await dailyChecks.get('2026-11-04')).toEqual({ checks: [] });
  document.querySelector<HTMLButtonElement>('#date-label')!.click();
  const picker = document.querySelector<HTMLInputElement>('input[type="date"]')!;
  picker.value = '2026-11-03';
  picker.dispatchEvent(new Event('change'));
  await ready();
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('true');
  chip('creatine').click();
  await ready();
  expect(await dailyChecks.get('2026-11-03')).toEqual({ checks: ['carotenoids', 'creatine'] });
  expect(await dailyChecks.get('2026-11-04')).toEqual({ checks: [] });
});

function useServerChecks(handle: (date: string, options?: RequestInit) => Promise<Response>) {
  setGuestMode(false);
  setToken('daily-checks-test-token');
  const checks = vi.fn(handle);
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.includes('/daily-checks/')) return checks(url.split('/').pop()!, options);
    if (url.includes('/workout-days/')) return Promise.resolve(Response.json({ isWorkoutDay: false }));
    return Promise.resolve(Response.json({ meals: [] }));
  }));
  return checks;
}

it('ignores a delayed daily-check read after navigating to another date', async () => {
  let finishRead!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finishRead = resolve; });
  useServerChecks(date => date === '2026-11-04'
    ? pending
    : Promise.resolve(Response.json({ checks: ['carotenoids'] })));
  renderDashboard();
  expect(chip('creatine').disabled).toBe(true);
  document.querySelector<HTMLButtonElement>('#date-prev')!.click();
  await ready();
  finishRead(Response.json({ checks: ['creatine'] }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(state.selectedDate).toBe('2026-11-03');
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('true');
});

it('saves against the clicked date while navigation and a delayed write are in flight', async () => {
  let finishSave!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finishSave = resolve; });
  let savedDate = '';
  let savedBody: unknown;
  useServerChecks((date, options) => {
    if (options?.method === 'PUT') {
      savedDate = date;
      savedBody = JSON.parse(String(options.body));
      return pending;
    }
    return Promise.resolve(Response.json({ checks: date === '2026-11-03' ? ['carotenoids'] : [] }));
  });
  await showDashboard();
  chip('creatine').click();
  expect(chip('creatine').disabled).toBe(true);
  document.querySelector<HTMLButtonElement>('#date-prev')!.click();
  await ready();
  finishSave(Response.json({ checks: ['creatine'] }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(savedDate).toBe('2026-11-04');
  expect(savedBody).toEqual({ key: 'creatine', checked: true });
  expect(state.selectedDate).toBe('2026-11-03');
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('true');
});

it('shows a failed save without marking the habit complete and allows another attempt', async () => {
  useServerChecks((_date, options) => Promise.resolve(options?.method === 'PUT'
    ? Response.json({ error: 'Unable to save' }, { status: 500 })
    : Response.json({ checks: [] })));
  await showDashboard();
  chip('creatine').click();
  await ready();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelector('#daily-checks [role="status"]')!.textContent).toContain('Could not save');
  chip('carotenoids').click();
  await ready();
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('false');
});

it('clears the previous date and disables checks when a date cannot load', async () => {
  useServerChecks(date => Promise.resolve(date === '2026-11-04'
    ? Response.json({ checks: ['creatine'] })
    : Response.json({ error: 'Unable to load' }, { status: 500 })));
  await showDashboard();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('true');
  document.querySelector<HTMLButtonElement>('#date-prev')!.click();
  await vi.waitFor(() => expect(document.querySelector('#daily-checks [role="status"]')!.textContent).toContain('Could not load'));
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(chip('creatine').disabled).toBe(true);
  expect(chip('carotenoids').disabled).toBe(true);
});

function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function selectDate(date: string) {
  document.querySelector<HTMLButtonElement>('#date-label')!.click();
  const picker = document.querySelector<HTMLInputElement>('input[type="date"]')!;
  picker.value = date;
  picker.dispatchEvent(new Event('change'));
}

function status(root: ParentNode = document) {
  return root.querySelector('#daily-checks [role="status"]')!.textContent;
}

function expectChecks(checks: string[], disabled = false) {
  for (const key of ['creatine', 'carotenoids']) {
    expect(chip(key).getAttribute('aria-pressed')).toBe(String(checks.includes(key)));
    expect(chip(key).disabled).toBe(disabled);
  }
}

function finish(request: ReturnType<typeof deferred>, outcome: string, checks = ['creatine']) {
  if (outcome === 'success') request.resolve(Response.json({ checks }));
  else request.reject(new Error('request failed'));
}

it.each(['success', 'failure'])('a late read %s cannot publish into a disposed, reattached or replacement Dashboard', async outcome => {
  const oldRead = deferred();
  const network = useServerChecks(() => Promise.resolve(Response.json({ checks: ['carotenoids'] })));
  network.mockReturnValueOnce(oldRead.promise);
  renderDashboard();
  const oldRoot = document.querySelector('.dashboard-page')!;
  const oldChip = chip('creatine');
  go('/other');
  await showDashboard();
  // Keep duplicate IDs behind the live root: publication must use mount ownership.
  document.body.append(oldRoot);
  const oldDOM = oldRoot.innerHTML;
  finish(oldRead, outcome);
  await settle();
  expect(oldRoot.innerHTML).toBe(oldDOM);
  expect(oldChip.disabled).toBe(true);
  expectChecks(['carotenoids']);
  expect(status()).toBe('');
});

it.each(['success', 'failure'])('a submitted write %s after disposal cannot reload or change retained or replacement DOM', async outcome => {
  const write = deferred();
  const network = useServerChecks((_date, options) => options?.method === 'PUT'
    ? write.promise : Promise.resolve(Response.json({ checks: [] })));
  await showDashboard();
  const oldRoot = document.querySelector('.dashboard-page')!;
  const oldChip = chip('creatine');
  oldChip.click();
  go('/other');
  await showDashboard();
  document.body.append(oldRoot);
  const oldDOM = oldRoot.innerHTML;
  const requests = network.mock.calls.length;
  finish(write, outcome);
  await settle();
  expect(network).toHaveBeenCalledTimes(requests);
  expect(oldRoot.innerHTML).toBe(oldDOM);
  expectChecks([]);
  expect(status()).toBe('');
  // Direct events on the retained control cannot submit another PUT either.
  oldChip.disabled = false;
  oldChip.dispatchEvent(new MouseEvent('click'));
  await settle();
  expect(network).toHaveBeenCalledTimes(requests);
});

it('guest submitted persistence survives route departure without reviving the old controls', async () => {
  await showDashboard();
  const oldChip = chip('creatine');
  oldChip.click();
  go('/other');
  const storageRead = vi.spyOn(Storage.prototype, 'getItem');
  await settle();
  expect(storageRead.mock.calls.filter(([key]) => key === 'guest_daily_checks')).toHaveLength(0);
  expect(oldChip.disabled).toBe(true);
  expect(oldChip.getAttribute('aria-pressed')).toBe('false');
  await showDashboard();
  expectChecks(['creatine']);
});

it('guest Daily checks persistence survives same-turn retirement without a follow-up read', async () => {
  await showDashboard();
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  const oldChip = chip('creatine');
  oldChip.click();
  departAndReconnect(root, 'root');
  const html = root.innerHTML;
  const storageRead = vi.spyOn(Storage.prototype, 'getItem');
  await settle();
  expect(storageRead.mock.calls.filter(([key]) => key === 'guest_daily_checks')).toHaveLength(0);
  expect(root.innerHTML).toBe(html);
  expect(oldChip.disabled).toBe(true);
  expect(await dailyChecks.get('2026-11-04')).toEqual({ checks: ['creatine'] });
  await showDashboard();
  expectChecks(['creatine']);
});

it.each(['success', 'failure'])('A to B to A ignores an obsolete read %s and clears checks immediately', async outcome => {
  const oldRead = deferred();
  const currentRead = deferred();
  const network = useServerChecks(() => Promise.resolve(Response.json({ checks: ['carotenoids'] })));
  await showDashboard();
  network.mockReturnValueOnce(oldRead.promise);
  selectDate('2026-11-04');
  expectChecks([], true);
  expect(status()).toBe('');
  selectDate('2026-11-03');
  await ready();
  network.mockReturnValueOnce(currentRead.promise);
  selectDate('2026-11-04');
  expectChecks([], true);
  finish(oldRead, outcome);
  await settle();
  expectChecks([], true);
  expect(status()).toBe('');
  currentRead.resolve(Response.json({ checks: ['carotenoids'] }));
  await ready();
  expectChecks(['carotenoids']);
});

it.each(['success', 'failure'])('pending A save %s on returning A refreshes the current selection and supersedes its read', async outcome => {
  const write = deferred();
  const returningRead = deferred();
  const followUp = deferred();
  const network = useServerChecks((_date, options) => options?.method === 'PUT'
    ? write.promise : Promise.resolve(Response.json({ checks: [] })));
  await showDashboard();
  chip('creatine').click();
  // Native disabled clicks and directly dispatched clicks must serialize A writes.
  chip('carotenoids').click();
  chip('carotenoids').dispatchEvent(new MouseEvent('click'));
  expect(network.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  selectDate('2026-11-03');
  await ready();
  network.mockReturnValueOnce(returningRead.promise);
  selectDate('2026-11-04');
  expectChecks([], true);
  network.mockReturnValueOnce(followUp.promise);
  finish(write, outcome);
  await settle();
  expect(network.mock.lastCall?.[0]).toBe('2026-11-04');
  expectChecks([], true);
  followUp.resolve(Response.json({ checks: outcome === 'success' ? ['creatine'] : [] }));
  await ready();
  const feedback = outcome === 'success' ? '' : 'Could not save daily check. Please try again.';
  expect(status()).toBe(feedback);
  // The older read is for the same date AND selection, so generation alone is insufficient.
  returningRead.resolve(Response.json({ checks: ['carotenoids'] }));
  await settle();
  expectChecks(outcome === 'success' ? ['creatine'] : []);
  expect(status()).toBe(feedback);
  chip('carotenoids').click();
  await ready();
  expect(network.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(2);
});

it.each(['success', 'failure'])('pending A save %s on B leaves B usable and reloads A only on return', async outcome => {
  const writeA = deferred();
  const writeB = deferred();
  let savedA = false;
  let savedB = false;
  const network = useServerChecks((date, options) => {
    if (options?.method === 'PUT') return date === '2026-11-04' ? writeA.promise : writeB.promise;
    return Promise.resolve(Response.json({ checks: date === '2026-11-04'
      ? (savedA ? ['creatine'] : []) : (savedB ? ['carotenoids'] : []) }));
  });
  await showDashboard();
  chip('creatine').click();
  selectDate('2026-11-03');
  await ready();
  chip('carotenoids').click();
  savedB = true;
  writeB.resolve(Response.json({ checks: [] }));
  await ready();
  expectChecks(['carotenoids']);
  const requests = network.mock.calls.length;
  savedA = outcome === 'success';
  finish(writeA, outcome);
  await settle();
  expect(network).toHaveBeenCalledTimes(requests);
  expectChecks(['carotenoids']);
  expect(status()).toBe('');
  selectDate('2026-11-04');
  await ready();
  expectChecks(savedA ? ['creatine'] : []);
  expect(status()).toBe('');
  const writes = network.mock.calls.filter(([, options]) => options?.method === 'PUT');
  expect(writes.map(([date, options]) => [date, JSON.parse(String(options?.body))])).toEqual([
    ['2026-11-04', { key: 'creatine', checked: true }],
    ['2026-11-03', { key: 'carotenoids', checked: true }],
  ]);
  expect(writes.every(([, options]) => options?.credentials === 'include'
    && new Headers(options.headers).get('Authorization') === 'Bearer daily-checks-test-token')).toBe(true);
});

it.each(['success', 'failure'])('obsolete failed-save reload %s cannot publish feedback after A to B to A', async outcome => {
  const oldReload = deferred();
  let reads = 0;
  useServerChecks((_date, options) => {
    if (options?.method === 'PUT') return Promise.resolve(Response.json({ error: 'Unable to save' }, { status: 500 }));
    if (++reads === 2) return oldReload.promise;
    return Promise.resolve(Response.json({ checks: ['carotenoids'] }));
  });
  await showDashboard();
  chip('creatine').click();
  await settle();
  expectChecks([], true);
  selectDate('2026-11-03');
  await ready();
  selectDate('2026-11-04');
  await ready();
  finish(oldReload, outcome);
  await settle();
  expectChecks(['carotenoids']);
  expect(status()).toBe('');
});

it('disabled loading and failed-load pills reject direct events, and reopening the date retries', async () => {
  const read = deferred();
  const network = useServerChecks(() => Promise.resolve(Response.json({ checks: ['creatine'] })));
  network.mockReturnValueOnce(read.promise);
  renderDashboard();
  expect(document.querySelector('[role="group"][aria-label="Daily checks"]')).not.toBeNull();
  chip('creatine').dispatchEvent(new MouseEvent('click'));
  expect(network).toHaveBeenCalledTimes(1);
  read.reject(new Error('load failed'));
  await settle();
  expectChecks([], true);
  expect(status()).toBe('Could not load daily checks. Reopen this date to retry.');
  chip('carotenoids').dispatchEvent(new MouseEvent('click'));
  expect(network).toHaveBeenCalledTimes(1);
  selectDate('2026-11-04');
  expect(status()).toBe('');
  expectChecks([], true);
  await ready();
  expectChecks(['creatine']);
});

it('a current failed-save reload failure preserves the save message and disabled controls until retry', async () => {
  let reads = 0;
  const network = useServerChecks((_date, options) => {
    if (options?.method === 'PUT' || ++reads === 2) {
      return Promise.resolve(Response.json({ error: 'Unavailable' }, { status: 500 }));
    }
    return Promise.resolve(Response.json({ checks: [] }));
  });
  await showDashboard();
  chip('creatine').click();
  await vi.waitFor(() => expect(status()).toBe('Could not save daily check. Please try again.'));
  expectChecks([], true);
  selectDate('2026-11-04');
  await ready();
  expectChecks([]);
  expect(status()).toBe('');
  network.mockImplementation(() => Promise.resolve(Response.json({ checks: ['creatine'] })));
  chip('creatine').click();
  await ready();
  expectChecks(['creatine']);
  expect(status()).toBe('');
});

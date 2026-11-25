import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { auth, getToken, setToken } from '../api';
import { seedSampleData, setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { onStateChange, state } from '../state';
import { settingsView } from './settings';
import { deferred } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { mountSettingsSession } from './settings-session';

const settle = () => vi.advanceTimersByTimeAsync(0);
let dispose: (() => void) | undefined;
const exportCases = [
  { selector: '#export-meals-btn', path: '/meals/export/csv', filename: 'meals.csv' },
  { selector: '#export-weight-btn', path: '/weight/export/csv', filename: 'weight.csv' },
];
const apiBase = import.meta.env.VITE_API_BASE || '/api';

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function button(selector: string, root: ParentNode = document) {
  return root.querySelector<HTMLButtonElement>(selector)!;
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/settings', settingsView);
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
  route('/login', () => ({ html: '<p>Login screen</p>', init() {} }));
  startRouter();
});

beforeEach(async () => {
  localStorage.clear();
  setGuestMode(true);
  state.user = (await auth.updateProfile({ currentWeightLbs: 200 })).user;
  setGuestMode(false);
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:settings-export');
    static revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  go('/other');
  document.querySelector('#retained')?.remove();
  state.user = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('retained theme controls cannot change a replacement Settings session', async () => {
  go('/settings');
  const oldRoot = document.querySelector<HTMLElement>('#app .page')!;
  const retainedDark = button('[data-theme="dark"]', oldRoot);
  go('/other');
  go('/settings');
  const html = document.querySelector('#app')!.innerHTML;
  retainedDark.click();
  document.body.append(oldRoot);
  retainedDark.dispatchEvent(new Event('click'));
  await settle();
  expect(localStorage.getItem('mt_theme')).toBeNull();
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(document.querySelector('#app')!.innerHTML).toBe(html);
  oldRoot.remove();
  button('#app [data-theme="dark"]').click();
  expect(localStorage.getItem('mt_theme')).toBe('dark');
});

it('a departed CSV response cannot create a download on a replacement screen', async () => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go('/settings');
  button('#export-meals-btn').click();
  go('/other');
  go('/settings');
  pending.resolve(new Response('date,calories\n2026-11-14,2000'));
  await settle();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  expect(document.querySelector('a[download]')).toBeNull();
});

it('retained guest logout cannot confirm or clear current guest data', async () => {
  setGuestMode(true);
  seedSampleData();
  go('/settings');
  const oldRoot = document.querySelector<HTMLElement>('#app .page')!;
  const retainedLogout = button('#logout-btn', oldRoot);
  go('/other');
  go('/settings');
  oldRoot.id = 'retained';
  document.body.append(oldRoot);
  const original = state.user;
  const stored = { ...localStorage };
  retainedLogout.click();
  retainedLogout.dispatchEvent(new Event('click'));
  await settle();
  expect(confirm).not.toHaveBeenCalled();
  expect({ ...localStorage }).toEqual(stored);
  expect(state.user).toBe(original);
  expect(location.hash).toBe('#/settings');
});

it.each([
  { preference: 'light', osDark: true, dark: false, color: '#F8F9FF' },
  { preference: 'dark', osDark: false, dark: true, color: '#0F1419' },
  { preference: 'system', osDark: true, dark: true, color: '#0F1419' },
  { preference: 'system', osDark: false, dark: false, color: '#F8F9FF' },
])('live $preference selection with OS dark=$osDark preserves appearance and radio semantics', ({ preference, osDark, dark, color }) => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: osDark })));
  go('/settings');
  button(`[data-theme="${preference}"]`).click();
  expect(localStorage.getItem('mt_theme')).toBe(preference);
  expect(document.documentElement.classList.contains('dark')).toBe(dark);
  expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')!.content).toBe(color);
  expect(document.querySelector('.theme-toggle')!.getAttribute('role')).toBe('radiogroup');
  for (const control of document.querySelectorAll<HTMLButtonElement>('.theme-option')) {
    expect(control.getAttribute('role')).toBe('radio');
    expect(control.getAttribute('aria-checked')).toBe(String(control.dataset.theme === preference));
    expect(control.classList.contains('active')).toBe(control.dataset.theme === preference);
  }
  go('/settings');
  expect(button(`[data-theme="${preference}"]`).getAttribute('aria-checked')).toBe('true');
});

it('initialization and live actions only bind and mark the current outlet beside an older connected screen', async () => {
  const network = vi.fn().mockResolvedValue(new Response('csv'));
  vi.stubGlobal('fetch', network);
  const retained = document.createElement('div');
  retained.id = 'retained';
  retained.innerHTML = settingsView().html;
  document.body.prepend(retained);
  const oldHTML = retained.innerHTML;
  go('/settings');
  button('[data-theme="dark"]', retained).click();
  button('#export-meals-btn', retained).click();
  button('#export-weight-btn', retained).click();
  button('#logout-btn', retained).click();
  await settle();
  expect(localStorage.getItem('mt_theme')).toBeNull();
  expect(network).not.toHaveBeenCalled();
  button('#app [data-theme="dark"]').click();
  expect(localStorage.getItem('mt_theme')).toBe('dark');
  expect(retained.innerHTML).toBe(oldHTML);
  button('#app #export-weight-btn').click();
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledWith(`${apiBase}/weight/export/csv`, { headers: {}, credentials: 'include' });
});

const departures = ['root', 'ancestor', 'fixed replacement', '.theme-toggle', '[data-theme="dark"]', '#logout-btn', '#s-name'];
it.each([false, true].flatMap(guest =>
  [...departures, ...(guest ? [] : ['#export-meals-btn', '#export-weight-btn'])].map(departure => ({ guest, departure }))))(
  'same-turn $departure permanently retires every Settings action with guest=$guest', async ({ guest, departure }) => {
    setGuestMode(guest);
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    go('/settings');
    const root = document.querySelector<HTMLElement>('#app .page')!;
    const controls = [...root.querySelectorAll<HTMLButtonElement>('.theme-option, #export-meals-btn, #export-weight-btn, #logout-btn')];
    const original = state.user;
    const stored = { ...localStorage };
    departAndReconnect(root, departure, '.theme-option');
    for (const control of controls) {
      control.click();
      control.dispatchEvent(new Event('click'));
    }
    await settle();
    expect(network).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(stored);
    expect(state.user).toBe(original);
    expect(location.hash).toBe('#/settings');
    go('/settings');
    button('[data-theme="dark"]').click();
    expect(localStorage.getItem('mt_theme')).toBe('dark');
  });

it.each([false, true].flatMap(guest => ['disconnected', 'disposed'].map(lifetime => ({ guest, lifetime }))))(
  'public Settings mount stays retired after $lifetime with guest=$guest', async ({ guest, lifetime }) => {
    setGuestMode(guest);
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    go('/other');
    const holder = document.createElement('div');
    holder.innerHTML = settingsView().html;
    const root = holder.querySelector<HTMLElement>('.page')!;
    const outlet = document.querySelector('#app')!;
    if (lifetime === 'disposed') outlet.append(root);
    dispose = mountSettingsSession(root, guest);
    if (lifetime === 'disconnected') outlet.append(root);
    else dispose();
    dispose();
    const stored = { ...localStorage };
    for (const control of root.querySelectorAll<HTMLButtonElement>('.theme-option, #export-meals-btn, #export-weight-btn, #logout-btn')) {
      control.click();
      control.dispatchEvent(new Event('click'));
    }
    await settle();
    expect({ ...localStorage }).toEqual(stored);
    expect(network).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    go('/settings');
    button('[data-theme="dark"]').click();
    expect(localStorage.getItem('mt_theme')).toBe('dark');
  });

it.each(exportCases.flatMap(flow => [null, 'accepted-token'].map(token => ({ ...flow, token }))))(
  'live $filename download captures token=$token and releases its resources', async ({ selector, path, filename, token }) => {
    setToken(token);
    const pending = deferred<Response>();
    const network = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', network);
    const clicked: { filename: string; href: string; connected: boolean }[] = [];
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ filename: this.download, href: this.href, connected: this.isConnected });
    });
    go('/settings');
    button(selector).click();
    expect(network).toHaveBeenCalledExactlyOnceWith(`${apiBase}${path}`, {
      headers: token ? { Authorization: 'Bearer accepted-token' } : {}, credentials: 'include',
    });
    setToken('later-token');
    const response = new Response('date,calories\n2026-11-14,2000');
    pending.resolve(response);
    await settle();
    expect(clicked).toEqual([{ filename, href: 'blob:settings-export', connected: true }]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:settings-export');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(alert).not.toHaveBeenCalled();
  });

it.each(['fetch', 'response', 'blob'])('a live CSV %s failure is handled with the existing feedback', async stage => {
  const response = new Response('csv', { status: stage === 'response' ? 500 : 200 });
  if (stage === 'blob') vi.spyOn(response, 'blob').mockRejectedValue(new Error('Blob failed'));
  vi.stubGlobal('fetch', stage === 'fetch'
    ? vi.fn().mockRejectedValue(new Error('Network failed'))
    : vi.fn().mockResolvedValue(response));
  go('/settings');
  button('#export-meals-btn').click();
  await settle();
  expect(alert).toHaveBeenCalledExactlyOnceWith(stage === 'fetch' ? 'Network failed' : stage === 'blob' ? 'Blob failed' : 'Download failed');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(document.querySelector('a[download]')).toBeNull();
});

it.each(['create anchor', 'append', 'click'])('a live download releases its URL and anchor when %s throws', async step => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('csv')));
  go('/settings');
  const fail = () => { throw new Error('Download step failed'); };
  if (step === 'create anchor') vi.spyOn(document, 'createElement').mockImplementationOnce(fail);
  if (step === 'append') vi.spyOn(document.body, 'appendChild').mockImplementationOnce(fail);
  if (step === 'click') vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(fail);
  button('#export-weight-btn').click();
  await settle();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:settings-export');
  expect(document.querySelector('a[download]')).toBeNull();
  expect(alert).toHaveBeenCalledExactlyOnceWith('Download step failed');
});

it('download cleanup finishes silently when clicking retires its mount and throws', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('csv')));
  go('/settings');
  vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
    go('/other');
    throw new Error('Departed click failed');
  });
  button('#export-meals-btn').click();
  await settle();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:settings-export');
  expect(document.querySelector('a[download]')).toBeNull();
  expect(alert).not.toHaveBeenCalled();
  expect(location.hash).toBe('#/other');
});

it('simultaneous exports retain filenames while responses and blobs complete in reverse orders', async () => {
  const meals = deferred<Response>();
  const weight = deferred<Response>();
  const mealBlob = deferred<Blob>();
  const weightBlob = deferred<Blob>();
  const mealResponse = new Response('meal csv');
  const weightResponse = new Response('weight csv');
  vi.spyOn(mealResponse, 'blob').mockImplementation(() => mealBlob.promise);
  vi.spyOn(weightResponse, 'blob').mockImplementation(() => weightBlob.promise);
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(meals.promise).mockReturnValueOnce(weight.promise));
  const downloaded: string[] = [];
  vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) {
    downloaded.push(this.download);
  });
  go('/settings');
  button('#export-meals-btn').click();
  button('#export-weight-btn').click();
  weight.resolve(weightResponse);
  await settle();
  meals.resolve(mealResponse);
  await settle();
  expect(downloaded).toEqual([]);
  const mealsContent = new Blob(['meal csv']);
  const weightContent = new Blob(['weight csv']);
  mealBlob.resolve(mealsContent);
  await settle();
  expect(downloaded).toEqual(['meals.csv']);
  weightBlob.resolve(weightContent);
  await settle();
  expect(downloaded).toEqual(['meals.csv', 'weight.csv']);
  expect(URL.createObjectURL).toHaveBeenNthCalledWith(1, mealsContent);
  expect(URL.createObjectURL).toHaveBeenNthCalledWith(2, weightContent);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  expect(document.querySelector('a[download]')).toBeNull();
});

const retiredDownloads = exportCases.flatMap(flow =>
  ['response success', 'response HTTP failure', 'response rejection', 'blob success', 'blob rejection'].flatMap(outcome =>
    ['/other', '/settings', 'ancestor'].map(destination => ({ ...flow, outcome, destination }))));
it.each(retiredDownloads)('retired $filename $outcome stays silent across $destination', async ({ selector, outcome, destination }) => {
  const responsePending = deferred<Response>();
  const blobPending = deferred<Blob>();
  const response = new Response('csv', { status: outcome === 'response HTTP failure' ? 500 : 200 });
  const readBlob = vi.spyOn(response, 'blob').mockImplementation(() => blobPending.promise);
  vi.stubGlobal('fetch', vi.fn(() => responsePending.promise));
  go('/settings');
  const root = document.querySelector<HTMLElement>('#app .page')!;
  button(selector).click();
  if (outcome.startsWith('blob')) {
    responsePending.resolve(response);
    await settle();
    expect(readBlob).toHaveBeenCalledTimes(1);
  }
  if (destination === 'ancestor') departAndReconnect(root, 'ancestor');
  else go(destination);
  const html = document.querySelector('#app')!.innerHTML;
  const append = vi.spyOn(document.body, 'appendChild');
  if (outcome === 'blob rejection') blobPending.reject(new Error('Late blob failure'));
  else if (outcome === 'blob success') blobPending.resolve(new Blob(['csv']));
  else if (outcome === 'response rejection') responsePending.reject(new Error('Late network failure'));
  else responsePending.resolve(response);
  await settle();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  expect(document.querySelector('#app')!.innerHTML).toBe(html);
});

it('guest cancellation releases the reservation, while confirmed exit clears guest data and navigates', async () => {
  setGuestMode(true);
  seedSampleData();
  localStorage.setItem('mt_theme', 'light');
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go('/settings');
  const logout = button('#logout-btn');
  const original = state.user;
  const stored = { ...localStorage };
  vi.mocked(confirm).mockImplementationOnce(() => {
    logout.dispatchEvent(new Event('click'));
    return false;
  });
  logout.click();
  await settle();
  expect(confirm).toHaveBeenCalledExactlyOnceWith('This will clear all your guest data. Continue?');
  expect({ ...localStorage }).toEqual(stored);
  expect(state.user).toBe(original);
  expect(location.hash).toBe('#/settings');
  expect(logout.disabled).toBe(false);
  logout.click();
  await settle();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(Object.keys(localStorage).filter(key => key.startsWith('guest_'))).toEqual([]);
  expect(localStorage.getItem('mt_theme')).toBe('light');
  expect(state.user).toBeNull();
  expect(location.hash).toBe('#/login');
  expect(network).not.toHaveBeenCalled();
});

it.each(['route', 'root', 'ancestor', '#logout-btn'])('guest exit rechecks ownership after confirmation retires its %s', async departure => {
  setGuestMode(true);
  seedSampleData();
  go('/settings');
  const root = document.querySelector<HTMLElement>('#app .page')!;
  const original = state.user;
  const stored = { ...localStorage };
  vi.mocked(confirm).mockImplementationOnce(() => {
    if (departure === 'route') go('/other');
    else departAndReconnect(root, departure);
    return true;
  });
  button('#logout-btn').click();
  await settle();
  expect({ ...localStorage }).toEqual(stored);
  expect(state.user).toBe(original);
  expect(location.hash).toBe(departure === 'route' ? '#/other' : '#/settings');
  expect(alert).not.toHaveBeenCalled();
});

it('guest confirmation follows the mode captured when the view rendered', async () => {
  setGuestMode(true);
  seedSampleData();
  const view = settingsView();
  setGuestMode(false);
  go('/other');
  document.querySelector('#app')!.innerHTML = view.html;
  view.init();
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  button('#logout-btn').click();
  await settle();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(Object.keys(localStorage).filter(key => key.startsWith('guest_'))).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  expect(state.user).toBeNull();
});

it('signed-in logout deduplicates pending events, clears a rejected token and permits a live retry', async () => {
  const first = deferred<Response>();
  const retry = deferred<Response>();
  const network = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  vi.stubGlobal('fetch', network);
  setToken('accepted-token');
  go('/settings');
  const original = state.user;
  const logout = button('#logout-btn');
  logout.click();
  logout.click();
  logout.dispatchEvent(new Event('click'));
  expect(logout.disabled).toBe(true);
  expect(network).toHaveBeenCalledExactlyOnceWith(`${apiBase}/auth/logout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer accepted-token' }, credentials: 'include',
  });
  first.reject(new Error('Logout unavailable'));
  await settle();
  expect(getToken()).toBeNull();
  expect(state.user).toBe(original);
  expect(alert).toHaveBeenCalledExactlyOnceWith('Logout unavailable');
  expect(logout.disabled).toBe(false);
  expect(location.hash).toBe('#/settings');
  logout.click();
  logout.dispatchEvent(new Event('click'));
  expect(network).toHaveBeenCalledTimes(2);
  retry.resolve(Response.json({ success: true }));
  await settle();
  expect(state.user).toBeNull();
  expect(location.hash).toBe('#/login');
  expect(confirm).not.toHaveBeenCalled();
});

it.each(['HTTP error', 'non-Error rejection', 'empty error'])('live logout handles %s without publishing user state', async failure => {
  vi.stubGlobal('fetch', failure === 'HTTP error'
    ? vi.fn().mockResolvedValue(Response.json({ error: 'Try logout later' }, { status: 500 }))
    : vi.fn().mockRejectedValue(failure === 'empty error' ? new Error('') : 'offline'));
  setToken('token');
  go('/settings');
  const original = state.user;
  button('#logout-btn').click();
  await settle();
  expect(state.user).toBe(original);
  expect(getToken()).toBeNull();
  expect(button('#logout-btn').disabled).toBe(false);
  expect(alert).toHaveBeenCalledExactlyOnceWith(failure === 'HTTP error' ? 'Try logout later' : 'Unable to log out. Please try again.');
  expect(location.hash).toBe('#/settings');
});

it.each(['success', 'failure'].flatMap(outcome =>
  ['/other', '/settings', 'ancestor'].map(destination => ({ outcome, destination }))))(
  'accepted logout $outcome finishes after $destination departure without screen effects', async ({ outcome, destination }) => {
    const pending = deferred<Response>();
    const network = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', network);
    setToken('token');
    go('/settings');
    const original = state.user;
    const root = document.querySelector<HTMLElement>('#app .page')!;
    const retainedLogout = button('#logout-btn', root);
    retainedLogout.click();
    if (destination === 'ancestor') departAndReconnect(root, 'ancestor');
    else go(destination);
    const html = document.querySelector('#app')!.innerHTML;
    retainedLogout.dispatchEvent(new Event('click'));
    if (outcome === 'success') pending.resolve(Response.json({ success: true }));
    else pending.reject(new Error('Late logout failure'));
    await settle();
    expect(state.user).toBe(outcome === 'success' ? null : original);
    expect(getToken()).toBeNull();
    expect(location.hash).toBe(destination === 'ancestor' ? '#/settings' : `#${destination}`);
    expect(document.querySelector('#app')!.innerHTML).toBe(html);
    expect(retainedLogout.disabled).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(1);
  });

it('logout rechecks its screen ownership after application publication', async () => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go('/settings');
  const unsubscribe = onStateChange(() => {
    if (state.user === null) go('/other');
  });
  try {
    button('#logout-btn').click();
    pending.resolve(Response.json({ success: true }));
    await settle();
    expect(state.user).toBeNull();
    expect(location.hash).toBe('#/other');
    expect(document.querySelector('#app')!.textContent).toBe('Other screen');
    expect(alert).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

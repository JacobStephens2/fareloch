import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { auth, getToken, setToken } from '../api';
import { getGuestUser, hasSampleData, isGuestMode, localFoods, localMeals, seedSampleData, setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { onStateChange, state, todayStr } from '../state';
import { deferred } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { loginView, registerView } from './auth';
import { mountLoginRegistration } from './login-registration-session';
import html from '../../index.html?raw';

const flows = [
  { kind: 'login', path: '/login', label: 'Log In', pendingLabel: 'Logging in...',
    payload: { email: 'submitted@example.invalid', password: 'submitted-password' } },
  { kind: 'register', path: '/register', label: 'Create Account', pendingLabel: 'Create Account',
    payload: { email: 'submitted@example.invalid', password: 'submitted-password', firstName: 'Alex' } },
] as const;
const returnedUser = { ...getGuestUser(), id: 7, email: 'submitted@example.invalid', firstName: 'Alex' };
const settle = () => vi.advanceTimersByTimeAsync(0);
let disposeSession: (() => void) | undefined;

function snapshot(root: HTMLElement) {
  return {
    html: root.innerHTML,
    values: [...root.querySelectorAll('input')].map(input => input.value),
    disabled: [...root.querySelectorAll('button')].map(button => button.disabled),
  };
}

function nextUserPublication() {
  return new Promise<void>(resolve => {
    const unsubscribe = onStateChange(() => {
      unsubscribe();
      resolve();
    });
  });
}

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function submit(form: Element) {
  const event = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

function begin(flow: typeof flows[number], root: ParentNode = document.querySelector('#app')!) {
  beginDraft(flow, root);
  return submit(root.querySelector('form')!);
}

function mountDirectly(flow: typeof flows[number]) {
  go('/other');
  document.querySelector('#app')!.innerHTML = (flow.kind === 'login' ? loginView() : registerView()).html;
  const root = document.querySelector<HTMLElement>('#app .auth-container')!;
  const dispose = mountLoginRegistration(root, flow.kind);
  disposeSession = dispose;
  return { root, dispose };
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/login', loginView);
  route('/register', registerView);
  route('/', () => ({ html: '<p>Home</p>', init() {} }));
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
  startRouter();
});

it.each(flows.flatMap(flow => ['root', 'fixed replacement'].map(departure => ({ flow, departure }))))(
  '$flow.kind permanently retires on same-turn $departure before router cleanup', async ({ flow, departure }) => {
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: returnedUser })));
    vi.stubGlobal('fetch', network);
    go(flow.path);
    const root = document.querySelector<HTMLElement>('#app .auth-container')!;
    beginDraft(flow, root);
    departAndReconnect(root, departure, '#email');
    const before = snapshot(root);
    submit(root.querySelector('form')!);
    root.querySelector<HTMLButtonElement>('#guest-btn')?.click();
    await settle();
    expect(network).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
    expect(state.user).toBeNull();
    expect(isGuestMode()).toBe(false);
    expect(window.location.hash).toBe(`#${flow.path}`);
  },
);

beforeEach(() => {
  localStorage.clear();
  state.user = null;
  vi.useFakeTimers();
});

afterEach(() => {
  disposeSession?.();
  disposeSession = undefined;
  go('/other');
  document.querySelector('#retained')?.remove();
  state.user = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(flows.flatMap(flow => ['completion first', 'observer first'].map(order => ({ flow, order }))))(
  '$flow.kind accepted authentication survives ancestor retirement with $order', async ({ flow, order }) => {
    const pending = deferred<{ user: typeof returnedUser }>();
    const request = vi.spyOn(auth, flow.kind).mockReturnValueOnce(pending.promise);
    go(flow.path);
    const root = document.querySelector<HTMLElement>('#app .auth-container')!;
    begin(flow, root);
    await Promise.resolve();
    const before = snapshot(root);
    if (order === 'completion first') pending.resolve({ user: returnedUser });
    departAndReconnect(root, 'ancestor');
    if (order === 'observer first') {
      await Promise.resolve();
      pending.reject(new Error('Late failure'));
    }
    await settle();
    expect(snapshot(root)).toEqual(before);
    expect(state.user).toEqual(order === 'completion first' ? returnedUser : null);
    expect(window.location.hash).toBe(`#${flow.path}`);
    submit(root.querySelector('form')!);
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each(flows)('initially disconnected $kind mounts stay retired and a fresh mount works', async flow => {
  const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: returnedUser })));
  vi.stubGlobal('fetch', network);
  go('/other');
  const holder = document.createElement('div');
  holder.innerHTML = (flow.kind === 'login' ? loginView() : registerView()).html;
  const root = holder.querySelector<HTMLElement>('.auth-container')!;
  disposeSession = mountLoginRegistration(root, flow.kind);
  document.querySelector('#app')!.append(root);
  begin(flow, root);
  root.querySelector<HTMLButtonElement>('#guest-btn')?.click();
  await settle();
  expect(network).not.toHaveBeenCalled();
  expect(state.user).toBeNull();
  disposeSession();
  disposeSession();
  go(flow.path);
  begin(flow);
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(state.user).toEqual(returnedUser);
});

it.each(flows)('live $kind captures one submission and becomes terminal before router replacement', async flow => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const form = document.querySelector('form')!;
  const button = form.querySelector('button')!;
  expect(begin(flow).defaultPrevented).toBe(true);
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe(flow.pendingLabel);
  document.querySelector<HTMLInputElement>('#email')!.value = 'later@example.invalid';
  document.querySelector<HTMLInputElement>('#password')!.value = 'later-password';
  if (flow.kind === 'register') document.querySelector<HTMLInputElement>('#firstName')!.value = 'Later';
  submit(form);
  submit(form);
  const requestsWhilePending = network.mock.calls.length;
  const published = nextUserPublication();
  pending.resolve(new Response(JSON.stringify({ user: returnedUser, token: 'returned-token' })));
  // Observe publication without advancing the router's hashchange task.
  await published;
  expect(state.user).toEqual(returnedUser);
  expect(form.isConnected).toBe(true);
  submit(form);
  expect(requestsWhilePending).toBe(1);
  expect(network).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledWith(`/api/auth/${flow.kind}`, expect.objectContaining({
    method: 'POST', body: JSON.stringify(flow.payload), credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  }));
  expect(getToken()).toBe('returned-token');
  expect(window.location.hash).toBe('#/');
  expect(button.disabled).toBe(true);
  await settle();
});

it.each(flows)('router cleanup permanently disables retained and reattached $kind controls', async flow => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const root = document.querySelector<HTMLElement>('#app .auth-container')!;
  go('/other');
  begin(flow, root);
  root.querySelector<HTMLButtonElement>('#guest-btn')?.click();
  root.id = 'retained';
  document.body.prepend(root);
  begin(flow, root);
  root.querySelector<HTMLButtonElement>('#guest-btn')?.click();
  await settle();
  expect(network).not.toHaveBeenCalled();
  expect(isGuestMode()).toBe(false);
  expect(hasSampleData()).toBe(false);
  expect(state.user).toBeNull();
  expect(window.location.hash).toBe('#/other');
});

it.each(flows)('a reattached old $kind root before the outlet cannot steal a replacement mount', async flow => {
  const network = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ user: returnedUser }))));
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const oldRoot = document.querySelector<HTMLElement>('#app .auth-container')!;
  go('/other');
  oldRoot.id = 'retained';
  document.body.prepend(oldRoot);
  const before = snapshot(oldRoot);
  go(flow.path);
  const app = document.querySelector<HTMLElement>('#app')!;
  begin(flow, app);
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(state.user).toEqual(returnedUser);
  expect(window.location.hash).toBe('#/');
  expect(snapshot(oldRoot)).toEqual(before);
  begin(flow, oldRoot);
  oldRoot.querySelector<HTMLButtonElement>('#guest-btn')?.click();
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(isGuestMode()).toBe(false);
  expect(state.user).toEqual(returnedUser);
});

it.each(flows.flatMap(flow => (['success', 'failure', 'rejection'] as const).map(outcome => ({ flow, kind: flow.kind, outcome }))))('explicit $kind disposal is idempotent while connected and consumes pending $outcome', async ({ flow, outcome }) => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  const { root, dispose } = mountDirectly(flow);
  begin(flow, root);
  const before = snapshot(root);
  dispose();
  dispose();
  expect(root.isConnected).toBe(true);
  submit(root.querySelector('form')!);
  root.querySelector<HTMLButtonElement>('#guest-btn')?.click();
  root.remove();
  document.querySelector('#app')!.append(root);
  submit(root.querySelector('form')!);
  root.querySelector<HTMLButtonElement>('#guest-btn')?.click();
  if (outcome === 'rejection') pending.reject(new Error('Disposed network failure'));
  else pending.resolve(new Response(JSON.stringify(outcome === 'success'
    ? { user: returnedUser, token: 'disposed-token' } : { error: 'Disposed failure' }), { status: outcome === 'success' ? 200 : 400 }));
  await settle();
  expect(snapshot(root)).toEqual(before);
  expect(network).toHaveBeenCalledTimes(1);
  expect(state.user).toEqual(outcome === 'success' ? returnedUser : null);
  expect(getToken()).toBe(outcome === 'success' ? 'disposed-token' : null);
  expect(isGuestMode()).toBe(false);
  expect(window.location.hash).toBe('#/other');
});

it.each(flows)('explicitly disposed $kind controls cannot begin work while still connected', async flow => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const { root, dispose } = mountDirectly(flow);
  dispose();
  dispose();
  begin(flow, root);
  root.querySelector<HTMLButtonElement>('#guest-btn')?.click();
  await settle();
  expect(root.isConnected).toBe(true);
  expect(network).not.toHaveBeenCalled();
  expect(isGuestMode()).toBe(false);
  expect(state.user).toBeNull();
});

it.each(flows.flatMap(flow => (['disconnected root', 'disconnected form', 'moved form'] as const).map(lifetime => ({ flow, kind: flow.kind, lifetime }))))('$kind cannot submit from a $lifetime before router cleanup', async ({ flow, lifetime }) => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const root = document.querySelector<HTMLElement>('#app .auth-container')!;
  const form = root.querySelector('form')!;
  beginDraft(flow, root);
  if (lifetime === 'disconnected root') root.remove();
  else if (lifetime === 'disconnected form') form.remove();
  else {
    const retained = document.createElement('div');
    retained.id = 'retained';
    document.body.append(retained);
    retained.append(form);
  }
  submit(form);
  await settle();
  expect(network).not.toHaveBeenCalled();
});

function beginDraft(flow: typeof flows[number], root: ParentNode) {
  root.querySelector<HTMLInputElement>('#email')!.value = flow.payload.email;
  root.querySelector<HTMLInputElement>('#password')!.value = flow.payload.password;
  if (flow.kind === 'register') root.querySelector<HTMLInputElement>('#firstName')!.value = flow.payload.firstName;
}

it.each(flows.flatMap(flow => (['disconnected root', 'moved form'] as const).map(lifetime => ({ flow, kind: flow.kind, lifetime }))))('$kind publishes its pending result without view effects from a $lifetime', async ({ flow, lifetime }) => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go(flow.path);
  const root = document.querySelector<HTMLElement>('#app .auth-container')!;
  begin(flow, root);
  const form = root.querySelector('form')!;
  if (lifetime === 'disconnected root') root.remove();
  else {
    const retained = document.createElement('div');
    retained.id = 'retained';
    document.body.append(retained);
    retained.append(form);
  }
  const before = snapshot(form);
  pending.resolve(new Response(JSON.stringify({ user: returnedUser, token: 'detached-token' })));
  await settle();
  expect(state.user).toEqual(returnedUser);
  expect(getToken()).toBe('detached-token');
  expect(snapshot(form)).toEqual(before);
  expect(window.location.hash).toBe(`#${flow.path}`);
});

it.each(flows)('$kind rejects foreign-target submit events', async flow => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go(flow.path);
  submit(document.querySelector('#email')!);
  await settle();
  expect(network).not.toHaveBeenCalled();
});

it('live guest entry seeds sample data, publishes the guest user, and immediately ends mount actions', async () => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go('/login');
  const root = document.querySelector<HTMLElement>('#app .auth-container')!;
  const guest = root.querySelector<HTMLButtonElement>('#guest-btn')!;
  guest.click();
  expect(root.isConnected).toBe(true);
  expect(isGuestMode()).toBe(true);
  expect(hasSampleData()).toBe(true);
  expect((await localFoods.custom()).foods).toHaveLength(6);
  expect((await localMeals.getByDate(todayStr())).meals).toHaveLength(6);
  expect(state.user).toEqual(getGuestUser());
  expect(window.location.hash).toBe('#/');
  const before = snapshot(root);
  submit(root.querySelector('form')!);
  // A second guest click must not republish even before router cleanup.
  state.user = returnedUser;
  guest.click();
  expect(state.user).toBe(returnedUser);
  expect(snapshot(root)).toEqual(before);
  expect(network).not.toHaveBeenCalled();
  await settle();
});

it.each(['success', 'failure', 'rejection'] as const)('guest entry remains live during pending Login and consumes its late %s without view effects', async outcome => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  go('/login');
  const root = document.querySelector<HTMLElement>('#app .auth-container')!;
  begin(flows[0], root);
  const guest = root.querySelector<HTMLButtonElement>('#guest-btn')!;
  expect(guest.disabled).toBe(false);
  guest.click();
  expect(isGuestMode()).toBe(true);
  expect(hasSampleData()).toBe(true);
  const guestUser = state.user;
  expect(guestUser).toEqual(getGuestUser());
  expect(window.location.hash).toBe('#/');
  const oldSnapshot = snapshot(root);
  submit(root.querySelector('form')!);
  guest.click();
  expect(network).toHaveBeenCalledTimes(1);
  expect(snapshot(root)).toEqual(oldSnapshot);
  go('/register');
  const app = document.querySelector<HTMLElement>('#app')!;
  const currentSnapshot = snapshot(app);
  if (outcome === 'rejection') pending.reject(new Error('Login network failure after guest entry'));
  else pending.resolve(new Response(JSON.stringify(outcome === 'success'
    ? { user: returnedUser, token: 'credential-token' } : { error: 'Login failed after guest entry' }), { status: outcome === 'success' ? 200 : 400 }));
  await settle();
  expect(state.user).toEqual(outcome === 'success' ? returnedUser : guestUser);
  expect(getToken()).toBe(outcome === 'success' ? 'credential-token' : null);
  expect(isGuestMode()).toBe(true);
  expect(hasSampleData()).toBe(true);
  expect(snapshot(root)).toEqual(oldSnapshot);
  expect(snapshot(app)).toEqual(currentSnapshot);
  expect(window.location.hash).toBe('#/register');
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(['disconnected root', 'disconnected button', 'moved button'] as const)('a guest button with a %s cannot act before cleanup', async lifetime => {
  go('/login');
  const root = document.querySelector<HTMLElement>('#app .auth-container')!;
  const guest = root.querySelector<HTMLButtonElement>('#guest-btn')!;
  if (lifetime === 'disconnected root') root.remove();
  else if (lifetime === 'disconnected button') guest.remove();
  else {
    const retained = document.createElement('div');
    retained.id = 'retained';
    document.body.append(retained);
    retained.append(guest);
  }
  guest.click();
  await settle();
  expect(isGuestMode()).toBe(false);
  expect(hasSampleData()).toBe(false);
  expect(state.user).toBeNull();
  expect(window.location.hash).toBe('#/login');
});

it('a retained guest button cannot act after credential success before router replacement', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: returnedUser }))));
  go('/login');
  const guest = document.querySelector<HTMLButtonElement>('#guest-btn')!;
  const published = nextUserPublication();
  begin(flows[0]);
  await published;
  expect(guest.isConnected).toBe(true);
  guest.click();
  expect(state.user).toEqual(returnedUser);
  expect(isGuestMode()).toBe(false);
  await settle();
});

it.each(flows.flatMap(flow => [false, true].map(departed => ({ flow, kind: flow.kind, departed }))))('$kind retains the request-owned global 401 redirect with departed=$departed', async ({ flow, departed }) => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const oldRoot = document.querySelector<HTMLElement>('#app .auth-container')!;
  begin(flow);
  const before = snapshot(oldRoot);
  if (departed) go('/other');
  pending.resolve(new Response('{}', { status: 401 }));
  await settle();
  expect(window.location.hash).toBe('#/login');
  await settle();
  expect(document.querySelector('#app #login-form')).not.toBeNull();
  if (departed) expect(snapshot(oldRoot)).toEqual(before);
  expect(network).toHaveBeenCalledTimes(1);
  expect(state.user).toBeNull();
});

const failures = [
  { name: 'HTTP failure', reject: false, value: () => new Response(JSON.stringify({ error: '<b>Try again</b>' }), { status: 400 }), message: '<b>Try again</b>' },
  { name: 'empty HTTP error', reject: false, value: () => new Response('{}', { status: 503 }), message: 'Request failed (HTTP 503). Please try again.' },
  { name: 'network rejection', reject: true, value: () => new Error('Network offline'), message: 'Network offline' },
  { name: 'non-Error rejection', reject: true, value: () => 'offline', message: null },
] as const;

it.each(flows.flatMap(flow => failures.map(failure => ({ flow, kind: flow.kind, ...failure }))))('live $kind shows readable $name and permits retry', async ({ flow, reject, value, message }) => {
  const network = vi.fn();
  if (reject) network.mockRejectedValueOnce(value());
  else network.mockResolvedValueOnce(value());
  network.mockResolvedValueOnce(new Response(JSON.stringify({ user: returnedUser })));
  vi.stubGlobal('fetch', network);
  go(flow.path);
  begin(flow);
  await settle();
  const error = document.querySelector(`#${flow.kind}-error`)!;
  const form = document.querySelector('form')!;
  expect(error.textContent).toBe(message ?? (flow.kind === 'login' ? 'Unable to log in.' : 'Unable to create account.'));
  expect(error.children).toHaveLength(0);
  expect(error.classList.contains('hidden')).toBe(false);
  expect(form.querySelector('button')!.disabled).toBe(false);
  expect(form.querySelector('button')!.textContent).toBe(flow.label);
  expect(state.user).toBeNull();
  expect(window.location.hash).toBe(`#${flow.path}`);
  begin(flow);
  expect(error.classList.contains('hidden')).toBe(true);
  await settle();
  expect(network).toHaveBeenCalledTimes(2);
  expect(state.user).toEqual(returnedUser);
  expect(window.location.hash).toBe('#/');
});

it('Registration retains readable unexpected-HTML feedback and enables retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html, { headers: { 'Content-Type': 'text/html' } })));
  go('/register');
  begin(flows[1]);
  await settle();
  const error = document.querySelector('#register-error')!;
  expect(error.textContent).toBe('The server returned an unexpected response (HTTP 200). Please try again.');
  expect(error.classList.contains('hidden')).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(false);
});

const departures = flows.flatMap(flow => (['success', 'failure', 'rejection'] as const).flatMap(outcome =>
  ['/other', '/unmatched', '/login', '/register'].map(destination => ({ flow, kind: flow.kind, outcome, destination }))));

it.each(departures)('departed $kind $outcome preserves application effects and leaves both roots untouched across $destination', async ({ flow, outcome, destination }) => {
  setGuestMode(true);
  seedSampleData();
  setToken('existing-token');
  const originalUser = getGuestUser();
  state.user = originalUser;
  const pending = deferred<Response>();
  const replacementRequest = deferred<Response>();
  const network = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValueOnce(replacementRequest.promise);
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const oldRoot = document.querySelector<HTMLElement>('#app .auth-container')!;
  begin(flow);
  expect(isGuestMode()).toBe(false);
  expect(hasSampleData()).toBe(false);
  expect((await localFoods.custom()).foods).toHaveLength(0);
  expect((await localMeals.getByDate(todayStr())).meals).toHaveLength(0);
  expect(network).toHaveBeenCalledWith(`/api/auth/${flow.kind}`, expect.objectContaining({
    method: 'POST', body: JSON.stringify(flow.payload), credentials: 'include',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer existing-token' },
  }));
  const oldSnapshot = snapshot(oldRoot);
  go(destination);
  const replacement = flows.find(candidate => candidate.path === destination);
  if (replacement) {
    begin(replacement);
    document.querySelector<HTMLInputElement>('#email')!.value = 'replacement-draft@example.invalid';
    const error = document.querySelector(`#${replacement.kind}-error`)!;
    error.textContent = 'Replacement feedback';
    error.classList.remove('hidden');
  }
  const app = document.querySelector<HTMLElement>('#app')!;
  const currentSnapshot = snapshot(app);
  if (outcome === 'rejection') pending.reject(new Error('Departed network failure'));
  else pending.resolve(new Response(JSON.stringify(outcome === 'success'
    ? { user: returnedUser, token: 'departed-token' } : { error: 'Departed failure' }), { status: outcome === 'success' ? 200 : 400 }));
  await settle();
  expect(state.user).toEqual(outcome === 'success' ? returnedUser : originalUser);
  expect(getToken()).toBe(outcome === 'success' ? 'departed-token' : 'existing-token');
  expect(window.location.hash).toBe(`#${destination}`);
  expect(snapshot(oldRoot)).toEqual(oldSnapshot);
  expect(snapshot(app)).toEqual(currentSnapshot);
  expect(network).toHaveBeenCalledTimes(replacement ? 2 : 1);
  if (replacement) {
    replacementRequest.resolve(new Response(JSON.stringify({ user: returnedUser, token: 'replacement-token' })));
    await settle();
    expect(getToken()).toBe('replacement-token');
    expect(window.location.hash).toBe('#/');
  }
});

import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { route, startRouter } from '../router';
import { auth, getToken, setToken } from '../api';
import { getGuestUser, isGuestMode, setGuestMode } from '../local-db';
import { state } from '../state';
import { deferred } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { forgotPasswordView, loginView, resetPasswordView } from './auth';
import { mountPasswordRecovery } from './password-recovery-session';
import html from '../../index.html?raw';

const settle = () => vi.advanceTimersByTimeAsync(0);
let disposeSession: (() => void) | undefined;

const flows = [
  { kind: 'forgot', path: '/forgot-password', input: 'email', value: 'submitted@example.invalid',
    endpoint: '/api/auth/forgot-password', payload: { email: 'submitted@example.invalid' },
    success: 'If that email exists, a reset link has been sent.' },
  { kind: 'reset', path: '/reset-password?token=mounted-token', input: 'password', value: 'submitted-password',
    endpoint: '/api/auth/reset-password', payload: { token: 'mounted-token', password: 'submitted-password' },
    success: 'Password reset! You can now log in.' },
] as const;

function begin(flow: typeof flows[number], root: ParentNode = document) {
  root.querySelector<HTMLInputElement>(`#${flow.input}`)!.value = flow.value;
  submit(root.querySelector('form')!);
}

function snapshot(root: HTMLElement) {
  return {
    html: root.innerHTML,
    values: [...root.querySelectorAll('input')].map(input => input.value),
    disabled: [...root.querySelectorAll('button')].map(button => button.disabled),
  };
}

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function submit(form: Element) {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/forgot-password', forgotPasswordView);
  route('/reset-password', resetPasswordView);
  route('/login', loginView);
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  localStorage.clear();
  state.user = null;
  vi.useFakeTimers();
});

it.each(flows.flatMap(flow => ['root', 'fixed replacement'].map(departure => ({ flow, departure }))))(
  '$flow.kind permanently retires on same-turn $departure before router cleanup', async ({ flow, departure }) => {
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
    vi.stubGlobal('fetch', network);
    go(flow.path);
    const root = document.querySelector<HTMLElement>('#app .auth-container')!;
    root.querySelector<HTMLInputElement>(`#${flow.input}`)!.value = flow.value;
    departAndReconnect(root, departure, `#${flow.input}`);
    const before = snapshot(root);
    submit(root.querySelector('form')!);
    await settle();
    expect(network).not.toHaveBeenCalled();
    expect(snapshot(root)).toEqual(before);
    expect(window.location.hash).toBe(`#${flow.path}`);
  },
);

it.each(flows.flatMap(flow => ['completion first', 'observer first'].map(order => ({ flow, order }))))(
  '$flow.kind accepted recovery stays silent after ancestor retirement with $order', async ({ flow, order }) => {
    const pending = deferred<{ success: boolean }>();
    const request = vi.spyOn(auth, flow.kind === 'forgot' ? 'forgotPassword' : 'resetPassword').mockReturnValueOnce(pending.promise);
    go(flow.path);
    const root = document.querySelector<HTMLElement>('#app .auth-container')!;
    begin(flow, root);
    await Promise.resolve();
    const before = snapshot(root);
    if (order === 'completion first') pending.resolve({ success: true });
    departAndReconnect(root, 'ancestor');
    if (order === 'observer first') {
      await Promise.resolve();
      pending.reject(new Error('Late failure'));
    }
    await settle();
    await vi.advanceTimersByTimeAsync(2100);
    expect(snapshot(root)).toEqual(before);
    expect(window.location.hash).toBe(`#${flow.path}`);
    submit(root.querySelector('form')!);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(flows)('initially disconnected $kind mounts stay retired and a fresh mount works', async flow => {
  const network = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ success: true }))));
  vi.stubGlobal('fetch', network);
  go('/other');
  const holder = document.createElement('div');
  holder.innerHTML = (flow.kind === 'forgot' ? forgotPasswordView() : resetPasswordView()).html;
  const root = holder.querySelector<HTMLElement>('.auth-container')!;
  disposeSession = mountPasswordRecovery(root, flow.kind === 'forgot' ? { kind: 'forgot' } : { kind: 'reset', token: 'mounted-token' });
  document.querySelector('#app')!.append(root);
  begin(flow, root);
  await settle();
  expect(network).not.toHaveBeenCalled();
  disposeSession();
  disposeSession();
  go(flow.path);
  begin(flow);
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(document.querySelector(`#${flow.kind}-msg`)!.textContent).toBe(flow.success);
});

it('ancestor retirement releases a successful reset redirect before reconnection', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))));
  go(flows[1].path);
  begin(flows[1]);
  await settle();
  const root = document.querySelector<HTMLElement>('#app .auth-container')!;
  expect(vi.getTimerCount()).toBe(1);
  departAndReconnect(root, 'ancestor');
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2100);
  expect(window.location.hash).toBe(`#${flows[1].path}`);
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

it('departed forgot success cannot change either form on a replacement mount', async () => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go('/forgot-password');
  const oldRoot = document.querySelector<HTMLElement>('.auth-container')!;
  oldRoot.querySelector<HTMLInputElement>('#email')!.value = 'submitted@example.invalid';
  submit(oldRoot.querySelector('form')!);
  const oldHTML = oldRoot.innerHTML;
  go('/forgot-password');
  const currentHTML = document.querySelector('#app')!.innerHTML;

  pending.resolve(new Response(JSON.stringify({ success: true })));
  await settle();

  expect(document.querySelector('#app')!.innerHTML).toBe(currentHTML);
  expect(oldRoot.innerHTML).toBe(oldHTML);
  expect(window.location.hash).toBe('#/forgot-password');
});

it.each(['/other', '/unmatched', '/forgot-password', '/reset-password?token=replacement-token', '/reset-password?token=mounted-token'])('leaving after reset success cancels its two-second login navigation across %s', async destination => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))));
  go('/reset-password?token=mounted-token');
  document.querySelector<HTMLInputElement>('#password')!.value = 'submitted-password';
  submit(document.querySelector('#reset-form')!);
  await settle();
  expect(document.querySelector('#reset-msg')!.textContent).toBe('Password reset! You can now log in.');

  go(destination);
  const before = snapshot(document.querySelector<HTMLElement>('#app')!);
  await vi.advanceTimersByTimeAsync(2000);

  expect(window.location.hash).toBe(`#${destination}`);
  expect(snapshot(document.querySelector<HTMLElement>('#app')!)).toEqual(before);
});

it.each(flows)('live $kind captures input, serializes submissions, and preserves success behavior', async flow => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  go(flow.path);
  // Editing the URL without a router event must not change the mounted reset token.
  if (flow.kind === 'reset') window.history.replaceState(null, '', '#/reset-password?token=later-token');
  begin(flow);
  const form = document.querySelector('form')!;
  const button = form.querySelector('button')!;
  expect(button.disabled).toBe(true);
  document.querySelector<HTMLInputElement>(`#${flow.input}`)!.value = 'edited-after-submit';
  submit(form);
  submit(form);
  expect(network).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledWith(flow.endpoint, expect.objectContaining({
    method: 'POST', body: JSON.stringify(flow.payload), credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  }));
  pending.resolve(new Response(JSON.stringify({ success: true })));
  await settle();
  const message = document.querySelector(`#${flow.kind}-msg`)!;
  expect(message.textContent).toBe(flow.success);
  expect(message.classList.contains('hidden')).toBe(false);
  expect(document.querySelector<HTMLInputElement>(`#${flow.input}`)!.value).toBe('edited-after-submit');
  expect(button.disabled).toBe(flow.kind === 'reset');
  if (flow.kind === 'reset') {
    submit(form);
    expect(network).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(window.location.hash).toBe('#/reset-password?token=later-token');
    await vi.advanceTimersByTimeAsync(1);
    expect(window.location.hash).toBe('#/login');
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('#login-form')).not.toBeNull();
  } else {
    network.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
    submit(form);
    await settle();
    expect(network).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(window.location.hash).toBe('#/forgot-password');
  }
});

const failures = [
  { name: 'HTTP error text', response: () => new Response(JSON.stringify({ error: '<b>Try again</b>' }), { status: 400 }), message: '<b>Try again</b>' },
  { name: 'unexpected HTML', response: () => new Response(html, { headers: { 'Content-Type': 'text/html' } }), message: 'The server returned an unexpected response (HTTP 200). Please try again.' },
  { name: 'empty HTTP error', response: () => new Response('{}', { status: 503 }), message: 'Request failed (HTTP 503). Please try again.' },
] as const;

it.each(flows.flatMap(flow => failures.map(failure => ({ flow, kind: flow.kind, ...failure }))))('live $kind shows readable $name and permits retry', async ({ flow, response, message }) => {
  const network = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
  vi.stubGlobal('fetch', network);
  go(flow.path);
  begin(flow);
  await settle();
  const error = document.querySelector(`#${flow.kind}-error`)!;
  expect(error.textContent).toBe(message);
  expect(error.children).toHaveLength(0);
  expect(error.classList.contains('hidden')).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(false);
  submit(document.querySelector('form')!);
  await settle();
  expect(network).toHaveBeenCalledTimes(2);
  expect(document.querySelector(`#${flow.kind}-msg`)!.textContent).toBe(flow.success);
  expect(document.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(flow.kind === 'reset');
  if (flow.kind === 'reset') expect(error.classList.contains('hidden')).toBe(true);
});

it.each(flows)('live $kind consumes a rejected fetch and enables retry', async flow => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  go(flow.path);
  begin(flow);
  pending.reject(new Error('Network offline'));
  await settle();
  expect(document.querySelector(`#${flow.kind}-error`)!.textContent).toBe('Network offline');
  expect(document.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(false);
  network.mockResolvedValueOnce(new Response(JSON.stringify({ success: true })));
  submit(document.querySelector('form')!);
  await settle();
  expect(network).toHaveBeenCalledTimes(2);
  expect(document.querySelector(`#${flow.kind}-msg`)!.textContent).toBe(flow.success);
});

it.each(['', 'invalid-token'])('reset sends missing or invalid token "%s" and displays the server error', async token => {
  const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid or expired reset token' }), { status: 400 }));
  vi.stubGlobal('fetch', network);
  go(token ? `/reset-password?token=${token}` : '/reset-password');
  begin(flows[1]);
  await settle();
  expect(network).toHaveBeenCalledWith('/api/auth/reset-password', expect.objectContaining({
    body: JSON.stringify({ token, password: 'submitted-password' }),
  }));
  expect(document.querySelector('#reset-error')!.textContent).toBe('Invalid or expired reset token');
  expect(document.querySelector('#reset-error')!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(false);
});

const departures = flows.flatMap(flow => (['success', 'failure', 'rejection'] as const).flatMap(outcome =>
  ['/other', '/unmatched', flow.path, flow.kind === 'forgot' ? flows[1].path : flows[0].path,
    ...(flow.kind === 'reset' ? ['/reset-password?token=replacement-token'] : [])]
    .map(destination => ({ flow, kind: flow.kind, outcome, destination }))));

it.each(departures)('departed $kind $outcome leaves both roots untouched across $destination', async ({ flow, outcome, destination }) => {
  const pending = deferred<Response>();
  const currentRequest = deferred<Response>();
  const network = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValue(currentRequest.promise);
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const oldRoot = document.querySelector<HTMLElement>('.auth-container')!;
  begin(flow);
  const oldSnapshot = snapshot(oldRoot);
  go(destination);
  const currentFlow = flows.find(candidate => destination.startsWith(`/${candidate.kind === 'forgot' ? 'forgot' : 'reset'}-password`));
  if (currentFlow) {
    begin(currentFlow);
    document.querySelector<HTMLInputElement>(`#${currentFlow.input}`)!.value = 'replacement-draft';
    const message = document.querySelector(`#${currentFlow.kind}-error`)!;
    message.textContent = 'Replacement feedback';
    message.classList.remove('hidden');
  }
  const app = document.querySelector<HTMLElement>('#app')!;
  const currentSnapshot = snapshot(app);
  if (outcome === 'rejection') pending.reject(new Error('Departed network error'));
  else pending.resolve(new Response(JSON.stringify(outcome === 'success' ? { success: true } : { error: 'Departed failure' }), { status: outcome === 'success' ? 200 : 400 }));
  await settle();
  await vi.advanceTimersByTimeAsync(2000);
  expect(snapshot(app)).toEqual(currentSnapshot);
  expect(snapshot(oldRoot)).toEqual(oldSnapshot);
  expect(window.location.hash).toBe(`#${destination}`);
  expect(network).toHaveBeenCalledTimes(currentFlow ? 2 : 1);
  if (destination.includes('replacement-token')) {
    expect(network).toHaveBeenLastCalledWith('/api/auth/reset-password', expect.objectContaining({
      body: JSON.stringify({ token: 'replacement-token', password: 'submitted-password' }),
    }));
  }
  // Settle the replacement request too; do not leave work pending beyond the test.
  currentRequest.resolve(new Response(JSON.stringify({ success: true })));
  await settle();
});

it.each(flows)('router cleanup disables retained and reattached $kind forms', async flow => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const oldRoot = document.querySelector<HTMLElement>('.auth-container')!;
  const form = oldRoot.querySelector('form')!;
  go('/other');
  submit(form);
  oldRoot.id = 'retained';
  document.body.append(oldRoot);
  begin(flow, oldRoot);
  await settle();
  expect(network).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('#/other');
});

it.each(flows)('a reattached old $kind root before the app cannot steal a replacement mount', async flow => {
  const network = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ success: true }))));
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const oldRoot = document.querySelector<HTMLElement>('#app .auth-container')!;
  go('/other');
  oldRoot.id = 'retained';
  document.body.prepend(oldRoot);
  go(flow.path);
  const app = document.querySelector<HTMLElement>('#app')!;
  begin(flow, app);
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(app.querySelector(`#${flow.kind}-msg`)!.textContent).toBe(flow.success);
  begin(flow, oldRoot);
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(oldRoot.querySelector(`#${flow.kind}-msg`)!.classList.contains('hidden')).toBe(true);
});

it.each(flows.flatMap(flow => ['success', 'failure'].map(outcome => ({ flow, kind: flow.kind, outcome }))))('explicit $kind disposal is idempotent while connected and consumes pending $outcome', async ({ flow, outcome }) => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  // Static view markup with the public mount interface avoids introducing a test-only hook.
  go('/other');
  document.querySelector('#app')!.innerHTML = (flow.kind === 'forgot' ? forgotPasswordView() : resetPasswordView()).html;
  const root = document.querySelector<HTMLElement>('.auth-container')!;
  disposeSession = mountPasswordRecovery(root, flow.kind === 'forgot' ? { kind: 'forgot' } : { kind: 'reset', token: 'mounted-token' });
  begin(flow);
  const before = snapshot(root);
  disposeSession();
  disposeSession();
  expect(root.isConnected).toBe(true);
  submit(root.querySelector('form')!);
  root.remove();
  document.querySelector('#app')!.append(root);
  submit(root.querySelector('form')!);
  pending.resolve(new Response(JSON.stringify(outcome === 'success' ? { success: true } : { error: 'Disposed failure' }), { status: outcome === 'success' ? 200 : 400 }));
  await settle();
  await vi.advanceTimersByTimeAsync(2000);
  expect(snapshot(root)).toEqual(before);
  expect(network).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe('#/other');
});

it('explicit reset disposal cancels a redirect while its root remains connected', async () => {
  const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
  vi.stubGlobal('fetch', network);
  go('/other');
  document.querySelector('#app')!.innerHTML = resetPasswordView().html;
  const root = document.querySelector<HTMLElement>('.auth-container')!;
  disposeSession = mountPasswordRecovery(root, { kind: 'reset', token: 'mounted-token' });
  begin(flows[1]);
  await settle();
  await vi.advanceTimersByTimeAsync(1000);
  disposeSession();
  disposeSession();
  const before = snapshot(root);
  expect(root.isConnected).toBe(true);
  submit(root.querySelector('form')!);
  await vi.advanceTimersByTimeAsync(2000);
  expect(window.location.hash).toBe('#/other');
  expect(snapshot(root)).toEqual(before);
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(flows)('disconnected $kind roots cannot submit before router cleanup', async flow => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const root = document.querySelector<HTMLElement>('.auth-container')!;
  root.remove();
  begin(flow, root);
  await settle();
  expect(network).not.toHaveBeenCalled();
});

it.each(flows)('disconnected $kind roots consume pending results before router cleanup', async flow => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go(flow.path);
  const root = document.querySelector<HTMLElement>('.auth-container')!;
  begin(flow);
  const before = snapshot(root);
  root.remove();
  pending.resolve(new Response(JSON.stringify({ success: true })));
  await settle();
  document.querySelector('#app')!.append(root);
  await vi.advanceTimersByTimeAsync(2000);
  expect(snapshot(root)).toEqual(before);
  expect(window.location.hash).toBe(`#${flow.path}`);
});

it('a reset timer cannot navigate from a disconnected root before router cleanup', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))));
  go(flows[1].path);
  begin(flows[1]);
  await settle();
  document.querySelector('.auth-container')!.remove();
  await vi.advanceTimersByTimeAsync(2000);
  expect(window.location.hash).toBe(`#${flows[1].path}`);
});

it.each(flows)('a $kind form moved outside its connected root cannot submit', async flow => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go(flow.path);
  const form = document.querySelector('form')!;
  const retained = document.createElement('div');
  retained.id = 'retained';
  document.body.append(retained);
  retained.append(form);
  begin(flow, retained);
  await settle();
  expect(network).not.toHaveBeenCalled();
});

it.each(flows.flatMap(flow => [false, true].map(guest => ({ flow, kind: flow.kind, guest }))))('$kind remains remote with guest=$guest and does not publish authentication state', async ({ flow, guest }) => {
  setGuestMode(guest);
  const user = getGuestUser();
  state.user = user;
  setToken('existing-token');
  const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, user: { id: 999 }, token: 'unexpected-token' })));
  vi.stubGlobal('fetch', network);
  go(flow.path);
  begin(flow);
  await settle();
  expect(network).toHaveBeenCalledWith(flow.endpoint, expect.objectContaining({
    method: 'POST', body: JSON.stringify(flow.payload), credentials: 'include',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer existing-token' },
  }));
  expect(state.user).toBe(user);
  expect(getToken()).toBe('existing-token');
  expect(isGuestMode()).toBe(guest);
});

it.each(flows.flatMap(flow => [false, true].flatMap(guest => [false, true].map(departed => ({ flow, kind: flow.kind, guest, departed })))))('$kind keeps the global 401 redirect with guest=$guest and departed=$departed', async ({ flow, guest, departed }) => {
  setGuestMode(guest);
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go(flow.path);
  begin(flow);
  const root = document.querySelector<HTMLElement>('.auth-container')!;
  const before = snapshot(root);
  if (departed) go('/other');
  pending.resolve(new Response('{}', { status: 401 }));
  await settle();
  expect(window.location.hash).toBe('#/login');
  await settle();
  expect(document.querySelector('#login-form')).not.toBeNull();
  if (departed) expect(snapshot(root)).toEqual(before);
});

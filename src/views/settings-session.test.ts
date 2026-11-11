import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { auth } from '../api';
import { setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { state } from '../state';
import type { User } from '../types';
import { deferred } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { settingsView } from './settings';
import { mountSettingsForms } from './settings-form-session';

const settle = () => vi.advanceTimersByTimeAsync(0);
let disposeForms: (() => void) | undefined;

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function input(id: string, value: string, root: ParentNode = document) {
  root.querySelector<HTMLInputElement>(`#${id}`)!.value = value;
}

function submit(id: string, root: ParentNode = document) {
  root.querySelector(`#${id}`)!.dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/settings', settingsView);
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
  startRouter();
});

beforeEach(async () => {
  localStorage.clear();
  setGuestMode(true);
  state.user = (await auth.updateProfile({ currentWeightLbs: 200 })).user;
  setGuestMode(false);
  vi.useFakeTimers();
});

afterEach(() => {
  disposeForms?.();
  disposeForms = undefined;
  go('/other');
  state.user = null;
  document.querySelector('#retained')?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('a departed target save publishes user state without showing feedback on a replacement Settings mount', async () => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go('/settings');
  input('s-cal', '2100');
  submit('targets-form');
  const saved = { ...state.user!, targetCalories: 2100 };
  go('/other');
  go('/settings');
  input('s-cal', '2400');
  pending.resolve(new Response(JSON.stringify({ user: saved })));
  await settle();
  expect(state.user).toEqual(saved);
  expect(document.querySelector('#targets-msg')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector<HTMLInputElement>('#s-cal')!.value).toBe('2400');
});

const flows = [
  { name: 'profile', form: 'profile-form', message: 'profile-msg', success: 'Profile saved!',
    inputs: { 's-name': 'Alex', 's-height-ft': '5', 's-height-in': '11' },
    payload: { firstName: 'Alex', heightInches: 71 } },
  { name: 'rest targets', form: 'targets-form', message: 'targets-msg', success: 'Targets saved!',
    inputs: { 's-cal': '2100', 's-carbs': '200', 's-protein': '160', 's-fat': '70' },
    payload: { targetCalories: 2100, targetCarbsG: 200, targetProteinG: 160, targetFatG: 70 } },
  { name: 'workout targets', form: 'workout-targets-form', message: 'workout-targets-msg', success: 'Workout targets saved!',
    inputs: { 's-wcal': '2450', 's-wcarbs': '280', 's-wprotein': '175', 's-wfat': '75' },
    payload: { workoutTargetCalories: 2450, workoutTargetCarbsG: 280, workoutTargetProteinG: 175, workoutTargetFatG: 75 } },
  { name: 'preset', form: null, message: 'phase-presets-msg', success: 'Maintenance targets saved for rest and workout days!',
    inputs: {},
    payload: { targetCalories: 3000, targetCarbsG: 340, targetProteinG: 194, targetFatG: 96,
      workoutTargetCalories: 3300, workoutTargetCarbsG: 415, workoutTargetProteinG: 194, workoutTargetFatG: 96 } },
] satisfies { name: string; form: string | null; message: string; success: string; inputs: Record<string, string>; payload: Partial<User> }[];

function begin(flow: typeof flows[number], root: ParentNode = document) {
  for (const [id, value] of Object.entries(flow.inputs)) input(id, value!, root);
  if (flow.form) submit(flow.form, root);
  else root.querySelector<HTMLButtonElement>('#phase-maintenance')!.click();
}

it.each(['root', 'fixed replacement'])('Settings permanently retires on same-turn %s before router cleanup', async departure => {
  const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: state.user })));
  vi.stubGlobal('fetch', network);
  go('/settings');
  const root = document.querySelector<HTMLElement>('#app .page')!;
  departAndReconnect(root, departure, '#s-name');
  for (const flow of flows) begin(flow, root);
  input('s-current-pw', 'current', root);
  input('s-new-pw', 'new-password', root);
  const before = root.innerHTML;
  submit('password-form', root);
  await settle();
  expect(network).not.toHaveBeenCalled();
  expect(root.innerHTML).toBe(before);
});

it.each(['completion first', 'observer first'])('Settings consumes an accepted preset after ancestor retirement with %s', async order => {
  const pending = deferred<{ user: User }>();
  const request = vi.spyOn(auth, 'updateProfile').mockReturnValueOnce(pending.promise);
  go('/settings');
  const root = document.querySelector<HTMLElement>('#app .page')!;
  const original = state.user;
  const saved = { ...state.user!, ...flows[3].payload };
  begin(flows[3], root);
  await Promise.resolve();
  const before = root.innerHTML;
  const values = [...root.querySelectorAll('input')].map(control => control.value);
  if (order === 'completion first') pending.resolve({ user: saved });
  departAndReconnect(root, 'ancestor');
  if (order === 'observer first') {
    await Promise.resolve();
    pending.reject(new Error('Late preset failure'));
  }
  await settle();
  expect(root.innerHTML).toBe(before);
  expect([...root.querySelectorAll('input')].map(control => control.value)).toEqual(values);
  expect(state.user).toEqual(order === 'completion first' ? saved : original);
  expect(root.querySelector<HTMLButtonElement>('#phase-maintenance')!.disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('initially disconnected Settings forms stay retired and a fresh mount works', async () => {
  const network = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ user: state.user }))));
  vi.stubGlobal('fetch', network);
  go('/other');
  const holder = document.createElement('div');
  holder.innerHTML = settingsView().html;
  const root = holder.querySelector<HTMLElement>('.page')!;
  disposeForms = mountSettingsForms(root);
  document.querySelector('#app')!.append(root);
  for (const flow of flows) begin(flow, root);
  submit('password-form', root);
  await settle();
  expect(network).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  disposeForms();
  disposeForms();
  go('/settings');
  begin(flows[0]);
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(document.querySelector('#app #profile-msg')!.textContent).toBe('Profile saved!');
});

it('Settings initializes forms in the current outlet while an older screen stays connected before it', async () => {
  const network = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ user: state.user }))));
  vi.stubGlobal('fetch', network);
  const retained = document.createElement('div');
  retained.id = 'retained';
  retained.innerHTML = settingsView().html;
  document.body.prepend(retained);
  go('/settings');
  begin(flows[0], retained);
  expect(network).not.toHaveBeenCalled();
  const root = document.querySelector<HTMLElement>('#app .page')!;
  begin(flows[0], root);
  await settle();
  expect(network).toHaveBeenCalledTimes(1);
  expect(root.querySelector('#profile-msg')!.textContent).toBe('Profile saved!');
  expect(retained.querySelector('#profile-msg')!.textContent).toBe('');
  go('/other');
  expect(vi.getTimerCount()).toBe(0);
});

const completionCases = flows.flatMap(flow =>
  (['success', 'failure'] as const).flatMap(outcome =>
    ['/other', '/settings'].map(destination => ({ flow, name: flow.name, outcome, destination }))));

it.each(completionCases)('departed $name $outcome cannot mutate either mount across $destination', async ({ flow, outcome, destination }) => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  go('/settings');
  const original = state.user;
  const saved = { ...state.user!, ...flow.payload };
  begin(flow);
  expect(network).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
    method: 'PUT', body: JSON.stringify(flow.payload),
  }));
  const oldRoot = document.querySelector<HTMLElement>('.page')!;
  const oldHTML = oldRoot.innerHTML;
  const oldValues = [...oldRoot.querySelectorAll('input')].map(control => control.value);
  const oldButtons = [...oldRoot.querySelectorAll('button')].map(control => control.disabled);
  go(destination);
  // Give the replacement its own visible feedback and pending preset controls.
  if (destination === '/settings') {
    network.mockResolvedValueOnce(new Response(JSON.stringify({ user: { ...state.user!, firstName: 'Current profile' } })));
    submit('profile-form');
    await settle();
    input('s-name', 'New draft');
    input('s-cal', '2400');
    const newer = deferred<Response>();
    network.mockReturnValueOnce(newer.promise);
    document.querySelector<HTMLButtonElement>('#phase-mini-cut')!.click();
    // Keep the newer request pending until after checking the old completion.
    const completeNewer = () => newer.resolve(new Response(JSON.stringify({ user: saved })));
    const currentHTML = document.querySelector('#app')!.innerHTML;
    const currentValues = [...document.querySelectorAll('input')].map(control => control.value);
    const currentButtons = [...document.querySelectorAll('button')].map(control => control.disabled);
    const beforeCompletion = state.user;
    pending.resolve(new Response(JSON.stringify(outcome === 'success' ? { user: saved } : { error: 'Old failure' }), { status: outcome === 'success' ? 200 : 500 }));
    await settle();
    expect(state.user).toEqual(outcome === 'success' ? saved : beforeCompletion);
    expect(document.querySelector('#app')!.innerHTML).toBe(currentHTML);
    expect([...document.querySelectorAll('input')].map(control => control.value)).toEqual(currentValues);
    expect([...document.querySelectorAll('button')].map(control => control.disabled)).toEqual(currentButtons);
    completeNewer();
    await settle();
  } else {
    pending.resolve(new Response(JSON.stringify(outcome === 'success' ? { user: saved } : { error: 'Old failure' }), { status: outcome === 'success' ? 200 : 500 }));
    await settle();
    expect(state.user).toEqual(outcome === 'success' ? saved : original);
    expect(document.querySelector('#app')!.textContent).toBe('Other screen');
  }
  expect(oldRoot.innerHTML).toBe(oldHTML);
  expect([...oldRoot.querySelectorAll('input')].map(control => control.value)).toEqual(oldValues);
  expect([...oldRoot.querySelectorAll('button')].map(control => control.disabled)).toEqual(oldButtons);
});

it.each(flows)('guest $name persists submitted values and shows the existing message', async flow => {
  setGuestMode(true);
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  go('/settings');
  expect(document.querySelector('#password-form')).toBeNull();
  begin(flow);
  await settle();
  const saved = (await auth.me()).user;
  expect(saved).toMatchObject(flow.payload);
  expect(state.user).toEqual(saved);
  expect(document.querySelector(`#${flow.message}`)!.textContent).toBe(flow.success);
  expect(document.querySelector(`#${flow.message}`)!.className).toBe('form-success');
  go('/settings');
  for (const [id, value] of Object.entries(flow.inputs)) expect(document.querySelector<HTMLInputElement>(`#${id}`)!.value).toBe(value);
  expect(network).not.toHaveBeenCalled();
});

it.each(flows)('guest $name remains persisted when its completion outlives its mount', async flow => {
  setGuestMode(true);
  go('/settings');
  begin(flow);
  // Leave before the real guest adapter's promise continuation publishes.
  expect(state.user).not.toMatchObject(flow.payload);
  go('/settings');
  input('s-name', 'Fresh draft');
  input('s-cal', '2600');
  const html = document.querySelector('#app')!.innerHTML;
  await settle();
  expect((await auth.me()).user).toMatchObject(flow.payload);
  expect(state.user).toMatchObject(flow.payload);
  expect(document.querySelector('#app')!.innerHTML).toBe(html);
  expect(document.querySelector<HTMLInputElement>('#s-name')!.value).toBe('Fresh draft');
  expect(document.querySelector<HTMLInputElement>('#s-cal')!.value).toBe('2600');
});

it.each(flows)('a live $name HTTP failure preserves state and edits', async flow => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go('/settings');
  const original = state.user;
  begin(flow);
  const values = [...document.querySelectorAll('input')].map(control => control.value);
  pending.resolve(new Response(JSON.stringify({ error: 'Save failed' }), { status: 500 }));
  await settle();
  expect(state.user).toBe(original);
  expect(document.querySelector(`#${flow.message}`)!.className).toBe('form-error');
  expect(document.querySelector(`#${flow.message}`)!.textContent).toBe('Save failed');
  expect([...document.querySelectorAll('input')].map(control => control.value)).toEqual(values);
  expect([...document.querySelectorAll('button')].every(button => !button.disabled)).toBe(true);
});

it.each(flows)('a live $name HTTP save captures its payload and publishes the returned user', async flow => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  go('/settings');
  const saved = { ...state.user!, ...flow.payload };
  begin(flow);
  expect(network).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
    method: 'PUT', body: JSON.stringify(flow.payload), credentials: 'include',
  }));
  input('s-name', 'Later draft');
  pending.resolve(new Response(JSON.stringify({ user: saved })));
  await settle();
  expect(state.user).toEqual(saved);
  expect(document.querySelector(`#${flow.message}`)!.textContent).toBe(flow.success);
  expect(document.querySelector(`#${flow.message}`)!.className).toBe('form-success');
  expect([...document.querySelectorAll('button')].every(button => !button.disabled)).toBe(true);
  expect(document.querySelector<HTMLInputElement>('#s-name')!.value).toBe('Later draft');
});

it.each(['success', 'failure'] as const)('password %s uses captured values and stays within the live mount', async outcome => {
  const pending = deferred<Response>();
  const network = vi.fn(() => pending.promise);
  vi.stubGlobal('fetch', network);
  go('/settings');
  input('s-current-pw', 'current-password');
  input('s-new-pw', 'new-password');
  submit('password-form');
  input('s-current-pw', 'changed-current');
  input('s-new-pw', 'changed-new');
  expect(network).toHaveBeenCalledWith('/api/auth/change-password', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ currentPassword: 'current-password', newPassword: 'new-password' }),
  }));
  pending.resolve(new Response(JSON.stringify(outcome === 'success' ? { success: true } : { error: 'Wrong password' }), { status: outcome === 'success' ? 200 : 400 }));
  await settle();
  expect(document.querySelector('#pw-msg')!.className).toBe(outcome === 'success' ? 'form-success' : 'form-error');
  expect(document.querySelector('#pw-msg')!.textContent).toBe(outcome === 'success' ? 'Password changed!' : 'Wrong password');
  expect(document.querySelector<HTMLInputElement>('#s-current-pw')!.value).toBe(outcome === 'success' ? '' : 'changed-current');
  expect(document.querySelector<HTMLInputElement>('#s-new-pw')!.value).toBe(outcome === 'success' ? '' : 'changed-new');
});

it.each((['success', 'failure'] as const).flatMap(outcome =>
  ['/other', '/settings'].map(destination => ({ outcome, destination }))))('departed password $outcome cannot clear inputs or publish across $destination', async ({ outcome, destination }) => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  go('/settings');
  input('s-current-pw', 'original-current');
  input('s-new-pw', 'original-new');
  submit('password-form');
  const root = document.querySelector('.page')!;
  go(destination);
  if (destination === '/settings') {
    input('s-current-pw', 'fresh-current');
    input('s-new-pw', 'fresh-new');
  }
  const html = document.querySelector('#app')!.innerHTML;
  pending.resolve(new Response(JSON.stringify(outcome === 'success' ? { success: true } : { error: 'Old password failure' }), { status: outcome === 'success' ? 200 : 400 }));
  await settle();
  expect(document.querySelector('#app')!.innerHTML).toBe(html);
  expect(root.querySelector('#pw-msg')!.classList.contains('hidden')).toBe(true);
  expect(root.querySelector<HTMLInputElement>('#s-current-pw')!.value).toBe('original-current');
  expect(root.querySelector<HTMLInputElement>('#s-new-pw')!.value).toBe('original-new');
  if (destination === '/settings') {
    expect(document.querySelector<HTMLInputElement>('#s-current-pw')!.value).toBe('fresh-current');
    expect(document.querySelector<HTMLInputElement>('#s-new-pw')!.value).toBe('fresh-new');
  }
});

it('each message lasts three seconds after its latest publication with independent timers', async () => {
  setGuestMode(true);
  go('/settings');
  submit('profile-form');
  await settle();
  await vi.advanceTimersByTimeAsync(1000);
  submit('targets-form');
  await settle();
  await vi.advanceTimersByTimeAsync(1000);
  submit('profile-form');
  await settle();
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector('#profile-msg')!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#targets-msg')!.classList.contains('hidden')).toBe(false);
  await vi.advanceTimersByTimeAsync(999);
  expect(document.querySelector('#profile-msg')!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#targets-msg')!.classList.contains('hidden')).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelector('#profile-msg')!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#targets-msg')!.classList.contains('hidden')).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector('#profile-msg')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector('#targets-msg')!.classList.contains('hidden')).toBe(true);
});

it.each(['disposed', 'disconnected', 'route departure'] as const)('retained controls cannot start any form action after %s', async lifetime => {
  const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: state.user })));
  vi.stubGlobal('fetch', network);
  let root: HTMLElement;
  if (lifetime === 'disposed') {
    document.querySelector('#app')!.innerHTML = settingsView().html;
    root = document.querySelector<HTMLElement>('.page')!;
    disposeForms = mountSettingsForms(root);
    disposeForms();
    disposeForms();
    expect(root.isConnected).toBe(true);
  } else {
    go('/settings');
    root = document.querySelector<HTMLElement>('.page')!;
    if (lifetime === 'disconnected') root.remove();
    else {
      go('/other');
      document.querySelector('#app')!.append(root);
    }
  }
  for (const flow of flows) begin(flow, root);
  input('s-current-pw', 'old-current', root);
  input('s-new-pw', 'old-new', root);
  submit('password-form', root);
  await settle();
  expect(network).not.toHaveBeenCalled();
});

it.each(['route', 'ancestor'])('%s retirement clears every feedback timer without changing retained messages', async departure => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('change-password') ? { success: true } : { user: state.user }))));
  go('/settings');
  for (const flow of flows) {
    begin(flow);
    await settle();
  }
  submit('password-form');
  await settle();
  const root = document.querySelector<HTMLElement>('.page')!;
  for (const message of [...flows.map(flow => flow.message), 'pw-msg']) {
    expect(root.querySelector(`#${message}`)!.classList.contains('hidden')).toBe(false);
  }
  if (departure === 'route') go('/other');
  else {
    departAndReconnect(root, 'ancestor');
    await Promise.resolve();
  }
  expect(vi.getTimerCount()).toBe(0);
  const html = root.innerHTML;
  await vi.advanceTimersByTimeAsync(5000);
  expect(root.innerHTML).toBe(html);
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auth } from '../api';
import { setGuestMode } from '../local-db';
import { state } from '../state';
import { settingsView } from './settings';

beforeEach(async () => {
  localStorage.clear();
  setGuestMode(true);
  state.user = (await auth.updateProfile({ currentWeightLbs: 200 })).user;
});

afterEach(() => {
  document.body.innerHTML = '';
  state.user = null;
  vi.unstubAllGlobals();
});

function showSettings() {
  const view = settingsView();
  document.body.innerHTML = view.html;
  view.init();
}

function targetInputs() {
  return ['s-cal', 's-carbs', 's-protein', 's-fat', 's-wcal', 's-wcarbs', 's-wprotein', 's-wfat']
    .map(id => document.getElementById(id) as HTMLInputElement);
}

it.each([
  { label: 'Lean Gain', targets: {
    targetCalories: 3252, targetCarbsG: 388, targetProteinG: 200, targetFatG: 100,
    workoutTargetCalories: 3552, workoutTargetCarbsG: 463, workoutTargetProteinG: 200, workoutTargetFatG: 100,
  } },
  { label: 'Maintenance', targets: {
    targetCalories: 3000, targetCarbsG: 340, targetProteinG: 194, targetFatG: 96,
    workoutTargetCalories: 3300, workoutTargetCarbsG: 415, workoutTargetProteinG: 194, workoutTargetFatG: 96,
  } },
  { label: 'Mini-Cut', targets: {
    targetCalories: 2620, targetCarbsG: 254, targetProteinG: 212, targetFatG: 84,
    workoutTargetCalories: 2872, workoutTargetCarbsG: 317, workoutTargetProteinG: 212, workoutTargetFatG: 84,
  } },
])('applies $label to both target forms and saves it using the current weight', async ({ label, targets }) => {
  showSettings();
  const strip = document.querySelector('#phase-presets');
  expect(strip).not.toBeNull();
  const buttons = [...strip!.querySelectorAll('button')];
  expect(buttons.map(button => button.textContent)).toEqual(['Lean Gain', 'Maintenance', 'Mini-Cut']);
  expect(strip!.compareDocumentPosition(document.querySelector('#targets-form')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  buttons.find(button => button.textContent === label)!.click();
  await vi.waitFor(() => expect(document.querySelector('#phase-presets-msg')?.textContent).toContain('saved'));
  expect(targetInputs().map(input => Number(input.value))).toEqual(Object.values(targets));
  const saved = (await auth.me()).user;
  expect(saved).toMatchObject({ currentWeightLbs: 200, ...targets });
  expect(state.user).toEqual(saved);
  showSettings();
  expect(targetInputs().map(input => Number(input.value))).toEqual(Object.values(targets));
});

it('uses the default weight for a guest without a saved weight', async () => {
  state.user = (await auth.updateProfile({ currentWeightLbs: 0 })).user;
  showSettings();
  document.querySelector<HTMLButtonElement>('#phase-lean-gain')!.click();
  await vi.waitFor(() => expect(state.user?.targetCalories).toBe(2600));
  expect(targetInputs().map(input => Number(input.value))).toEqual([2600, 310, 160, 80, 2900, 385, 160, 80]);
});

it('saves all eight targets in one request and prevents overlapping preset clicks', async () => {
  setGuestMode(false);
  const saved = { ...state.user!,
    targetCalories: 3000, targetCarbsG: 340, targetProteinG: 194, targetFatG: 96,
    workoutTargetCalories: 3300, workoutTargetCarbsG: 415, workoutTargetProteinG: 194, workoutTargetFatG: 96,
  };
  let respond!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  showSettings();
  document.querySelector<HTMLButtonElement>('#phase-maintenance')!.click();
  const saveButtons = [...document.querySelectorAll<HTMLButtonElement>('#phase-presets button, #targets-form button, #workout-targets-form button')];
  expect(saveButtons.every(button => button.disabled)).toBe(true);
  document.querySelector<HTMLButtonElement>('#phase-mini-cut')!.click();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
    method: 'PUT',
    body: JSON.stringify({
      targetCalories: 3000, targetCarbsG: 340, targetProteinG: 194, targetFatG: 96,
      workoutTargetCalories: 3300, workoutTargetCarbsG: 415, workoutTargetProteinG: 194, workoutTargetFatG: 96,
    }),
  }));
  respond(new Response(JSON.stringify({ user: saved })));
  await vi.waitFor(() => expect(document.querySelector('#phase-presets-msg')?.textContent).toContain('Maintenance targets saved'));
  expect(state.user).toEqual(saved);
  expect(targetInputs().map(input => Number(input.value))).toEqual([3000, 340, 194, 96, 3300, 415, 194, 96]);
  expect(saveButtons.every(button => !button.disabled)).toBe(true);
});

it('reports a failed save and leaves the current targets editable', async () => {
  setGuestMode(false);
  const original = state.user;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Update failed' }), { status: 500 })));
  showSettings();
  const before = targetInputs().map(input => input.value);
  document.querySelector<HTMLButtonElement>('#phase-mini-cut')!.click();
  await vi.waitFor(() => expect(document.querySelector('#phase-presets-msg.form-error')?.textContent).toBe('Update failed'));
  expect(state.user).toEqual(original);
  expect(targetInputs().map(input => input.value)).toEqual(before);
  expect([...document.querySelectorAll<HTMLButtonElement>('#phase-presets button, #targets-form button, #workout-targets-form button')].every(button => !button.disabled)).toBe(true);
});

it('updates user state when a preset finishes saving after leaving Settings', async () => {
  setGuestMode(false);
  const saved = { ...state.user!, targetCalories: 3252, workoutTargetCalories: 3552 };
  let respond!: (response: Response) => void;
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  showSettings();
  document.querySelector<HTMLButtonElement>('#phase-lean-gain')!.click();
  document.body.innerHTML = '<p>Another view</p>';
  respond(new Response(JSON.stringify({ user: saved })));
  await vi.waitFor(() => expect(state.user).toEqual(saved));
  expect(document.body.textContent).toBe('Another view');
});

it('allows both target forms to be edited and saved after applying a preset', async () => {
  showSettings();
  document.querySelector<HTMLButtonElement>('#phase-lean-gain')!.click();
  await vi.waitFor(() => expect(state.user?.targetCalories).toBe(3252));
  targetInputs().forEach((input, index) => { input.value = String([2100, 200, 160, 70, 2450, 280, 175, 75][index]); });
  document.querySelector('#targets-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(state.user?.targetCalories).toBe(2100));
  document.querySelector('#workout-targets-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(state.user?.workoutTargetCalories).toBe(2450));
  expect((await auth.me()).user).toMatchObject({
    targetCalories: 2100, targetCarbsG: 200, targetProteinG: 160, targetFatG: 70,
    workoutTargetCalories: 2450, workoutTargetCarbsG: 280, workoutTargetProteinG: 175, workoutTargetFatG: 75,
  });
});

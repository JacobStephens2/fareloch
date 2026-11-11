import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { meals, workoutDays } from '../api';
import { route, startRouter } from '../router';
import { state } from '../state';
import type { MealLog, User } from '../types';
import { dashboardView } from './dashboard';
import { meal } from '../test/meal-list-fixtures';

vi.mock('../api', () => ({
  meals: { getByDate: vi.fn(), update: vi.fn(), delete: vi.fn(), copy: vi.fn() },
  workoutDays: { get: vi.fn(), set: vi.fn() },
  dailyChecks: { get: async () => ({ checks: [] }), set: vi.fn() },
}));

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}


beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/', dashboardView);
  route('/other', () => ({ html: '<p>Other view</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  localStorage.clear();
  state.user = null;
  state.selectedDate = '2026-04-01';
  vi.mocked(workoutDays.get).mockReset();
  vi.mocked(workoutDays.set).mockReset().mockResolvedValue({ isWorkoutDay: false });
  vi.mocked(meals.getByDate).mockReset();
  vi.mocked(meals.copy).mockReset().mockResolvedValue({ copied: 1 });
  vi.mocked(meals.update).mockReset().mockResolvedValue({ meal: meal() });
  vi.mocked(meals.delete).mockReset().mockResolvedValue({ success: true });
  vi.mocked(workoutDays.get).mockResolvedValue({ isWorkoutDay: false });
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [] });
  go('/other');
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function button(id: string) {
  return document.querySelector<HTMLButtonElement>(`#${id}`)!;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function useTargets() {
  const user: User = {
    id: 1, email: 'a@example.com', firstName: 'A', emailVerified: true,
    heightInches: 70, currentWeightLbs: 170, targetWaistInches: null,
    targetCalories: 2000, targetCarbsG: 250, targetProteinG: 150, targetFatG: 60,
    workoutTargetCalories: 2400, workoutTargetCarbsG: 290,
    workoutTargetProteinG: 170, workoutTargetFatG: 80,
  };
  state.user = user;
  return user;
}

function toggleWorkout() {
  document.querySelector<HTMLInputElement>('#workout-toggle')!.click();
}

function tap(item = document.querySelector<HTMLElement>('.meal-item')!) {
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 10 }));
}

function swipe() {
  const item = document.querySelector<HTMLElement>('.meal-item')!;
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 50, clientY: 10 }));
}

function leaveSelection(how: 'date' | 'return' | 'remount') {
  if (how === 'remount') {
    go('/other');
    go('/');
  } else {
    button('date-prev').click();
    if (how === 'return') button('date-next').click();
  }
}

it.each(['date', 'return', 'remount'] as const)('ignores older meal successes and failures after %s navigation', async how => {
  for (const outcome of ['success', 'failure']) {
    go('/other');
    state.selectedDate = '2026-04-01';
    const old = deferred<{ meals: MealLog[] }>();
    vi.mocked(meals.getByDate).mockReturnValueOnce(old.promise)
      .mockResolvedValue({ meals: [meal({ id: 2, food_name: 'Current', calories: 400 })] });
    go('/');
    leaveSelection(how);
    await settle();
    if (outcome === 'success') old.resolve({ meals: [meal({ food_name: 'Old' })] });
    else old.reject(new Error('old failure'));
    await settle();
    expect(document.querySelector('.meal-item-name')!.textContent).toContain('Current');
    expect(document.querySelectorAll('.meal-section')).toHaveLength(4);
    expect(document.querySelector('#cal-value')!.textContent).toBe('400');
  }
});

it.each(['date', 'return', 'remount'] as const)('ignores older workout successes and failures after %s navigation', async how => {
  useTargets();
  for (const outcome of ['success', 'failure']) {
    go('/other');
    state.selectedDate = '2026-04-01';
    const old = deferred<{ isWorkoutDay: boolean }>();
    const currentFlag = outcome === 'failure';
    vi.mocked(workoutDays.get).mockReturnValueOnce(old.promise)
      .mockResolvedValue({ isWorkoutDay: currentFlag });
    vi.mocked(meals.getByDate).mockResolvedValue({ meals: [meal({ calories: 400 })] });
    go('/');
    leaveSelection(how);
    await settle();
    if (outcome === 'success') old.resolve({ isWorkoutDay: true });
    else old.reject(new Error('old workout failure'));
    await settle();
    expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(currentFlag);
    expect(document.querySelector('#carbs-value')!.textContent).toBe(`20 / ${currentFlag ? 290 : 250}g`);
    expect(document.querySelector('.meal-subtotal')!.textContent).toBe(`400 / ${currentFlag ? 600 : 500} kcal`);
  }
});

it('renders cached workout state on returning to a date and drops that cache on remount', async () => {
  useTargets();
  vi.mocked(workoutDays.get).mockResolvedValueOnce({ isWorkoutDay: true });
  go('/');
  await settle();
  button('date-prev').click();
  await settle();
  expect(document.querySelector('#carbs-value')!.textContent).toBe('0 / 250g');
  vi.mocked(workoutDays.get).mockReturnValue(new Promise(() => {}));
  button('date-next').click();
  expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(true);
  expect(document.querySelector('#carbs-value')!.textContent).toBe('0 / 290g');
  leaveSelection('remount');
  expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(false);
  expect(document.querySelector('#carbs-value')!.textContent).toBe('0 / 250g');
});

it('workout toggle supersedes a pending read and keeps optimistic targets when its write fails', async () => {
  useTargets();
  const read = deferred<{ isWorkoutDay: boolean }>();
  const write = deferred<{ isWorkoutDay: boolean }>();
  vi.mocked(workoutDays.get).mockReturnValueOnce(read.promise);
  vi.mocked(workoutDays.set).mockReturnValueOnce(write.promise);
  await showMealItem(meal());
  button('date-prev').click();
  toggleWorkout();
  expect(document.querySelector('#cal-value')!.textContent).toBe('0');
  expect(document.querySelector('#carbs-value')!.textContent).toBe('0 / 290g');
  expect(document.querySelector('.meal-subtotal')!.textContent).toBe('0 / 600 kcal');
  expect(workoutDays.set).toHaveBeenCalledWith('2026-03-31', true);
  read.resolve({ isWorkoutDay: false });
  write.reject(new Error('save failed'));
  await settle();
  expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(true);
  expect(document.querySelector('#carbs-value')!.textContent).toBe('20 / 290g');
});

it('ignores a same-selection workout read begun before a toggle', async () => {
  useTargets();
  const read = deferred<{ isWorkoutDay: boolean }>();
  vi.mocked(workoutDays.get).mockReturnValueOnce(read.promise);
  await showMealItem(meal());
  toggleWorkout();
  read.resolve({ isWorkoutDay: false });
  await settle();
  expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(true);
  expect(document.querySelector('#carbs-value')!.textContent).toBe('20 / 290g');
});

it.each(['during', 'after'] as const)('protects optimistic state from a returning-date read settled %s multiple writes', async when => {
  useTargets();
  const first = deferred<{ isWorkoutDay: boolean }>();
  const second = deferred<{ isWorkoutDay: boolean }>();
  vi.mocked(workoutDays.set).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  go('/');
  await settle();
  toggleWorkout();
  toggleWorkout();
  button('date-prev').click();
  await settle();
  const read = deferred<{ isWorkoutDay: boolean }>();
  vi.mocked(workoutDays.get).mockReturnValueOnce(read.promise);
  button('date-next').click();
  first.resolve({ isWorkoutDay: true });
  if (when === 'after') second.resolve({ isWorkoutDay: true });
  await settle();
  read.resolve({ isWorkoutDay: true });
  await settle();
  expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(false);
  expect(document.querySelector('#carbs-value')!.textContent).toBe('0 / 250g');
  second.resolve({ isWorkoutDay: true });
  await settle();
});

it('uses existing target fallbacks and never waits for workout reads to show meals', async () => {
  const user = useTargets();
  user.workoutTargetCalories = user.workoutTargetCarbsG = user.workoutTargetProteinG = user.workoutTargetFatG = 0;
  vi.mocked(workoutDays.get).mockReturnValue(new Promise(() => {}));
  await showMealItem(meal());
  toggleWorkout();
  expect(document.querySelector('#carbs-value')!.textContent).toBe('20 / 250g');
  expect(document.querySelector('.meal-subtotal')!.textContent).toBe('200 / 500 kcal');
  user.targetCalories = user.targetCarbsG = user.targetProteinG = user.targetFatG = 0;
  toggleWorkout();
  expect(document.querySelector('#carbs-value')!.textContent).toBe('20 / 340g');
  toggleWorkout();
  expect(document.querySelector('#carbs-value')!.textContent).toBe('20 / 380g');
});

it.each(['date', 'return', 'remount'] as const)('copy completion after %s navigation keeps its dates and suppresses old feedback', async how => {
  for (const outcome of ['success', 'failure']) {
    go('/other');
    state.selectedDate = '2026-04-01';
    const copy = deferred<{ copied: number }>();
    vi.mocked(meals.copy).mockReturnValueOnce(copy.promise);
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(true);
    go('/');
    await settle();
    button('copy-prev-btn').click();
    expect(confirmation).toHaveBeenCalledWith('Copy all meals from Tue, Mar 31 to Wed, Apr 1?');
    expect(meals.copy).toHaveBeenLastCalledWith('2026-03-31', '2026-04-01');
    leaveSelection(how);
    expect(button('copy-prev-btn').disabled).toBe(how !== 'remount');
    await settle();
    const reads = vi.mocked(meals.getByDate).mock.calls.length;
    if (outcome === 'success') copy.resolve({ copied: 3 });
    else copy.reject(new Error('copy failed'));
    await settle();
    expect(button('copy-prev-btn').disabled).toBe(false);
    expect(button('copy-prev-btn').textContent).toBe('Copy Previous Day');
    expect(meals.getByDate).toHaveBeenCalledTimes(reads);
  }
});

it.each(['success', 'failure'])('preserves normal copy %s feedback and resets it after two seconds', async outcome => {
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
  go('/');
  await settle();
  button('copy-prev-btn').click();
  expect(meals.copy).not.toHaveBeenCalled();
  confirmation.mockReturnValue(true);
  if (outcome === 'failure') vi.mocked(meals.copy).mockRejectedValueOnce(new Error('copy failed'));
  vi.useFakeTimers();
  button('copy-prev-btn').click();
  await settle();
  expect(button('copy-prev-btn').disabled).toBe(true);
  expect(button('copy-prev-btn').textContent).toBe(outcome === 'success' ? 'Copied 1 items!' : 'No meals to copy');
  await vi.advanceTimersByTimeAsync(2000);
  expect(button('copy-prev-btn').textContent).toBe('Copy Previous Day');
  expect(button('copy-prev-btn').disabled).toBe(false);
});

it.each(['success', 'failure'])('a newer same-date refresh supersedes an older meal %s', async outcome => {
  await openEditMealModal(meal());
  const old = deferred<{ meals: MealLog[] }>();
  vi.mocked(meals.getByDate).mockReturnValueOnce(old.promise)
    .mockResolvedValue({ meals: [meal({ food_name: 'Latest', calories: 333.3 })] });
  button('edit-save-btn').click();
  await settle();
  expect(document.querySelector('#cal-value')!.textContent).toBe('200');
  tap();
  button('edit-save-btn').click();
  await settle();
  if (outcome === 'success') old.resolve({ meals: [meal({ food_name: 'Older' })] });
  else old.reject(new Error('older refresh failed'));
  await settle();
  expect(document.querySelector('.meal-item-name')!.textContent).toContain('Latest');
  expect(document.querySelector('#cal-value')!.textContent).toBe('333');
  expect(document.querySelectorAll('.meal-section')).toHaveLength(4);
});

it.each(['food', 'quick', 'delete'] as const)('%s completion cannot change a later selection or modal', async action => {
  for (const how of ['date', 'return', 'remount'] as const) {
    for (const outcome of ['success', 'failure']) {
      go('/other');
      state.selectedDate = '2026-04-01';
      await openEditMealModal(meal({ food_id: action === 'quick' ? null : 1 }));
      const write = deferred<{ meal: MealLog; success: boolean }>();
      if (action === 'delete') {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.mocked(meals.delete).mockReturnValueOnce(write.promise);
      } else vi.mocked(meals.update).mockReturnValueOnce(write.promise);
      button(action === 'delete' ? 'edit-delete-btn' : 'edit-save-btn').click();
      if (action === 'delete') {
        expect(window.confirm).toHaveBeenLastCalledWith('Remove this entry?');
        expect(meals.delete).toHaveBeenLastCalledWith(1);
      } else expect(vi.mocked(meals.update).mock.lastCall?.[0]).toBe(1);
      vi.mocked(meals.getByDate).mockResolvedValue({ meals: [meal({ id: 2, food_name: 'New selection' })] });
      leaveSelection(how);
      expect(document.querySelector('#edit-meal-modal')!.classList.contains('hidden')).toBe(true);
      await settle();
      tap();
      const reads = vi.mocked(meals.getByDate).mock.calls.length;
      if (outcome === 'success') write.resolve({ meal: meal(), success: true });
      else write.reject(new Error('old write failed'));
      await settle();
      expect(document.querySelector('#edit-meal-modal')!.classList.contains('hidden')).toBe(false);
      expect(document.querySelector('#edit-meal-name')!.textContent).toBe('New selection');
      expect(button('edit-save-btn').textContent).toBe('Save');
      expect(button('edit-save-btn').disabled).toBe(false);
      expect(meals.getByDate).toHaveBeenCalledTimes(reads);
    }
  }
});

it('modal delete preserves confirmation and refreshes the current date', async () => {
  const confirmDelete = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await openEditMealModal(meal());
  button('edit-delete-btn').click();
  expect(meals.delete).not.toHaveBeenCalled();
  confirmDelete.mockReturnValue(true);
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [] });
  button('edit-delete-btn').click();
  await settle();
  expect(document.querySelector('.meal-item')).toBeNull();
  expect(document.querySelector('#cal-value')!.textContent).toBe('0');
});

it.each(['date', 'return', 'remount'] as const)('swipe completion after %s navigation cannot animate or refresh another selection', async how => {
  const write = deferred<{ success: boolean }>();
  vi.mocked(meals.delete).mockReturnValueOnce(write.promise);
  await showMealItem(meal());
  vi.useFakeTimers();
  swipe();
  expect(meals.delete).toHaveBeenCalledWith(1);
  leaveSelection(how);
  await settle();
  const reads = vi.mocked(meals.getByDate).mock.calls.length;
  write.resolve({ success: true });
  await settle();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(meals.getByDate).toHaveBeenCalledTimes(reads);
  expect(document.querySelector('.meal-item-wrapper')!.getAttribute('style')).toBeNull();
});

it.each(['rerender', 'date', 'remount'] as const)('interrupts unfinished tap and swipe gestures on %s', async replacement => {
  for (const move of [false, true]) {
    go('/other');
    const item = await showMealItem(meal());
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 10 }));
    if (move) document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 10 }));
    if (replacement === 'rerender') toggleWorkout();
    else leaveSelection(replacement);
    await settle();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: move ? 50 : 200, clientY: 10 }));
    expect(meals.delete).not.toHaveBeenCalled();
    expect(document.querySelector('#edit-meal-modal')!.classList.contains('hidden')).toBe(true);
  }
});

it.each(['date', 'remount'] as const)('releases swipe timers, frames and the temporary picker on %s', async how => {
  await showMealItem(meal());
  button('date-label').click();
  const picker = document.querySelector<HTMLInputElement>('input[type="date"]')!;
  vi.useFakeTimers();
  swipe();
  await settle();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  leaveSelection(how);
  await settle();
  expect(vi.getTimerCount()).toBe(0);
  expect(picker.isConnected).toBe(false);
  const date = state.selectedDate;
  picker.value = '2025-01-01';
  picker.dispatchEvent(new Event('change'));
  expect(state.selectedDate).toBe(date);
});

it('successful swipe refreshes through the selected date session after 300 ms', async () => {
  await showMealItem(meal());
  vi.useFakeTimers();
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [] });
  swipe();
  await settle();
  const reads = vi.mocked(meals.getByDate).mock.calls.length;
  await vi.advanceTimersByTimeAsync(299);
  expect(meals.getByDate).toHaveBeenCalledTimes(reads);
  await vi.advanceTimersByTimeAsync(1);
  expect(meals.getByDate).toHaveBeenLastCalledWith('2026-04-01');
  expect(document.querySelector('.meal-item')).toBeNull();
  expect(document.querySelector('#cal-value')!.textContent).toBe('0');
});

it('date selection immediately clears meals and Macros and gives Add Food the selected date', async () => {
  await showMealItem(meal());
  const pending = deferred<{ meals: MealLog[] }>();
  vi.mocked(meals.getByDate).mockReturnValueOnce(pending.promise);
  button('date-prev').click();
  expect(button('date-label').textContent).toBe('Tue, Mar 31');
  expect(document.querySelector('.meal-item')).toBeNull();
  expect(document.querySelector('#cal-value')!.textContent).toBe('0');
  expect([...document.querySelectorAll<HTMLElement>('.btn-add-meal')].map(el => el.dataset.date))
    .toEqual(['2026-03-31', '2026-03-31', '2026-03-31', '2026-03-31']);
  pending.resolve({ meals: [meal({ id: 2, food_name: 'Pear', calories: 300 })] });
  await settle();
  expect(document.querySelector('.meal-item-name')!.textContent).toContain('Pear');
  expect(document.querySelector('#cal-value')!.textContent).toBe('300');
});

it.each(['breakfast', 'lunch', 'dinner', 'snack'])('Add Food navigates with captured %s and the selected date', async type => {
  await showMealItem(meal());
  button('date-prev').click();
  document.querySelector<HTMLButtonElement>(`.btn-add-meal[data-meal-type="${type}"]`)!.click();
  expect(window.location.hash).toBe(`#/log?meal=${type}&date=2026-03-31`);
});

async function showMealItem(entry: MealLog): Promise<HTMLElement> {
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [entry] });
  go('/');
  await vi.waitFor(() => {
    expect(document.querySelector('.meal-item')).toBeTruthy();
  });
  return document.querySelector<HTMLElement>('.meal-item')!;
}

async function openEditMealModal(entry: MealLog): Promise<Element> {
  const item = await showMealItem(entry);
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 10, clientY: 10 }));

  const modal = document.querySelector('#edit-meal-modal')!;
  expect(modal.classList.contains('hidden')).toBe(false);
  return modal;
}


it('dashboard legend explains the calorie and protein thresholds and the protein highlight', () => {
  const legend = document.createElement('div');
  legend.innerHTML = dashboardView().html;
  const descriptions = [...legend.querySelectorAll('.dashboard-legend p')].map(p => p.textContent);
  expect(descriptions).toEqual([
    ' On track - both calories and protein reach 85%+ of per-meal targets (daily / 4)',
    ' Partial - either calories or protein reaches 50%+, but not both reach 85%',
    ' Low - both calories and protein are under 50% of per-meal targets',
    'Outlined protein chip - protein reaches 85%+ of its per-meal target',
  ]);
});

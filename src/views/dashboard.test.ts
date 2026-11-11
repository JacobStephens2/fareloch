import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { meals, workoutDays } from '../api';
import { route, startRouter } from '../router';
import { state } from '../state';
import type { MealLog, User } from '../types';
import { dashboardView } from './dashboard';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';

vi.mock('../api', () => ({
  meals: { getByDate: vi.fn(), update: vi.fn(), delete: vi.fn(), copy: vi.fn() },
  workoutDays: { get: vi.fn(), set: vi.fn() },
  dailyChecks: { get: async () => ({ checks: [] }), set: vi.fn() },
}));

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function meal(overrides: Partial<MealLog> = {}): MealLog {
  return {
    id: 1,
    user_id: 1,
    date: '2026-04-01',
    meal_type: 'breakfast',
    food_id: 1,
    recipe_id: null,
    servings: 2,
    calories: 200,
    carbs_g: 20,
    protein_g: 10,
    fat_g: 8,
    note: null,
    food_name: 'Apple',
    food_brand: null,
    serving_size: 100,
    serving_unit: 'g',
    unit_label: null,
    unit_scale: 1,
    created_at: null,
    recipe_name: null,
    ...overrides,
  };
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

it.each(['root', 'fixed replacement'])('Dashboard permanently retires on same-turn %s before router cleanup', async departure => {
  await openEditMealModal(meal());
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  departAndReconnect(root, departure, '#workout-toggle');
  const before = root.innerHTML;
  const reads = vi.mocked(meals.getByDate).mock.calls.length;
  button('edit-serv-plus').click();
  button('edit-save-btn').click();
  button('edit-delete-btn').click();
  button('edit-modal-close').click();
  button('date-label').click();
  button('date-prev').click();
  button('copy-prev-btn').click();
  await settle();
  expect(root.innerHTML).toBe(before);
  expect(state.selectedDate).toBe('2026-04-01');
  expect(document.querySelector('body > input[type="date"]')).toBeNull();
  expect(meals.getByDate).toHaveBeenCalledTimes(reads);
  expect(meals.update).not.toHaveBeenCalled();
  expect(meals.delete).not.toHaveBeenCalled();
  expect(meals.copy).not.toHaveBeenCalled();
});

it.each(['edit-serv-minus', 'edit-serv-plus', 'edit-modal-close', 'date-label'])(
  '%s checks retirement before its first view effect', async action => {
    await openEditMealModal(meal());
    const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
    const quantity = root.querySelector<HTMLInputElement>('#edit-servings')!;
    departAndReconnect(root, 'root');
    const before = root.innerHTML;
    button(action).click();
    expect(quantity.value).toBe('2');
    expect(root.innerHTML).toBe(before);
    expect(document.querySelector('body > input[type="date"]')).toBeNull();
  },
);

it.each(['movement', 'cancellation'])('Dashboard rejects gesture %s after same-turn ancestor departure', async action => {
  const item = await showMealItem(meal());
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 10 }));
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  departAndReconnect(root, 'ancestor');
  const before = item.getAttribute('style');
  if (action === 'movement') document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 10 }));
  else item.dispatchEvent(new Event('touchcancel'));
  document.dispatchEvent(new MouseEvent('mouseup'));
  expect(item.getAttribute('style')).toBe(before);
  expect(meals.delete).not.toHaveBeenCalled();
});

it.each(['completion first', 'observer first'])('Dashboard consumes an accepted copy after ancestor retirement with %s', async order => {
  await showMealItem(meal());
  const pending = deferred<{ copied: number }>();
  vi.mocked(meals.copy).mockReturnValueOnce(pending.promise);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  button('copy-prev-btn').click();
  await Promise.resolve();
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  const before = root.innerHTML;
  const reads = vi.mocked(meals.getByDate).mock.calls.length;
  if (order === 'completion first') pending.resolve({ copied: 3 });
  departAndReconnect(root, 'ancestor');
  if (order === 'observer first') {
    await Promise.resolve();
    pending.reject(new Error('Late copy failure'));
  }
  await settle();
  expect(root.innerHTML).toBe(before);
  expect(meals.copy).toHaveBeenCalledWith('2026-03-31', '2026-04-01');
  expect(meals.getByDate).toHaveBeenCalledTimes(reads);
  go('/');
  await settle();
  button('date-prev').click();
  expect(state.selectedDate).toBe('2026-03-31');
});

it.each(['missing', 'replacement'])('Dashboard retirement leaves a %s modal and its successor alone', async mode => {
  const modal = await openEditMealModal(meal());
  const close = button('edit-modal-close');
  const replacement = modal.cloneNode(true) as HTMLElement;
  replacement.querySelector('#edit-meal-body')!.textContent = 'Successor content';
  if (mode === 'missing') modal.remove();
  else modal.replaceWith(replacement);
  const oldHTML = modal.innerHTML;
  const newHTML = replacement.innerHTML;
  close.click();
  button('date-prev').click();
  await settle();
  expect(modal.innerHTML).toBe(oldHTML);
  expect(replacement.innerHTML).toBe(newHTML);
  expect(state.selectedDate).toBe('2026-04-01');
});

it('temporary picker removal and modal rendering leave Dashboard live', async () => {
  await openEditMealModal(meal());
  button('edit-serv-plus').click();
  expect(document.querySelector<HTMLInputElement>('#edit-servings')!.value).toBe('3');
  button('edit-modal-close').click();
  tap();
  expect(document.querySelector<HTMLInputElement>('#edit-servings')!.value).toBe('2');
  button('date-label').click();
  document.querySelector('body > input[type="date"]')!.remove();
  await settle();
  button('date-label').click();
  const picker = document.querySelector<HTMLInputElement>('body > input[type="date"]')!;
  picker.value = '2026-03-30';
  picker.dispatchEvent(new Event('change'));
  expect(state.selectedDate).toBe('2026-03-30');
  expect(document.querySelector('#edit-meal-body')!.children).toHaveLength(0);
});

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

it.each(['food', 'quick'] as const)('preserves the %s edit payload and refreshes the saved meal', async kind => {
  const entry = kind === 'food'
    ? meal({ servings: 3, unit_scale: 1.5, calories: 200, carbs_g: 20, protein_g: 10, fat_g: 8 })
    : meal({ food_id: null, note: 'Quick meal' });
  await openEditMealModal(entry);
  if (kind === 'food') {
    expect(document.querySelector('#edit-total')!.textContent).toContain('10g P');
    button('edit-serv-plus').click();
    expect(document.querySelector('#edit-total')!.textContent).toContain('15g P');
  } else {
    document.querySelector<HTMLInputElement>('#edit-cal')!.value = '321.4';
    document.querySelector<HTMLInputElement>('#edit-carbs')!.value = '22.2';
    document.querySelector<HTMLInputElement>('#edit-protein')!.value = '33.3';
    document.querySelector<HTMLInputElement>('#edit-fat')!.value = '4.4';
  }
  document.querySelector<HTMLSelectElement>('#edit-meal-type')!.value = 'dinner';
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [meal({ food_name: 'Saved' })] });
  button('edit-save-btn').click();
  await settle();
  expect(meals.update).toHaveBeenCalledWith(1, kind === 'food'
    ? { servings: 4.5, mealType: 'dinner', calories: 300, carbsG: 30, proteinG: 15, fatG: 12 }
    : { mealType: 'dinner', calories: 321.4, carbsG: 22.2, proteinG: 33.3, fatG: 4.4 });
  expect(document.querySelector('#edit-meal-modal')!.classList.contains('hidden')).toBe(true);
  expect(document.querySelector('.meal-item-name')!.textContent).toContain('Saved');
});

it.each(['food', 'quick'] as const)('allows the current %s form to retry a failed save', async kind => {
  await openEditMealModal(meal({ food_id: kind === 'food' ? 1 : null }));
  vi.mocked(meals.update).mockRejectedValueOnce(new Error('save failed'));
  button('edit-save-btn').click();
  await settle();
  expect(button('edit-save-btn').disabled).toBe(false);
  expect(button('edit-save-btn').textContent).toBe('Failed - Retry');
  expect(document.querySelector('#edit-meal-modal')!.classList.contains('hidden')).toBe(false);
  button('edit-save-btn').click();
  await settle();
  expect(document.querySelector('#edit-meal-modal')!.classList.contains('hidden')).toBe(true);
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

it.each(['date', 'remount', 'ancestor'] as const)('releases swipe timers, frames and the temporary picker on %s', async how => {
  await showMealItem(meal());
  button('date-label').click();
  const picker = document.querySelector<HTMLInputElement>('input[type="date"]')!;
  vi.useFakeTimers();
  swipe();
  await settle();
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  if (how === 'ancestor') departAndReconnect(document.querySelector('#app .dashboard-page')!, 'ancestor');
  else leaveSelection(how);
  await settle();
  expect(vi.getTimerCount()).toBe(0);
  expect(picker.isConnected).toBe(false);
  const date = state.selectedDate;
  picker.value = '2025-01-01';
  picker.dispatchEvent(new Event('change'));
  expect(state.selectedDate).toBe(date);
});

it('normal swipe animates and refreshes through the selected date session', async () => {
  await showMealItem(meal());
  vi.useFakeTimers();
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [] });
  swipe();
  await settle();
  await vi.advanceTimersByTimeAsync(20);
  expect(document.querySelector<HTMLElement>('.meal-item-wrapper')!.style.height).toBe('0px');
  await vi.advanceTimersByTimeAsync(280);
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

it('edit meal modal shows a saved measure label as text on the per-unit line and the quantity label', async () => {
  const label = 'cup<img alt="measure">';
  const modal = await openEditMealModal(meal({ unit_label: label }));
  expect(modal.querySelector('img')).toBeNull();
  expect(modal.querySelector('p.text-muted')!.textContent).toBe(`Per ${label}`);
  expect(modal.querySelector('label[for="edit-servings"]')!.textContent).toBe(label);
});

it('edit meal modal shows a saved food brand as text', async () => {
  const brand = 'Acme<img alt="brand">';
  const modal = await openEditMealModal(meal({ food_brand: brand }));
  expect(modal.querySelector('img')).toBeNull();
  expect(modal.querySelector('.food-brand')!.textContent).toBe(brand);
});

it('dashboard meal list shows a logged meal name as text', async () => {
  const name = 'Apple<img alt="name">';
  const item = await showMealItem(meal({ food_name: name, servings: 1 }));
  expect(item.querySelector('img')).toBeNull();
  expect(item.querySelector('.meal-item-name')!.textContent).toBe(name);
});

it('dashboard meal list shows a logged meal brand as text', async () => {
  const brand = 'Acme<img alt="brand">';
  const item = await showMealItem(meal({ food_brand: brand, servings: 1 }));
  expect(item.querySelector('img')).toBeNull();
  expect(item.querySelector('.food-brand')!.textContent).toBe(brand);
});

it('dashboard keeps a high-calorie, low-protein meal partial', async () => {
  const item = await showMealItem(meal({ calories: 650, protein_g: 6 }));
  const section = item.closest('.meal-section')!;
  expect(section.classList.contains('partial')).toBe(true);
  expect(section.querySelector('.meal-macro-chips .chip-protein-hit')).toBeNull();
});

it('dashboard highlights a lean protein-pulse snack while its meal remains partial', async () => {
  const item = await showMealItem(meal({ meal_type: 'snack', calories: 200, protein_g: 31.9 }));
  const section = item.closest('.meal-section')!;
  expect(section.classList.contains('partial')).toBe(true);
  expect(section.querySelector('.meal-macro-chips .chip-protein')!.classList.contains('chip-protein-hit')).toBe(true);
  expect(item.querySelector('.chip-protein-hit')).toBeNull();
});

it.each([
  ['both targets at 85%', 550.4, 31.9, 'on-track', true],
  ['calories just below 85%', 550.3, 31.9, 'partial', true],
  ['protein just below 85%', 650, 31.8, 'partial', false],
  ['both targets below 50%', 100, 5, 'low', false],
  ['all-zero logged macros', 0, 0, '', false],
])('dashboard renders %s against unrounded daily / 4 targets', async (_label, calories, protein, status, proteinHit) => {
  const item = await showMealItem(meal({ calories, protein_g: protein, carbs_g: 0, fat_g: 0 }));
  const section = item.closest('.meal-section')!;
  expect(section.className.trim()).toBe(`meal-section ${status}`.trim());
  expect(section.querySelector('.meal-macro-chips .chip-protein')!.classList.contains('chip-protein-hit')).toBe(proteinHit);
});

it('dashboard leaves empty meals without a status or macro chips', async () => {
  go('/');
  await vi.waitFor(() => expect(document.querySelectorAll('.meal-empty')).toHaveLength(4));
  expect([...document.querySelectorAll('.meal-section')].every(section => section.className.trim() === 'meal-section')).toBe(true);
  expect(document.querySelector('.meal-macro-chips')).toBeNull();
});

it('dashboard sums logged foods before assessing the meal protein pulse', async () => {
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [
    meal({ calories: 300, protein_g: 20 }),
    meal({ id: 2, calories: 300, protein_g: 20 }),
  ] });
  go('/');
  await vi.waitFor(() => expect(document.querySelectorAll('.meal-item')).toHaveLength(2));
  const section = document.querySelector('.meal-section')!;
  expect(section.classList.contains('on-track')).toBe(true);
  expect(section.querySelector('.meal-macro-chips .chip-protein-hit')!.textContent).toBe('40/38p');
});

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

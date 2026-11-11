import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, recipes, workoutDays, setToken } from '../api';
import { seedSampleData, setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { state, todayStr } from '../state';
import { dashboardView } from './dashboard';
import { deferred } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { swipe, settleMealPersistence as settle } from '../test/meal-list-fixtures';

async function showFoodMeal() {
  const { food } = await foods.create({ name: 'Apple', serving_size: 100, serving_unit: 'g', calories: 100, protein_g: 5 });
  await meals.log({ date: '2026-04-01', mealType: 'breakfast', foodId: food.id, servings: 2 });
  go('/');
  await ready(1);
  return document.querySelector<HTMLElement>('.meal-item')!;
}

function tap(item: HTMLElement) {
  item.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 10 }));
}

it.each(['guest', 'HTTP'] as const)('%s accepted swipe survives same-date replacement before completion or after effects are queued', async adapter => {
  for (const timing of ['pending', 'queued'] as const) {
    go('/other');
    localStorage.clear();
    setGuestMode(true);
    const { first, second } = await showTwoEditorMeals('quick');
    click('edit-modal-close');
    const item = document.querySelector<HTMLElement>('.meal-item')!;
    const wrapper = item.parentElement!;
    const container = document.querySelector('#meals-container')!;
    const pending = deferred<Response>();
    const reads: string[] = [];
    if (adapter === 'HTTP') {
      setGuestMode(false);
      setToken('original-list-owner');
      vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
        if (options?.method === 'DELETE') {
          expect(url).toBe(`/api/meals/${first.id}`);
          expect(new Headers(options.headers).get('Authorization')).toBe('Bearer original-list-owner');
          expect(options.credentials).toBe('include');
          return pending.promise;
        }
        if (url.includes('/workout-days/')) return Promise.resolve(Response.json({ isWorkoutDay: true }));
        reads.push(url);
        return Promise.resolve(Response.json({ meals: [second] }));
      }));
    }
    vi.useFakeTimers();
    swipe(item);
    if (timing === 'queued') {
      pending.resolve(Response.json({ success: true }));
      await settle();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    }
    // A same-date render disposes the old list; reattaching it cannot revive it.
    document.querySelector<HTMLInputElement>('#workout-toggle')!.click();
    container.append(wrapper);
    const oldBefore = wrapper.outerHTML;
    const currentSecond = [...container.querySelectorAll<HTMLElement>('.meal-item')].find(row => row.dataset.id === String(second.id))!;
    tap(currentSecond);
    document.querySelector<HTMLInputElement>('#edit-cal')!.value = '999';
    const modal = document.querySelector('#edit-meal-modal')!;
    const editorBefore = modal.outerHTML;
    const read = vi.spyOn(meals, 'getByDate');
    pending.resolve(Response.json({ success: true }));
    await settle();
    await vi.advanceTimersByTimeAsync(299);
    expect(read).not.toHaveBeenCalled();
    expect(wrapper.outerHTML).toBe(oldBefore);
    swipe(item);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledExactlyOnceWith('2026-04-01');
    expect(document.querySelector('#cal-value')!.textContent).toBe('300');
    expect(modal.outerHTML).toBe(editorBefore);
    expect(wrapper.outerHTML).toBe(oldBefore);
    if (adapter === 'guest') expect((await meals.getByDate('2026-04-01')).meals.map(entry => entry.id)).toEqual([second.id]);
    else expect(reads).toEqual(['/api/meals/2026-04-01']);
    read.mockRestore();
    go('/other');
    vi.useRealTimers();
  }
});

it.each(['pending', 'queued'] as const)('HTTP swipe %s work is suppressed by date change, return, Dashboard replacement or retirement', async timing => {
  for (const retirement of ['date', 'return', 'remount', 'parent'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      go('/other');
      localStorage.clear();
      setGuestMode(true);
      state.selectedDate = '2026-04-01';
      const item = await showFoodMeal();
      setGuestMode(false);
      const pending = deferred<Response>();
      const requests: string[] = [];
      vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
        requests.push(url);
        if (options?.method === 'DELETE') return pending.promise;
        return Promise.resolve(Response.json(url.includes('/workout-days/') ? { isWorkoutDay: false }
          : url.includes('/daily-checks/') ? { checks: [] } : { meals: [] }));
      }));
      vi.useFakeTimers();
      swipe(item);
      if (timing === 'queued') {
        pending.resolve(Response.json(outcome === 'success' ? { success: true } : { error: 'Failed' }, { status: outcome === 'success' ? 200 : 500 }));
        await settle();
      }
      const root = document.querySelector<HTMLElement>('.dashboard-page')!;
      if (retirement === 'parent') departAndReconnect(root, 'ancestor');
      else if (retirement === 'remount') { go('/other'); go('/'); }
      else { click('date-prev'); if (retirement === 'return') click('date-next'); }
      await settle();
      const before = root.outerHTML;
      const readsBefore = requests.length;
      pending.resolve(Response.json(outcome === 'success' ? { success: true } : { error: 'Failed' }, { status: outcome === 'success' ? 200 : 500 }));
      await settle();
      await vi.advanceTimersByTimeAsync(1000);
      expect(requests.length, `${retirement}, ${outcome}`).toBe(readsBefore);
      expect(root.outerHTML, `${retirement}, ${outcome}`).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
      go('/other');
      vi.useRealTimers();
    }
  }
});

it.each(['date', 'return', 'remount', 'parent'] as const)('accepted guest swipe persists before %s and its completion cannot refresh or change the retired view', async retirement => {
  const item = await showFoodMeal();
  const root = document.querySelector<HTMLElement>('.dashboard-page')!;
  const originalDate = state.selectedDate;
  swipe(item);
  if (retirement === 'parent') departAndReconnect(root, 'ancestor');
  else if (retirement === 'remount') { go('/other'); go('/'); }
  else { click('date-prev'); if (retirement === 'return') click('date-next'); }
  const oldRow = item.outerHTML;
  await settle();
  const read = vi.spyOn(meals, 'getByDate');
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).not.toHaveBeenCalled();
  expect(item.outerHTML).toBe(oldRow);
  expect((await meals.getByDate(originalDate)).meals).toEqual([]);
});

it('row-only departure retires the list while Dashboard date controls remain usable', async () => {
  const item = await showFoodMeal();
  const root = document.querySelector<HTMLElement>('.dashboard-page')!;
  departAndReconnect(root, '.meal-item');
  tap(item);
  expect(document.querySelector('#edit-meal-modal')!.classList.contains('hidden')).toBe(true);
  click('date-prev');
  expect(state.selectedDate).toBe('2026-03-31');
});

async function openFoodMeal() {
  tap(await showFoodMeal());
  return document.querySelector<HTMLElement>('#app .dashboard-page')!;
}

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function click(id: string) {
  document.querySelector<HTMLButtonElement>(`#${id}`)!.click();
}

async function ready(count: number) {
  await vi.waitFor(() => expect(document.querySelectorAll('.meal-item')).toHaveLength(count));
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
  state.selectedDate = '2026-04-01';
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('retained old Quick entry Save cannot submit a newer editor values for the old meal', async () => {
  const { meal: first } = await meals.quickLog({ date: state.selectedDate, mealType: 'breakfast', name: 'First', calories: 100 });
  await meals.quickLog({ date: state.selectedDate, mealType: 'lunch', name: 'Second', calories: 200 });
  go('/');
  await ready(2);
  tap(document.querySelectorAll<HTMLElement>('.meal-item')[0]);
  const oldSave = document.querySelector<HTMLButtonElement>('#edit-save-btn')!;
  tap(document.querySelectorAll<HTMLElement>('.meal-item')[1]);
  document.querySelector<HTMLInputElement>('#edit-cal')!.value = '999';
  document.querySelector<HTMLSelectElement>('#edit-meal-type')!.value = 'dinner';
  document.querySelector('#edit-meal-body')!.appendChild(oldSave);
  oldSave.click();
  await Promise.resolve();
  expect((await meals.getByDate(state.selectedDate)).meals.find(meal => meal.id === first.id))
    .toMatchObject({ calories: 100, meal_type: 'breakfast' });
  expect(document.querySelector('#edit-meal-modal')!.classList.contains('hidden')).toBe(false);
});

async function showTwoEditorMeals(kind: 'food' | 'recipe' | 'quick') {
  const reference = kind === 'quick' ? {} : kind === 'food'
    ? { foodId: (await foods.create({ name: 'Apple', calories: 100, carbs_g: 10, protein_g: 5, fat_g: 4 })).food.id }
    : { recipeId: (await recipes.create({ name: 'Recipe', totalServings: 1, ingredients: [], manualCalories: 100, manualCarbsG: 10, manualProteinG: 5, manualFatG: 4 })).recipe.id };
  const first = kind === 'quick'
    ? (await meals.quickLog({ date: state.selectedDate, mealType: 'breakfast', name: 'First', calories: 200 })).meal
    : (await meals.log({ date: state.selectedDate, mealType: 'breakfast', ...reference, servings: 2 })).meal;
  const { meal: second } = await meals.quickLog({ date: state.selectedDate, mealType: 'lunch', name: 'Second', calories: 300 });
  go('/');
  await ready(2);
  tap(document.querySelectorAll<HTMLElement>('.meal-item')[0]);
  return { first, second };
}

it.each(['food', 'recipe', 'quick'] as const)('accepted HTTP %s Save captures its payload and cannot close a newer same-date editor', async kind => {
  const { first, second } = await showTwoEditorMeals(kind);
  setGuestMode(false);
  setToken('original-owner');
  const write = deferred<Response>();
  const requests: { url: string; options?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    requests.push({ url, options });
    return options?.method === 'PUT' ? write.promise : Promise.resolve(Response.json({ meals: [{ ...first, calories: 444 }, second] }));
  }));
  if (kind === 'quick') {
    document.querySelector<HTMLInputElement>('#edit-cal')!.value = '321.456';
    document.querySelector<HTMLInputElement>('#edit-protein')!.value = '33.345';
  } else click('edit-serv-plus');
  document.querySelector<HTMLSelectElement>('#edit-meal-type')!.value = 'dinner';
  const oldSave = document.querySelector<HTMLButtonElement>('#edit-save-btn')!;
  oldSave.click();
  oldSave.dispatchEvent(new MouseEvent('click'));
  tap(document.querySelectorAll<HTMLElement>('.meal-item')[1]);
  document.querySelector<HTMLInputElement>('#edit-cal')!.value = '999';
  document.querySelector('#edit-meal-body')!.appendChild(oldSave);
  const before = document.querySelector('#edit-meal-modal')!.outerHTML;
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(`/api/meals/${first.id}`);
  expect(JSON.parse(String(requests[0].options!.body))).toEqual(kind === 'quick'
    ? { mealType: 'dinner', calories: 321.456, carbsG: 0, proteinG: 33.345, fatG: 0 }
    : { servings: 3, mealType: 'dinner', calories: 300, carbsG: 30, proteinG: 15, fatG: 12 });
  expect(new Headers(requests[0].options!.headers).get('Authorization')).toBe('Bearer original-owner');
  expect(requests[0].options!.credentials).toBe('include');
  write.resolve(Response.json({ meal: first }));
  await vi.waitFor(() => expect(document.querySelector('#cal-value')!.textContent).toBe('744'));
  expect(requests.filter(request => !request.options?.method).map(request => request.url)).toEqual(['/api/meals/2026-04-01']);
  expect(document.querySelector('#edit-meal-modal')!.outerHTML).toBe(before);
});

it.each(['save', 'delete'] as const)('accepted guest %s refreshes after same-date Close and leaves a replacement editor intact', async action => {
  await showTwoEditorMeals('quick');
  if (action === 'save') document.querySelector<HTMLInputElement>('#edit-cal')!.value = '444';
  click(action === 'save' ? 'edit-save-btn' : 'edit-delete-btn');
  // Guest persistence finishes synchronously; completion is still pending.
  click('edit-modal-close');
  tap(document.querySelectorAll<HTMLElement>('.meal-item')[1]);
  const before = document.querySelector('#edit-meal-modal')!.outerHTML;
  await vi.waitFor(() => expect(document.querySelector('#cal-value')!.textContent).toBe(action === 'save' ? '744' : '300'));
  expect(document.querySelector('#edit-meal-modal')!.outerHTML).toBe(before);
  expect((await meals.getByDate('2026-04-01')).meals).toHaveLength(action === 'save' ? 2 : 1);
});

it.each(['save', 'delete'] as const)('HTTP %s success refreshes only its original live selection; failures leave successor feedback alone', async action => {
  for (const retirement of ['close', 'replace', 'date', 'return', 'remount', 'parent'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      go('/other');
      localStorage.clear();
      setGuestMode(true);
      state.selectedDate = '2026-04-01';
      const { first, second } = await showTwoEditorMeals('quick');
      setGuestMode(false);
      const write = deferred<Response>();
      const reads: string[] = [];
      vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
        if (options?.method === 'PUT' || options?.method === 'DELETE') return write.promise;
        if (url.includes('/daily-checks/')) return Promise.resolve(Response.json({ checks: [] }));
        if (url.includes('/workout-days/')) return Promise.resolve(Response.json({ isWorkoutDay: false }));
        reads.push(url);
        return Promise.resolve(Response.json({ meals: [first, second] }));
      }));
      click(action === 'save' ? 'edit-save-btn' : 'edit-delete-btn');
      if (retirement === 'close') click('edit-modal-close');
      else if (retirement === 'replace') tap(document.querySelectorAll<HTMLElement>('.meal-item')[1]);
      else if (retirement === 'parent') departAndReconnect(document.querySelector('.dashboard-page')!, 'ancestor');
      else if (retirement === 'remount') { go('/other'); go('/'); }
      else { click('date-prev'); if (retirement === 'return') click('date-next'); }
      if (retirement === 'date' || retirement === 'return' || retirement === 'remount') {
        await ready(2);
        tap(document.querySelectorAll<HTMLElement>('.meal-item')[1]);
      }
      const modal = document.querySelector('#edit-meal-modal')!;
      const before = modal.outerHTML;
      const beforeReads = reads.length;
      if (outcome === 'success') write.resolve(Response.json({ meal: first, success: true }));
      else write.resolve(Response.json({ error: 'offline' }, { status: 500 }));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(reads.length - beforeReads, `${retirement}, ${outcome}`).toBe(outcome === 'success' && (retirement === 'close' || retirement === 'replace') ? 1 : 0);
      expect(modal.outerHTML, `${retirement}, ${outcome}`).toBe(before);
    }
  }
});

it('removing an editor-only control retires that editor and keeps Dashboard usable', async () => {
  await showTwoEditorMeals('food');
  const oldSave = document.querySelector<HTMLButtonElement>('#edit-save-btn')!;
  const oldPlus = document.querySelector<HTMLButtonElement>('#edit-serv-plus')!;
  document.querySelector('#edit-servings')!.remove();
  oldSave.click();
  oldPlus.click();
  tap(document.querySelectorAll<HTMLElement>('.meal-item')[1]);
  document.querySelector<HTMLInputElement>('#edit-cal')!.value = '555';
  click('edit-save-btn');
  await vi.waitFor(() => expect(document.querySelector('#cal-value')!.textContent).toBe('755'));
  click('date-prev');
  expect(state.selectedDate).toBe('2026-03-31');
});

it.each(['root', 'fixed replacement'])('Dashboard permanently retires on same-turn %s before router cleanup', async departure => {
  const root = await openFoodMeal();
  const saved = await meals.getByDate('2026-04-01');
  departAndReconnect(root, departure, '#workout-toggle');
  const before = root.innerHTML;
  click('edit-serv-plus');
  click('edit-save-btn');
  click('edit-delete-btn');
  click('edit-modal-close');
  click('date-label');
  click('date-prev');
  click('copy-prev-btn');
  await Promise.resolve();
  expect(root.innerHTML).toBe(before);
  expect(state.selectedDate).toBe('2026-04-01');
  expect(document.querySelector('body > input[type="date"]')).toBeNull();
  expect(await meals.getByDate('2026-04-01')).toEqual(saved);
  expect(window.confirm).not.toHaveBeenCalled();
});

it.each(['edit-serv-minus', 'edit-serv-plus', 'edit-modal-close', 'date-label'])(
  '%s checks retirement before its first view effect', async action => {
    const root = await openFoodMeal();
    const quantity = root.querySelector<HTMLInputElement>('#edit-servings')!;
    departAndReconnect(root, 'root');
    const before = root.innerHTML;
    click(action);
    expect(quantity.value).toBe('2');
    expect(root.innerHTML).toBe(before);
    expect(document.querySelector('body > input[type="date"]')).toBeNull();
  },
);


it('guest copy persists before ancestor retirement and its completion precedes observer delivery', async () => {
  await meals.quickLog({ date: '2026-03-31', mealType: 'lunch', name: 'Copy source', calories: 300 });
  const root = await openFoodMeal();
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    write.call(this, key, value);
    // Schedule departure before the accepted write queues its continuation.
    if (key === 'guest_meals') queueMicrotask(() => departAndReconnect(root, 'ancestor'));
  });
  click('copy-prev-btn');
  const before = root.innerHTML;
  await Promise.resolve();
  await Promise.resolve();
  expect(root.innerHTML).toBe(before);
  expect((await meals.getByDate('2026-04-01')).meals).toHaveLength(2);
  go('/');
  await ready(2);
  click('date-prev');
  expect(state.selectedDate).toBe('2026-03-31');
});

it('a late HTTP copy failure stays silent after observer retirement', async () => {
  setGuestMode(false);
  const pending = deferred<Response>();
  const network = vi.fn((url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return pending.promise;
    return Promise.resolve(Response.json(url.includes('/workout-days/') ? { isWorkoutDay: false }
      : url.includes('/daily-checks/') ? { checks: [] } : { meals: [] }));
  });
  vi.stubGlobal('fetch', network);
  go('/');
  await vi.waitFor(() => expect(document.querySelectorAll('.meal-section')).toHaveLength(4));
  click('copy-prev-btn');
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  const before = root.innerHTML;
  departAndReconnect(root, 'ancestor');
  await Promise.resolve();
  const requests = network.mock.calls.length;
  pending.reject(new Error('Late copy failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(root.innerHTML).toBe(before);
  expect(network).toHaveBeenCalledTimes(requests);
  expect(network).toHaveBeenCalledWith('/api/meals/copy', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ fromDate: '2026-03-31', toDate: '2026-04-01' }),
  }));
});

it.each(['missing', 'replacement'])('Dashboard retirement leaves a %s modal and its successor alone', async mode => {
  await openFoodMeal();
  const modal = document.querySelector<HTMLElement>('#edit-meal-modal')!;
  const close = document.querySelector<HTMLButtonElement>('#edit-modal-close')!;
  const replacement = modal.cloneNode(true) as HTMLElement;
  replacement.querySelector('#edit-meal-body')!.textContent = 'Successor content';
  if (mode === 'missing') modal.remove();
  else modal.replaceWith(replacement);
  const oldHTML = modal.innerHTML;
  const newHTML = replacement.innerHTML;
  close.click();
  click('date-prev');
  await Promise.resolve();
  expect(modal.innerHTML).toBe(oldHTML);
  expect(replacement.innerHTML).toBe(newHTML);
  expect(state.selectedDate).toBe('2026-04-01');
});

it('temporary picker removal and modal rendering leave Dashboard live', async () => {
  await openFoodMeal();
  click('edit-serv-plus');
  expect(document.querySelector<HTMLInputElement>('#edit-servings')!.value).toBe('3');
  click('edit-modal-close');
  tap(document.querySelector<HTMLElement>('.meal-item')!);
  expect(document.querySelector<HTMLInputElement>('#edit-servings')!.value).toBe('2');
  click('date-label');
  document.querySelector('body > input[type="date"]')!.remove();
  await Promise.resolve();
  click('date-label');
  const picker = document.querySelector<HTMLInputElement>('body > input[type="date"]')!;
  picker.value = '2026-03-30';
  picker.dispatchEvent(new Event('change'));
  expect(state.selectedDate).toBe('2026-03-30');
  expect(document.querySelector('#edit-meal-body')!.children).toHaveLength(0);
});

it('ancestor retirement releases swipe timers, frames and the temporary picker', async () => {
  const item = await showFoodMeal();
  click('date-label');
  const picker = document.querySelector<HTMLInputElement>('body > input[type="date"]')!;
  vi.useFakeTimers();
  item.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup'));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  const root = document.querySelector<HTMLElement>('#app .dashboard-page')!;
  departAndReconnect(root, 'ancestor');
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  expect(picker.isConnected).toBe(false);
  picker.value = '2025-01-01';
  picker.dispatchEvent(new Event('change'));
  expect(state.selectedDate).toBe('2026-04-01');
});

it('guest Dashboard selects, copies, edits and deletes through the local adapters', async () => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  await meals.quickLog({ date: '2026-03-31', mealType: 'lunch', name: 'Guest lunch', calories: 321.4, proteinG: 30.2 });
  await workoutDays.set('2026-03-31', true);
  go('/');
  click('date-prev');
  await ready(1);
  expect(document.querySelector('.meal-item-name')!.textContent).toBe('Guest lunch');
  expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(true);
  click('date-next');
  await ready(0);
  click('copy-prev-btn');
  await ready(1);
  expect(document.querySelector('#cal-value')!.textContent).toBe('321');
  const item = document.querySelector('.meal-item')!;
  item.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 10, clientY: 10 }));
  document.querySelector<HTMLInputElement>('#edit-protein')!.value = '42.3';
  click('edit-save-btn');
  await vi.waitFor(() => expect(document.querySelector('#protein-value')!.textContent).toBe('42 / 150g'));
  expect((await meals.getByDate('2026-04-01')).meals[0].protein_g).toBe(42.3);
  const saved = document.querySelector('.meal-item')!;
  saved.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 10, clientY: 10 }));
  click('edit-delete-btn');
  await ready(0);
  expect((await meals.getByDate('2026-03-31')).meals).toHaveLength(1);
  expect(network).not.toHaveBeenCalled();
});

it('sample dismissal refreshes this session and supersedes its pending meal read', async () => {
  state.selectedDate = todayStr();
  seedSampleData();
  await meals.quickLog({ date: state.selectedDate, mealType: 'lunch', name: 'Personal lunch', calories: 500 });
  const old = await meals.getByDate(state.selectedDate);
  let finish!: (value: typeof old) => void;
  vi.spyOn(meals, 'getByDate').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  go('/');
  click('sample-dismiss-btn');
  await ready(1);
  finish(old);
  await Promise.resolve();
  expect(document.querySelector('#sample-banner')).toBeNull();
  expect(document.querySelectorAll('.meal-item')).toHaveLength(1);
  expect(document.querySelector('.meal-item-name')!.textContent).toBe('Personal lunch');
  expect(document.querySelector('#cal-value')!.textContent).toBe('500');
});

it('signed-in Dashboard uses dated HTTP reads and captures workout and copy writes', async () => {
  setGuestMode(false);
  setToken('test-token');
  const requests: { path: string; method: string; body: unknown }[] = [];
  const network = vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.replace('/api', '');
    const method = options?.method ?? 'GET';
    requests.push({ path, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (path.startsWith('/workout-days/')) return Response.json({ isWorkoutDay: path.endsWith('03-31') });
    if (path.startsWith('/daily-checks/')) return Response.json({ checks: [] });
    if (path === '/meals/copy') return Response.json({ copied: 2 });
    return Response.json({ meals: [] });
  });
  vi.stubGlobal('fetch', network);
  go('/');
  await vi.waitFor(() => expect(document.querySelector('[data-check-key]')!.hasAttribute('disabled')).toBe(false));
  click('workout-toggle');
  click('date-prev');
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#workout-toggle')!.checked).toBe(true));
  click('copy-prev-btn');
  await vi.waitFor(() => expect(document.querySelector('#copy-prev-btn')!.textContent).toBe('Copied 2 items!'));
  expect(requests).toContainEqual({ path: '/meals/2026-04-01', method: 'GET', body: null });
  expect(requests).toContainEqual({ path: '/meals/2026-03-31', method: 'GET', body: null });
  expect(requests).toContainEqual({ path: '/daily-checks/2026-03-31', method: 'GET', body: null });
  expect(requests).toContainEqual({ path: '/workout-days/2026-04-01', method: 'PUT', body: { isWorkoutDay: true } });
  expect(requests).toContainEqual({ path: '/meals/copy', method: 'POST', body: { fromDate: '2026-03-30', toDate: '2026-03-31' } });
  expect(network.mock.calls.every(([, options]) => options?.credentials === 'include'
    && new Headers(options.headers).get('Authorization') === 'Bearer test-token')).toBe(true);
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { meals, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { deferred } from '../test/food-search-fixtures';
import { meal } from '../test/meal-list-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { mountMealListSession } from './meal-list-session';

let host: HTMLElement;
let dispose = () => {};
const targets = { cal: 2590, carbs: 340, protein: 150, fat: 70 };

function open(entries = [meal()], parentIsCurrent = () => true) {
  dispose();
  const onEdit = vi.fn(), onAddFood = vi.fn(), onDeleted = vi.fn();
  dispose = mountMealListSession(host, {
    meals: entries, date: '2026-04-01', targets, parentIsCurrent, onEdit, onAddFood, onDeleted,
  });
  return { onEdit, onAddFood, onDeleted };
}

function showMealItem(entry: ReturnType<typeof meal>) {
  open([entry]);
  return host.querySelector<HTMLElement>('.meal-item')!;
}

function start(item: HTMLElement) {
  item.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, clientY: 10, cancelable: true }));
}
function move(x: number, y = 10) {
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
}
function end() {
  document.dispatchEvent(new MouseEvent('mouseup'));
}
function swipe(item = host.querySelector<HTMLElement>('.meal-item')!) {
  start(item);
  move(50);
  end();
}
function touch(item: HTMLElement, type: string, x = 200, y = 10) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
  item.dispatchEvent(event);
  return event;
}
async function settle() {
  // Drain both the HTTP response decoding and the mounted completion.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  document.body.innerHTML = '<main><section id="list"></section></main>';
  host = document.getElementById('list')!;
  vi.useFakeTimers();
});
afterEach(() => {
  dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps Meal order, empty sections, whole-number figures, quantity and time labels', () => {
  open([meal({ meal_type: 'dinner', calories: 201.6, carbs_g: 20.6, protein_g: 10.6, fat_g: 8.6,
    servings: 5, unit_scale: 3, created_at: '2026-04-01 12:30:00' })]);
  expect([...host.querySelectorAll('h3')].map(node => node.textContent)).toEqual(['Breakfast', 'Lunch', 'Dinner', 'Snacks']);
  expect(host.querySelectorAll('.meal-empty')).toHaveLength(3);
  const section = host.querySelectorAll('.meal-section')[2];
  expect(section.querySelector('.meal-item-name')!.textContent).toBe('1.67x Apple');
  expect(section.querySelector('.food-serving')!.textContent).toBe(new Date('2026-04-01 12:30:00Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  expect(section.querySelector('.meal-subtotal')!.textContent).toBe('202 / 648 kcal');
  expect([...section.querySelectorAll('.meal-item .macro-chip')].map(node => node.textContent)).toEqual(['202', '21c', '11p', '9f']);
  expect([...section.querySelectorAll('.meal-macro-chips .macro-chip')].map(node => node.textContent)).toEqual(['21/85c', '11/38p', '9/18f']);
});

it.each([
  [{ food_name: null, recipe_name: 'Recipe<img>' }, 'Recipe<img>'],
  [{ food_name: null, note: 'Note<img>' }, 'Note<img>'],
  [{ food_name: null }, 'Quick entry'],
])('uses text-safe name fallbacks %j', (overrides, name) => {
  const item = showMealItem(meal({ servings: 1, ...overrides }));
  expect(item.querySelector('.meal-item-name')!.textContent).toBe(name);
  expect(item.querySelector('img')).toBeNull();
});

it('Add Food and Edit use captured Meal types, date and meal rather than mutable dataset identity', () => {
  const entry = meal();
  const { onAddFood, onEdit } = open([entry]);
  host.querySelectorAll<HTMLButtonElement>('.btn-add-meal').forEach(button => {
    button.dataset.mealType = 'changed';
    button.dataset.date = '2025-01-01';
    button.click();
  });
  expect(onAddFood.mock.calls).toEqual(['breakfast', 'lunch', 'dinner', 'snack'].map(type => [type, '2026-04-01']));
  const item = host.querySelector<HTMLElement>('.meal-item')!;
  item.dataset.id = '999';
  item.parentElement!.dataset.id = '999';
  start(item);
  end();
  expect(onEdit).toHaveBeenCalledExactlyOnceWith(entry);
});

it.each([
  [195, 10, true], [194, 10, false], [200, 15, true], [200, 16, false], [230, 10, false], [120, 10, false],
])('mouse movement to %i,%i preserves tap and strict delete thresholds', (x, y, edits) => {
  const { onEdit, onDeleted } = open();
  const item = host.querySelector<HTMLElement>('.meal-item')!;
  start(item);
  move(x, y);
  expect(item.style.transform).toBe(`translateX(${Math.min(x - 200, 0)}px)`);
  end();
  expect(onEdit).toHaveBeenCalledTimes(edits ? 1 : 0);
  expect(onDeleted).not.toHaveBeenCalled();
  expect(item.style.transform).toBe('translateX(0)');
});

it('touch start and movement are passive, cancellation ends the gesture, and touch can delete', async () => {
  const { onDeleted, onEdit } = open();
  const item = host.querySelector<HTMLElement>('.meal-item')!;
  expect(touch(item, 'touchstart').defaultPrevented).toBe(false);
  expect(touch(item, 'touchmove', 50).defaultPrevented).toBe(false);
  touch(item, 'touchcancel');
  touch(item, 'touchend');
  expect(item.style.transform).toBe('translateX(0)');
  expect(onEdit).not.toHaveBeenCalled();
  expect(onDeleted).not.toHaveBeenCalled();
  touch(item, 'touchstart');
  touch(item, 'touchmove', 119);
  touch(item, 'touchend');
  await settle();
  expect(onDeleted).toHaveBeenCalledOnce();
});

it('accepted guest delete finishes, collapses over 0.2 seconds, and never submits the row again', async () => {
  const { meal: entry } = await meals.quickLog({ date: '2026-04-01', mealType: 'breakfast', name: 'Guest', calories: 200 });
  const { onDeleted } = open([entry]);
  const item = host.querySelector<HTMLElement>('.meal-item')!;
  const wrapper = item.parentElement!;
  swipe(item);
  await settle();
  expect((await meals.getByDate('2026-04-01')).meals).toEqual([]);
  expect(onDeleted).toHaveBeenCalledOnce();
  expect(item.style.transform).toBe('translateX(-100%)');
  expect(wrapper.style.height).toBe('0px');
  await vi.advanceTimersByTimeAsync(20);
  expect(wrapper.style.transition).toBe('height 0.2s, opacity 0.2s');
  expect(wrapper.style.opacity).toBe('0');
  swipe(item);
  await settle();
  expect(onDeleted).toHaveBeenCalledOnce();
});

it('pending HTTP deletes capture IDs, block only their row, and silently allow a live retry after failure', async () => {
  const { onDeleted } = open([meal(), meal({ id: 2 })]);
  setGuestMode(false);
  setToken('list-owner');
  const first = deferred<Response>(), second = deferred<Response>();
  const network = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    .mockResolvedValue(Response.json({ success: true }));
  vi.stubGlobal('fetch', network);
  const [one, two] = [...host.querySelectorAll<HTMLElement>('.meal-item')];
  one.parentElement!.dataset.id = '999';
  swipe(one);
  const pendingStyle = one.getAttribute('style');
  swipe(one);
  expect(one.getAttribute('style')).toBe(pendingStyle);
  expect(network).toHaveBeenCalledTimes(1);
  swipe(two);
  expect(network.mock.calls.map(call => call[0])).toEqual(['/api/meals/1', '/api/meals/2']);
  expect(network.mock.calls[0][1]).toMatchObject({ method: 'DELETE', credentials: 'include', headers: { Authorization: 'Bearer list-owner' } });
  const before = host.outerHTML;
  first.resolve(Response.json({ error: 'Failed' }, { status: 500 }));
  await settle();
  expect(host.outerHTML).toBe(before);
  expect(onDeleted).not.toHaveBeenCalled();
  swipe(one);
  await settle();
  expect(network).toHaveBeenCalledTimes(3);
  expect(onDeleted).toHaveBeenCalledOnce();
  second.resolve(Response.json({ success: true }));
  await settle();
  expect(onDeleted).toHaveBeenCalledTimes(2);
});

it('disconnected or ineligible mounts render nothing and cannot revive; a fresh mount works', () => {
  host.remove();
  const old = open();
  expect(host.innerHTML).toBe('');
  document.querySelector('main')!.append(host);
  expect(old.onAddFood).not.toHaveBeenCalled();
  open([meal()], () => false);
  expect(host.innerHTML).toBe('');
  const fresh = open();
  host.querySelector<HTMLButtonElement>('.btn-add-meal')!.click();
  expect(fresh.onAddFood).toHaveBeenCalledOnce();
});

it.each(['dispose', 'parent', 'root', 'ancestor', 'fixed replacement', '.meal-item-wrapper', '.meal-item', '.meal-items', '.btn-add-meal', '.meal-item-name', 'replace row', 'replace items'])(
  '%s departure permanently retires retained controls before and after observer delivery', async departure => {
    for (const delivered of [false, true]) {
      let current = true;
      const { onEdit, onAddFood, onDeleted } = open([meal()], () => current);
      const item = host.querySelector<HTMLElement>('.meal-item')!;
      const button = host.querySelector<HTMLButtonElement>('.btn-add-meal')!;
      start(item);
      if (departure === 'dispose') dispose();
      else if (departure === 'parent') current = false;
      else if (departure.startsWith('replace ')) departAndReconnect(host, 'fixed replacement', departure === 'replace row' ? '.meal-item' : '.meal-items');
      else departAndReconnect(host, departure, '.btn-add-meal');
      if (delivered) await Promise.resolve();
      const before = host.outerHTML;
      move(50);
      end();
      touch(item, 'touchcancel');
      swipe(item);
      start(item);
      end();
      button.click();
      await settle();
      expect(host.outerHTML).toBe(before);
      expect(onEdit).not.toHaveBeenCalled();
      expect(onAddFood).not.toHaveBeenCalled();
      expect(onDeleted).not.toHaveBeenCalled();
      dispose();
    }
  },
);

it('ordinary style changes and unrelated DOM mutation leave the list usable', async () => {
  const { onEdit, onAddFood } = open();
  host.querySelector<HTMLElement>('.meal-item')!.style.opacity = '0.9';
  const other = document.createElement('aside');
  document.body.append(other);
  other.remove();
  await Promise.resolve();
  host.querySelector<HTMLButtonElement>('.btn-add-meal')!.click();
  start(host.querySelector<HTMLElement>('.meal-item')!);
  end();
  expect(onEdit).toHaveBeenCalledOnce();
  expect(onAddFood).toHaveBeenCalledOnce();
});

it.each(['dispose', 'departure', 'parent'] as const)('%s cancels queued local frames once without resetting retained DOM', async retirement => {
  let current = true;
  open([meal()], () => current);
  const abort = vi.spyOn(AbortController.prototype, 'abort');
  const cancel = vi.spyOn(window, 'cancelAnimationFrame');
  swipe();
  await settle();
  if (retirement === 'dispose') dispose();
  else if (retirement === 'departure') departAndReconnect(host, '.meal-item');
  else {
    current = false;
    host.querySelector<HTMLButtonElement>('.btn-add-meal')!.click();
  }
  const before = host.outerHTML;
  await Promise.resolve();
  dispose();
  dispose();
  expect(abort).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(host.outerHTML).toBe(before);
});

it('accepted guest completion checks same-turn row departure before observer delivery', async () => {
  const { meal: entry } = await meals.quickLog({ date: '2026-04-01', mealType: 'breakfast', name: 'Guest' });
  const { onDeleted } = open([entry]);
  const animate = vi.spyOn(window, 'requestAnimationFrame');
  swipe();
  departAndReconnect(host, '.meal-item');
  const before = host.outerHTML;
  await settle();
  expect(onDeleted).toHaveBeenCalledOnce();
  expect((await meals.getByDate('2026-04-01')).meals).toEqual([]);
  expect(host.outerHTML).toBe(before);
  expect(animate).not.toHaveBeenCalled();
});

it.each(['success', 'failure'] as const)('accepted HTTP %s after retirement finishes without changing or reviving retained rows', async outcome => {
  const { onDeleted } = open();
  setGuestMode(false);
  const pending = deferred<Response>();
  const network = vi.fn().mockReturnValue(pending.promise);
  vi.stubGlobal('fetch', network);
  const item = host.querySelector<HTMLElement>('.meal-item')!;
  swipe(item);
  departAndReconnect(host, '.meal-item');
  await Promise.resolve();
  const before = host.outerHTML;
  pending.resolve(Response.json(outcome === 'success' ? { success: true } : { error: 'Failed' }, { status: outcome === 'success' ? 200 : 500 }));
  await settle();
  swipe(item);
  await vi.advanceTimersByTimeAsync(1000);
  expect(host.outerHTML).toBe(before);
  expect(onDeleted).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
  expect(network).toHaveBeenCalledExactlyOnceWith('/api/meals/1', expect.objectContaining({ method: 'DELETE' }));
});

it('Meal list shows a logged meal name as text', () => {
  const name = 'Apple<img alt="name">';
  const item = showMealItem(meal({ food_name: name, servings: 1 }));
  expect(item.querySelector('img')).toBeNull();
  expect(item.querySelector('.meal-item-name')!.textContent).toBe(name);
});

it('Meal list shows a logged meal brand as text', () => {
  const brand = 'Acme<img alt="brand">';
  const item = showMealItem(meal({ food_brand: brand, servings: 1 }));
  expect(item.querySelector('img')).toBeNull();
  expect(item.querySelector('.food-brand')!.textContent).toBe(brand);
});

it('Meal list keeps a high-calorie, low-protein meal partial', () => {
  const item = showMealItem(meal({ calories: 650, protein_g: 6 }));
  const section = item.closest('.meal-section')!;
  expect(section.classList.contains('partial')).toBe(true);
  expect(section.querySelector('.meal-macro-chips .chip-protein-hit')).toBeNull();
});

it('Meal list highlights a lean protein-pulse snack while its meal remains partial', () => {
  const item = showMealItem(meal({ meal_type: 'snack', calories: 200, protein_g: 31.9 }));
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
])('Meal list renders %s against unrounded daily / 4 targets', (_label, calories, protein, status, proteinHit) => {
  const item = showMealItem(meal({ calories, protein_g: protein, carbs_g: 0, fat_g: 0 }));
  const section = item.closest('.meal-section')!;
  expect(section.className.trim()).toBe(`meal-section ${status}`.trim());
  expect(section.querySelector('.meal-macro-chips .chip-protein')!.classList.contains('chip-protein-hit')).toBe(proteinHit);
});

it('Meal list leaves empty meals without a status or macro chips', () => {
  open([]);
  expect(host.querySelectorAll('.meal-empty')).toHaveLength(4);
  expect([...host.querySelectorAll('.meal-section')].every(section => section.className.trim() === 'meal-section')).toBe(true);
  expect(host.querySelector('.meal-macro-chips')).toBeNull();
});

it('Meal list sums logged foods before assessing the meal protein pulse', () => {
  open([
    meal({ calories: 300, protein_g: 20 }),
    meal({ id: 2, calories: 300, protein_g: 20 }),
  ]);
  const section = document.querySelector('.meal-section')!;
  expect(section.classList.contains('on-track')).toBe(true);
  expect(section.querySelector('.meal-macro-chips .chip-protein-hit')!.textContent).toBe('40/38p');
});


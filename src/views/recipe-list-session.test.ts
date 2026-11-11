import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Recipe } from '../types';
import { deferred } from '../test/food-search-fixtures';
import { mountRecipeList } from './recipe-list-session';

const recipe: Recipe = {
  id: 7, user_id: 1, name: 'Recipe bowl', total_servings: 2, serving_unit: 'bowl',
  manual_calories: null, manual_carbs_g: null, manual_protein_g: null, manual_fat_g: null,
  ingredientCount: 1, perServing: { calories: 101, carbsG: 10.1, proteinG: 5.1, fatG: 4.1 },
};
let host: HTMLElement;
const disposers: (() => void)[] = [];
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main><section><div id="host" class="food-list"></div></section></main>';
  host = document.querySelector<HTMLElement>('#host')!;
});

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose());
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mount(kind: 'manage' | 'meal' = 'manage', target = host) {
  const pending = deferred<{ recipes: Recipe[] }>();
  const read = vi.fn(() => pending.promise);
  const onSelect = vi.fn();
  const dispose = mountRecipeList(target, { kind, read, onSelect });
  disposers.push(dispose);
  return { ...pending, read, onSelect, dispose };
}

it('reads once, preserves returned order and Per-serving nutrition, and selects the captured Recipe', async () => {
  const session = mount();
  expect(host.textContent).toBe('Loading...');
  const next = { ...recipe, id: 2, name: 'Second recipe' };
  session.resolve({ recipes: [recipe, next] });
  await settle();
  expect(session.read).toHaveBeenCalledTimes(1);
  expect([...host.querySelectorAll('.food-item-name')].map(el => el.textContent)).toEqual(['Recipe bowl', 'Second recipe']);
  const row = host.querySelector<HTMLElement>('.food-item')!;
  expect([...row.querySelectorAll('.macro-chip')].map(el => [el.className, el.textContent])).toEqual([
    ['macro-chip chip-calories', '101'], ['macro-chip chip-carbs', '10.1c'],
    ['macro-chip chip-protein', '5.1p'], ['macro-chip chip-fat', '4.1f'],
  ]);
  row.querySelector<HTMLElement>('.chip-carbs')!.click();
  expect(session.onSelect).toHaveBeenCalledExactlyOnceWith(recipe);
});

it.each(['manage', 'meal'] as const)('%s renders returned names, serving labels and Macros as text', async kind => {
  const session = mount(kind);
  const returned: Recipe = JSON.parse(JSON.stringify({
    ...recipe, name: '<img src=x onerror=alert(1)>', serving_unit: '<b>bowl</b>',
    perServing: { calories: '<svg onload=alert(1)>', carbsG: 1.25, proteinG: 2.75, fatG: 0 },
  }));
  session.resolve({ recipes: [returned] });
  await settle();
  expect(host.querySelector('.food-item-name')!.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(host.querySelector('.food-serving')!.textContent).toBe('1 ingredient · 2 <b>bowl</b>s');
  expect([...host.querySelectorAll('.macro-chip')].map(el => el.textContent)).toEqual(['<svg onload=alert(1)>', '1.25c', '2.75p', '0f']);
  expect(host.querySelector('img, b, svg')).toBeNull();
});

it.each(['manage', 'meal'] as const)('%s uses the Manual macros rule, actual ingredient counts and serving fallback', async kind => {
  const session = mount(kind);
  session.resolve({ recipes: [
    { ...recipe, manual_calories: 0, ingredientCount: 3, total_servings: 1, serving_unit: '' },
    { ...recipe, ingredientCount: 0, serving_unit: '' },
    { ...recipe, total_servings: 1, serving_unit: 'cup' },
    { ...recipe, ingredientCount: 2, serving_unit: 'serving' },
    { ...recipe, manual_calories: 100 },
  ] });
  await settle();
  expect([...host.querySelectorAll('.food-serving')].map(el => el.textContent)).toEqual([
    'Manual macros · 1 serving', '0 ingredients · 2 servings', '1 ingredient · 1 cup',
    '2 ingredients · 2 servings', 'Manual macros · 2 bowls',
  ]);
});

it.each(['manage', 'meal'] as const)('%s retains its empty guidance', async kind => {
  const session = mount(kind);
  session.resolve({ recipes: [] });
  await settle();
  expect(host.textContent).toBe(kind === 'manage'
    ? 'No recipes yet. Create one to save your favorite meals!'
    : 'No recipes yet. Create one');
  if (kind === 'meal') expect(host.querySelector('a')!.getAttribute('href')).toBe('#/recipes');
  else expect(host.querySelector('a')).toBeNull();
});

it('shows a current failure and a fresh mount can read again', async () => {
  const old = mount();
  old.reject(new Error('Current read failed'));
  await settle();
  expect(host.querySelector('.form-error')!.textContent).toBe('Failed to load recipes');
  old.dispose();
  const next = mount();
  expect(host.textContent).toBe('Loading...');
  next.resolve({ recipes: [recipe] });
  await settle();
  expect(host.querySelector('.food-item-name')!.textContent).toBe('Recipe bowl');
});

it('two independently mounted hosts keep their own read and selection', async () => {
  const other = document.createElement('div');
  host.after(other);
  const first = mount();
  const second = mount('meal', other);
  second.resolve({ recipes: [{ ...recipe, id: 8, name: 'Other recipe' }] });
  await settle();
  expect(host.textContent).toBe('Loading...');
  first.resolve({ recipes: [recipe] });
  await settle();
  other.querySelector<HTMLElement>('.food-item')!.click();
  expect(first.onSelect).not.toHaveBeenCalled();
  expect(second.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }));
  expect(host.querySelector('.food-item-name')!.textContent).toBe('Recipe bowl');
});

it.each(['success', 'failure'] as const)('explicit repeated disposal prevents late %s without rewriting DOM', async outcome => {
  const session = mount();
  const before = host.innerHTML;
  session.dispose();
  session.dispose();
  if (outcome === 'success') session.resolve({ recipes: [recipe] });
  else session.reject(new Error('Disposed read'));
  await settle();
  expect(host.innerHTML).toBe(before);
  expect(session.onSelect).not.toHaveBeenCalled();
});

it('disposed rows and rows outside their host cannot select; cloned rows cannot impersonate current ones', async () => {
  const session = mount();
  session.resolve({ recipes: [recipe] });
  await settle();
  const row = host.querySelector<HTMLElement>('.food-item')!;
  const copy = row.cloneNode(true);
  host.append(copy);
  (copy as HTMLElement).click();
  host.after(row);
  row.click();
  host.append(row);
  const before = host.innerHTML;
  session.dispose();
  session.dispose();
  row.click();
  expect(session.onSelect).not.toHaveBeenCalled();
  expect(host.innerHTML).toBe(before);
});

const removalCases = ['host', 'parent', 'ancestor'] as const;
function remove(which: typeof removalCases[number]) {
  const removed = which === 'host' ? host : which === 'parent' ? host.parentElement! : host.closest('main')!;
  const parent = removed.parentElement!;
  removed.remove();
  return () => parent.append(removed);
}

it.each(removalCases)('%s removal and same-turn reinsertion permanently ends selection before observer delivery', async which => {
  const session = mount();
  session.resolve({ recipes: [recipe] });
  await settle();
  const row = host.querySelector<HTMLElement>('.food-item')!;
  const before = host.innerHTML;
  remove(which)();
  row.click();
  await settle();
  row.click();
  expect(session.onSelect).not.toHaveBeenCalled();
  expect(host.innerHTML).toBe(before);
});

it.each(removalCases.flatMap(which => (['success', 'failure'] as const).map(outcome => ({ which, outcome }))))(
  '$which removal and same-turn reinsertion prevents late $outcome', async ({ which, outcome }) => {
    const session = mount();
    const before = host.innerHTML;
    // Queue the read continuation before the removal observer's microtask.
    if (outcome === 'success') session.resolve({ recipes: [recipe] });
    else session.reject(new Error('Departed read'));
    remove(which)();
    await settle();
    expect(host.innerHTML).toBe(before);
    expect(session.onSelect).not.toHaveBeenCalled();
  },
);

it.each(removalCases)('%s removal stays permanent when reinsertion follows observer delivery', async which => {
  const session = mount();
  const reinsert = remove(which);
  await settle();
  reinsert();
  const before = host.innerHTML;
  session.resolve({ recipes: [recipe] });
  await settle();
  expect(host.innerHTML).toBe(before);
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountSavedFoodList } from './food-search-session';
import { deferred, food } from './test/food-search-fixtures';
import type { Food } from './types';

let host: HTMLElement;
const disposers: (() => void)[] = [];
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main><section><div id="host"></div></section></main>';
  host = document.querySelector<HTMLElement>('#host')!;
});

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose());
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mount(kind: 'recent' | 'custom' = 'recent', target = host) {
  const pending = deferred<{ foods: Food[] }>();
  const read = vi.fn(() => pending.promise);
  const onSelect = vi.fn();
  const onCreate = vi.fn();
  const dispose = mountSavedFoodList(target, { kind, read, onSelect, onCreate });
  disposers.push(dispose);
  return { ...pending, read, onSelect, onCreate, dispose };
}

it.each(['recent', 'custom'] as const)('%s reads immediately once, preserves literal rows and order, and selects the captured Food', async kind => {
  const session = mount(kind);
  expect(session.read).toHaveBeenCalledTimes(1);
  expect(host.innerHTML).toBe('<div class="loading-spinner">Loading...</div>');
  expect(host.querySelector('#create-food-btn')).toBeNull();
  const first = { ...food('Z<img src=x>'), brand: '<b>Brand</b>', serving_unit: '<i>unit</i>', calories: 101.7, carbs_g: 10.6, protein_g: 5.4, fat_g: 4.8 };
  const second = { ...food('A'), id: 2, measures: null };
  session.resolve({ foods: [first, second] });
  await settle();
  expect(host.querySelector('.loading-spinner')).toBeNull();
  expect(host.querySelector('img, b, i, .food-source')).toBeNull();
  const rows = [...host.querySelectorAll<HTMLElement>('.food-list > .food-item')];
  expect(rows.map(row => row.querySelector('.food-item-name')!.textContent)).toEqual(['Z<img src=x>', 'A']);
  expect(rows[0].querySelector('.food-item-info > .food-brand')!.textContent).toBe('<b>Brand</b>');
  expect(rows[1].querySelector('.food-brand')).toBeNull();
  expect(rows[0].querySelector('.food-serving')!.textContent).toBe('100<i>unit</i> · 2 units');
  expect(rows[1].querySelector('.food-serving')!.textContent).toBe('100g');
  expect([...rows[0].querySelectorAll('.food-item-macros > .macro-chip')].map(chip => [chip.className, chip.textContent])).toEqual([
    ['macro-chip chip-calories', '102'], ['macro-chip chip-carbs', '11c'],
    ['macro-chip chip-protein', '5p'], ['macro-chip chip-fat', '5f'],
  ]);
  rows[0].click();
  expect(session.onSelect).toHaveBeenCalledWith(first);
  if (kind === 'custom') {
    const create = host.querySelector<HTMLElement>('#create-food-btn')!;
    expect(host.firstElementChild).toBe(create);
    expect(create.className).toBe('btn btn-outline btn-block');
    expect(create.style.marginBottom).toBe('12px');
    expect(create.textContent).toBe('+ Create Custom Food');
    create.click();
    expect(session.onCreate).toHaveBeenCalledOnce();
  }
  expect(session.read).toHaveBeenCalledTimes(1);
});

it.each([null, '[]', 'not JSON', '{}', '[{"label":"cup"},{"label":"bowl"}]'])('preserves serving labels for measures %s', async measures => {
  const session = mount();
  session.resolve({ foods: [{ ...food('Apple'), measures }] });
  await settle();
  expect(host.querySelector('.food-serving')!.textContent).toBe(measures?.startsWith('[{"label"') ? '100g · 3 units' : '100g');
});

it.each(['recent', 'custom'] as const)('%s replaces loading with exact empty and failure feedback; only successful My Foods offers Create', async kind => {
  const empty = mount(kind);
  empty.resolve({ foods: [] });
  await settle();
  expect(host.querySelector('.text-muted')!.textContent).toBe(kind === 'recent' ? 'No recent foods' : 'No custom foods yet');
  expect(host.querySelector('.loading-spinner, .form-error, .food-list')).toBeNull();
  expect(host.querySelector('#create-food-btn') !== null).toBe(kind === 'custom');
  empty.dispose();
  const failure = mount(kind);
  failure.reject(new Error('Offline'));
  await settle();
  expect(host.innerHTML).toBe(kind === 'recent' ? '<p class="form-error">Failed to load recent foods</p>' : '<p class="form-error">Failed to load foods</p>');
});

it('independent hosts keep reads, feedback and selection separate even when reads resolve in reverse order', async () => {
  const other = document.createElement('div');
  host.after(other);
  const first = mount();
  const second = mount('custom', other);
  second.resolve({ foods: [food('Second')] });
  await settle();
  expect(host.textContent).toBe('Loading...');
  first.resolve({ foods: [food('First')] });
  await settle();
  other.querySelector<HTMLElement>('.food-item')!.click();
  expect(second.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Second' }));
  expect(first.onSelect).not.toHaveBeenCalled();
  expect(host.querySelector('.food-item-name')!.textContent).toBe('First');
});

it.each(['success', 'empty', 'failure'] as const)('idempotent disposal suppresses late %s without rewriting its departed DOM', async outcome => {
  const session = mount('custom');
  const before = host.innerHTML;
  session.dispose();
  session.dispose();
  if (outcome === 'failure') session.reject(new Error('Disposed read'));
  else session.resolve({ foods: outcome === 'empty' ? [] : [food('Old')] });
  await settle();
  expect(host.innerHTML).toBe(before);
});

it('retained rows and Create require their own host and stay inert after disposal and reinsertion', async () => {
  const session = mount('custom');
  session.resolve({ foods: [food('Apple')] });
  await settle();
  const controls = [...host.querySelectorAll<HTMLElement>('.food-item, #create-food-btn')];
  for (const control of controls) {
    host.after(control);
    control.click();
    host.append(control);
  }
  expect(session.onSelect).not.toHaveBeenCalled();
  expect(session.onCreate).not.toHaveBeenCalled();
  session.dispose();
  session.dispose();
  const before = host.innerHTML;
  controls.forEach(control => control.click());
  expect(host.innerHTML).toBe(before);
  expect(session.onSelect).not.toHaveBeenCalled();
  expect(session.onCreate).not.toHaveBeenCalled();
});

const removals = ['host', 'parent', 'ancestor'] as const;
function remove(which: typeof removals[number]) {
  const node = which === 'host' ? host : which === 'parent' ? host.parentElement! : host.closest('main')!;
  const parent = node.parentElement!;
  node.remove();
  return () => parent.append(node);
}

it.each(removals)('%s same-turn removal/reconnection permanently retires rows and Create before observer delivery', async which => {
  const session = mount('custom');
  session.resolve({ foods: [food('Apple')] });
  await settle();
  const row = host.querySelector<HTMLElement>('.food-item')!;
  const create = host.querySelector<HTMLElement>('#create-food-btn')!;
  const before = host.innerHTML;
  remove(which)();
  create.click();
  row.click();
  await settle();
  row.click();
  create.click();
  expect(session.onSelect).not.toHaveBeenCalled();
  expect(session.onCreate).not.toHaveBeenCalled();
  expect(host.innerHTML).toBe(before);
});

it.each(removals.flatMap(which => (['success', 'empty', 'failure'] as const).map(outcome => ({ which, outcome }))))(
  '$which same-turn removal/reconnection prevents queued $outcome from rewriting old hosts', async ({ which, outcome }) => {
    const session = mount('custom');
    const before = host.innerHTML;
    if (outcome === 'failure') session.reject(new Error('Departed read'));
    else session.resolve({ foods: outcome === 'empty' ? [] : [food('Old')] });
    remove(which)();
    await settle();
    expect(host.innerHTML).toBe(before);
  },
);

it.each(removals)('%s removal stays permanent after observer delivery and later reconnection', async which => {
  const session = mount();
  const reinsert = remove(which);
  await settle();
  reinsert();
  const before = host.innerHTML;
  session.resolve({ foods: [food('Old')] });
  await settle();
  expect(host.innerHTML).toBe(before);
});

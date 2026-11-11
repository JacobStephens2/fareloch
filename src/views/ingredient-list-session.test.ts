import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { mountIngredientListSession } from './ingredient-list-session';

function entry(name = 'Apple', servings = 1, unitLabel?: string) {
  return {
    food: { name, serving_size: 100, serving_unit: 'g', calories: 100, carbs_g: 10, protein_g: 5, fat_g: 4 },
    servings, unitLabel,
  };
}

let host: HTMLElement;
let dispose = () => {};

function open(entries = [entry()], isParentLive = () => true) {
  dispose();
  const onEdit = vi.fn(), onRemove = vi.fn();
  dispose = mountIngredientListSession(host, { entries, isParentLive, onEdit, onRemove });
  return { onEdit, onRemove };
}

function controls(row = host) {
  return {
    edit: row.querySelector<HTMLElement>('.ingredient-clickable')!,
    remove: row.querySelector<HTMLButtonElement>('.btn-remove-ing')!,
  };
}

beforeEach(() => {
  document.body.innerHTML = '<main><section id="list"></section><aside id="preview"></aside></main>';
  host = document.getElementById('list')!;
});
afterEach(() => dispose());

it('keeps entry order, literal Food names and supplied Unit labels, and whole-number Macros chips', () => {
  const entries = [entry('Apple<img alt="name"> & pear', 1.5, 'Cup<img alt="unit">'), entry('Second')];
  open(entries);
  expect([...host.querySelectorAll('.ingredient-name')].map(node => node.textContent)).toEqual(['Apple<img alt="name"> & pear', 'Second']);
  expect(host.querySelector('.ingredient-unit')!.textContent).toBe('Cup<img alt="unit">');
  expect(host.querySelector('img')).toBeNull();
  const row = host.querySelector('.ingredient-row')!;
  expect([...row.querySelectorAll('.macro-chip')].map(node => node.textContent)).toEqual(['150', '15c', '8p', '6f']);
  expect(row.querySelector('.ingredient-info.ingredient-clickable')!.getAttribute('data-idx')).toBe('0');
  expect(row.querySelector('.ingredient-macros .chip-calories')).not.toBeNull();
  expect(controls().remove.type).toBe('button');
  expect(controls().remove.classList.contains('btn-icon')).toBe(true);
  expect(controls().remove.textContent).toBe('×');
});

it.each([
  [100, 'g', 1.23456, undefined, '123.5g'],
  [100, 'g', 1.23456, '', '123.5g'],
  [100, '<b>oz</b>', 0.125, undefined, '12.5<b>oz</b>'],
  [0, 'g', 1, undefined, '1 serving'],
  [100, '', 1.236, undefined, '1.24 servings'],
  [0, '', 0.999, undefined, '1 servings'],
] as const)('keeps quantity fallback for %s %s at %s servings (%s)', (size, unit, servings, unitLabel, expected) => {
  const value = entry('Food', servings, unitLabel);
  value.food.serving_size = size;
  value.food.serving_unit = unit;
  open([value]);
  expect(host.querySelector('.ingredient-unit')!.textContent).toBe(expected);
  expect(host.querySelector('b')).toBeNull();
});

it('captures entry order and presentation once, retaining exact duplicate-Food occurrence identities for callbacks', () => {
  const first = entry('Same Food');
  const second = { ...first, servings: 2 };
  const entries = [first, second];
  const { onEdit, onRemove } = open(entries);
  const before = host.outerHTML;
  first.food.name = 'Changed later';
  first.food.calories = 999;
  first.servings = 10;
  second.unitLabel = 'Changed label';
  entries.reverse();
  entries.push(entry('Appended later'));
  expect(host.outerHTML).toBe(before);
  const [one, two] = [...host.querySelectorAll<HTMLElement>('.ingredient-row')].map(row => controls(row));
  one.edit.dataset.idx = '1';
  two.remove.dataset.idx = '0';
  one.edit.click();
  one.edit.click();
  two.edit.click();
  two.remove.click();
  one.remove.click();
  expect(onEdit.mock.calls.map(([value]) => value)).toEqual([first, first, second]);
  expect(onEdit.mock.calls[0][0]).toBe(first);
  expect(onEdit.mock.calls[2][0]).toBe(second);
  expect(onRemove.mock.calls[0][0]).toBe(second);
  expect(onRemove.mock.calls[1][0]).toBe(first);
});

it('accepts each row Remove once, including reentrant clicks, while live Edit can reopen', () => {
  const { onEdit, onRemove } = open([entry(), entry('Second')]);
  const [first, second] = [...host.querySelectorAll<HTMLElement>('.ingredient-row')].map(row => controls(row));
  onRemove.mockImplementation(() => first.remove.click());
  first.edit.click();
  first.edit.click();
  first.remove.click();
  first.remove.click();
  second.remove.click();
  expect(onRemove).toHaveBeenCalledTimes(2);
  expect(onEdit).toHaveBeenCalledTimes(2);
});

it('renders an empty list and disposes it without changing retained DOM', () => {
  host.innerHTML = '<p>Old rows</p>';
  const { onEdit, onRemove } = open([]);
  expect(host.innerHTML).toBe('');
  dispose();
  dispose();
  expect(host.innerHTML).toBe('');
  expect(onEdit).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();
});

it.each(['disconnected', 'parent'])('initially %s mounting changes no DOM; a fresh eligible mount works', eligibility => {
  host.innerHTML = '<button class="ingredient-clickable">Retained</button><button class="btn-remove-ing">×</button>';
  const retained = controls();
  if (eligibility === 'disconnected') host.remove();
  let eligible = eligibility !== 'parent';
  const before = host.outerHTML;
  const old = open([entry()], () => eligible);
  expect(host.outerHTML).toBe(before);
  document.querySelector('main')!.append(host);
  eligible = true;
  retained.edit.click();
  retained.remove.click();
  expect(host.outerHTML).toBe(before);
  expect(old.onEdit).not.toHaveBeenCalled();
  expect(old.onRemove).not.toHaveBeenCalled();
  dispose();
  dispose();
  const fresh = open();
  controls().edit.click();
  controls().remove.click();
  expect(fresh.onEdit).toHaveBeenCalledOnce();
  expect(fresh.onRemove).toHaveBeenCalledOnce();
});

it('replacement leaves retained rows inert without touching successor DOM, before observer delivery', () => {
  const old = open();
  const retained = controls();
  const oldRow = host.firstElementChild!;
  const fresh = open([entry('Successor')]);
  host.append(oldRow);
  const before = host.outerHTML;
  retained.edit.click();
  retained.remove.click();
  expect(host.outerHTML).toBe(before);
  expect(old.onEdit).not.toHaveBeenCalled();
  expect(old.onRemove).not.toHaveBeenCalled();
  controls().edit.click();
  controls().remove.click();
  expect(fresh.onEdit).toHaveBeenCalledOnce();
  expect(fresh.onRemove).toHaveBeenCalledOnce();
});

it.each(['root', 'ancestor', '.ingredient-row', '.ingredient-name', '.btn-remove-ing'])(
  '%s stays retired when reconnection follows observer delivery', async departure => {
    const old = open();
    const retained = controls();
    const node = departure === 'root' ? host : departure === 'ancestor' ? host.parentElement!
      : host.querySelector(departure)!;
    const parent = node.parentNode!;
    node.remove();
    retained.edit.click();
    retained.remove.click();
    await Promise.resolve();
    const before = node instanceof HTMLElement ? node.outerHTML : node.textContent;
    parent.appendChild(node);
    retained.edit.click();
    retained.remove.click();
    expect(node instanceof HTMLElement ? node.outerHTML : node.textContent).toBe(before);
    expect(old.onEdit).not.toHaveBeenCalled();
    expect(old.onRemove).not.toHaveBeenCalled();
    const fresh = open();
    controls().remove.click();
    expect(fresh.onRemove).toHaveBeenCalledOnce();
  },
);

it.each(['dispose', 'parent', 'root', 'ancestor', '.ingredient-row', '.ingredient-info', '.ingredient-name', '.ingredient-unit', '.ingredient-macros', '.macro-chip', '.btn-remove-ing', 'fixed replacement'])(
  '%s departure permanently retires the whole list before and after observer delivery', async departure => {
    for (const delivered of [false, true]) {
      let eligible = true;
      const old = open([entry(), entry('Second')], () => eligible);
      const retained = [...host.querySelectorAll<HTMLElement>('.ingredient-row')].map(row => controls(row));
      if (departure === 'dispose') { dispose(); dispose(); }
      else if (departure === 'parent') eligible = false;
      else departAndReconnect(host, departure, '.ingredient-row');
      if (delivered) await Promise.resolve();
      const before = host.outerHTML;
      for (const { edit, remove } of retained) { edit.click(); remove.click(); }
      eligible = true;
      await Promise.resolve();
      for (const { edit, remove } of retained) { edit.click(); remove.click(); }
      expect(host.outerHTML).toBe(before);
      expect(old.onEdit).not.toHaveBeenCalled();
      expect(old.onRemove).not.toHaveBeenCalled();
      const fresh = open();
      controls().edit.click();
      expect(fresh.onEdit).toHaveBeenCalledOnce();
    }
  },
);

it('style changes, hiding the ingredient section, previews and unrelated mutations keep rows eligible', async () => {
  const { onEdit, onRemove } = open();
  host.querySelector<HTMLElement>('.ingredient-row')!.style.opacity = '0.9';
  host.parentElement!.classList.add('hidden');
  document.querySelector('#preview')!.innerHTML = '<strong>Updated totals</strong>';
  const other = document.createElement('aside');
  document.body.append(other);
  other.remove();
  await Promise.resolve();
  host.parentElement!.classList.remove('hidden');
  controls().edit.click();
  controls().remove.click();
  expect(onEdit).toHaveBeenCalledOnce();
  expect(onRemove).toHaveBeenCalledOnce();
});

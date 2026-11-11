import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMountedLifetime } from '../mounted-lifetime';
import { food } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { mountIngredientEditSession } from './ingredient-edit-session';

const disposers: (() => void)[] = [];
const find = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const click = (id: string) => find(id).click();
const snapshot = () => ({
  html: find('ing-modal').outerHTML,
  quantity: find<HTMLInputElement>('ing-qty').value,
  unit: find<HTMLSelectElement>('ing-unit-select').value,
});
function mount(kind: 'add' | 'edit' = 'add', isEligible = () => true, modal = find('ing-modal')) {
  const applied = vi.fn();
  const dispose = mountIngredientEditSession(modal, food('Apple'), kind === 'add'
    ? { kind } : { kind, servings: 4, quantity: 2 }, isEligible, applied);
  disposers.push(dispose);
  return { applied, dispose };
}
function actOn(controls: HTMLElement[]) {
  // Quantity acts before Close so an earlier action cannot mask a live quantity child.
  for (const control of [...controls.filter(control => control.id !== 'ing-modal-close'), ...controls.filter(control => control.id === 'ing-modal-close')]) {
    control.dispatchEvent(new MouseEvent('click'));
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new Event('change'));
  }
}

beforeEach(() => {
  document.body.innerHTML = '<main><button id="parent-fixed">Back</button><div id="ing-modal" class="hidden"><section><header><h2 id="ing-modal-name"></h2><button id="ing-modal-close">Close</button></header><div id="ing-modal-body"></div></section></div></main>';
});
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

it.each(['add', 'edit'] as const)('%s composes captured details, stored quantities, measures and Display rounding', kind => {
  const { applied } = mount(kind);
  expect(find('ing-modal-name').textContent).toBe('Apple');
  expect(find('ing-add-btn').textContent).toBe(kind === 'edit' ? 'Update' : 'Add Ingredient');
  expect(find<HTMLInputElement>('ing-qty').value).toBe(kind === 'edit' ? '2' : '1');
  expect(find('ing-modal-total').textContent).toContain(kind === 'edit' ? '400 kcal' : '100 kcal');
  find<HTMLSelectElement>('ing-unit-select').value = '0';
  find('ing-unit-select').dispatchEvent(new Event('change'));
  expect(find('ing-modal-per-label').textContent).toBe('Per cup (200g)');
  click('ing-qty-plus');
  click('ing-add-btn');
  expect(applied.mock.calls).toEqual([[{
    kind: 'apply', quantity: kind === 'edit' ? 3 : 2, servings: kind === 'edit' ? 6 : 4,
    unitLabel: kind === 'edit' ? '3x cup' : '2x cup',
  }]]);
});

it.each(['add', 'update', 'remove'] as const)('%s retires before publishing, emits once and cannot alter a callback-opened successor', action => {
  const modal = find('ing-modal');
  let successor: ReturnType<typeof mount>;
  const applied = vi.fn(() => { successor = mount(); });
  disposers.push(mountIngredientEditSession(modal, food('Original'), action === 'add'
    ? { kind: 'add' } : { kind: 'edit', servings: 1 }, () => true, applied));
  const controls = [...modal.querySelectorAll<HTMLElement>('button,input,select')];
  const actionButton = find(action === 'remove' ? 'ing-remove-btn' : 'ing-add-btn');
  actionButton.click();
  modal.append(...controls.filter(control => control.id !== 'ing-modal-close'));
  const before = snapshot();
  actOn(controls.filter(control => control.id !== 'ing-modal-close'));
  expect(applied).toHaveBeenCalledOnce();
  expect(applied.mock.calls[0]).toEqual([action === 'remove'
    ? { kind: 'remove' } : { kind: 'apply', quantity: 1, servings: 1, unitLabel: '100g' }]);
  expect(snapshot()).toEqual(before);
  expect(modal.classList.contains('hidden')).toBe(false);
  expect(successor!.applied).not.toHaveBeenCalled();
});

it.each(['add', 'edit'] as const)('%s Close, explicit disposal and parent retirement permanently end actions and quantity', kind => {
  for (const how of ['close', 'dispose', 'parent']) {
    let live = true;
    const { applied, dispose } = mount(kind, () => live);
    const initial = snapshot();
    if (how === 'close') click('ing-modal-close');
    else if (how === 'dispose') { dispose(); dispose(); expect(snapshot()).toEqual(initial); }
    else live = false;
    click('ing-qty-plus');
    live = true;
    const before = snapshot();
    actOn([...find('ing-modal').querySelectorAll<HTMLElement>('button,input,select')]);
    expect(snapshot()).toEqual(before);
    expect(applied).not.toHaveBeenCalled();
    if (how === 'close') expect(find('ing-modal').classList.contains('hidden')).toBe(true);
    dispose();
  }
});

it.each(['add', 'edit'] as const)('%s fixed controls and captured ancestors retire across removal/reconnection before or after observer delivery', async kind => {
  for (const departure of ['root', 'ancestor', 'fixed replacement', 'section', 'header', '#ing-modal-name', '#ing-modal-close', '#ing-modal-body', '.form-row', '#ing-add-btn', ...(kind === 'edit' ? ['#ing-remove-btn'] : []), '#ingredient-quantity', '.servings-control', '#ing-qty', '#ing-qty-plus', '#ing-qty-minus', '#ing-unit-select', '#ing-modal-per-unit', '#ing-modal-per-label', '#ing-modal-total']) {
    for (const delivered of [false, true]) {
      const { applied, dispose } = mount(kind);
      const modal = find('ing-modal');
      const controls = [...modal.querySelectorAll<HTMLElement>('button,input,select')];
      departAndReconnect(modal, departure, '#ing-add-btn');
      if (delivered) await Promise.resolve();
      const before = snapshot();
      actOn(controls);
      expect(snapshot(), `${departure}, observer=${delivered}`).toEqual(before);
      expect(applied).not.toHaveBeenCalled();
      dispose();
    }
  }
});

it.each(['add', 'edit'] as const)('%s replacement retires retained actions and quantities while fresh controls remain independent', kind => {
  const { applied } = mount(kind);
  const controls = [...find('ing-modal-body').querySelectorAll<HTMLElement>('button,input,select')];
  const fresh = mount(kind);
  find('ing-modal').append(...controls);
  const before = snapshot();
  actOn(controls);
  expect(snapshot()).toEqual(before);
  expect(applied).not.toHaveBeenCalled();
  click('ing-qty-plus');
  click('ing-add-btn');
  expect(fresh.applied).toHaveBeenCalledOnce();
});

it.each(['add', 'edit'] as const)('%s initially ineligible mounts preserve retained DOM; fresh mounts work independently', kind => {
  mount(kind).dispose();
  const modal = find('ing-modal');
  const parent = modal.parentElement!;
  for (const how of ['disconnected', 'ineligible']) {
    if (how === 'disconnected') modal.remove();
    const before = modal.outerHTML;
    const { applied } = mount(kind, () => how !== 'ineligible', modal);
    if (how === 'disconnected') parent.append(modal);
    actOn([...modal.querySelectorAll<HTMLElement>('button,input,select')]);
    expect(modal.outerHTML).toBe(before);
    expect(applied).not.toHaveBeenCalled();
  }
  mount(kind);
  click('ing-qty-plus');
  expect(find<HTMLInputElement>('ing-qty').value).toBe(kind === 'edit' ? '3' : '2');
});

it('fixed parent departure retires quantity and actions while the modal stays connected', () => {
  const parent = createMountedLifetime(document.querySelector('main')!, { ownedNodes: [find('parent-fixed')] });
  disposers.push(parent.dispose);
  const { applied } = mount('edit', parent.isLive);
  departAndReconnect(document.querySelector('main')!, '#parent-fixed');
  const before = snapshot();
  actOn([...find('ing-modal').querySelectorAll<HTMLElement>('button,input,select')]);
  expect(snapshot()).toEqual(before);
  expect(applied).not.toHaveBeenCalled();
});

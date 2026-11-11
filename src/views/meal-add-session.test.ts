import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, recipes, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { createMountedLifetime } from '../mounted-lifetime';
import { deferred, food } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { mountMealAddSession } from './meal-add-session';

type Kind = 'food' | 'recipe';
const date = '2026-04-01';
const disposers: (() => void)[] = [];
const find = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const click = (id: string) => find<HTMLButtonElement>(id).click();
const input = (value: string) => {
  find<HTMLInputElement>('servings-input').value = value;
  find('servings-input').dispatchEvent(new Event('input'));
};
const unit = (value: string) => {
  find<HTMLSelectElement>('unit-select').value = value;
  find('unit-select').dispatchEvent(new Event('change'));
};
const figures = () => find('modal-total').textContent!.replace(/\s/g, '');
const snapshot = () => ({
  html: find('food-detail-modal').outerHTML,
  quantity: find<HTMLInputElement>('servings-input').value,
  unit: find<HTMLSelectElement>('unit-select')?.value,
});

async function selection(kind: Kind, name: string = kind) {
  if (kind === 'food') return { kind, food: (await foods.create({
    ...food(name), calories: 100.25, carbs_g: 10.25, protein_g: 5.25, fat_g: 4.25,
  })).food } as const;
  const created = await recipes.create({
    name, totalServings: 3, servingUnit: 'bowl', ingredients: [],
    manualCalories: 302, manualCarbsG: 30.3, manualProteinG: 15.3, manualFatG: 12.3,
  });
  return { kind, recipe: (await recipes.get(created.recipe.id)).recipe } as const;
}

function mount(value: Awaited<ReturnType<typeof selection>>, isParentLive = () => true, modal = find('food-detail-modal')) {
  const saved = vi.fn();
  const dispose = mountMealAddSession(modal, value, date, 'dinner', isParentLive, saved);
  disposers.push(dispose);
  return { saved, dispose };
}

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  document.body.innerHTML = '<main><button id="parent-fixed">Back</button><div id="food-detail-modal" class="hidden"><section><h2 id="modal-food-name"></h2><button id="modal-close">Close</button><div id="modal-body"></div></section></div></main>';
});

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('Food composes exact initial figures, household measures and Stored rounding through the guest adapter', async () => {
  const value = await selection('food');
  const { saved } = mount(value);
  expect(figures()).toBe('100.25kcal10.25gC5.25gP4.25gF');
  expect(find('modal-per-label').textContent).toBe('Per 100g');
  expect(find('add-food-btn').textContent).toBe('Add to Dinner');
  input('1.5');
  unit('0');
  expect(find('modal-per-label').textContent).toBe('Per cup (200g)');
  expect(figures()).toBe('301kcal30.8gC15.8gP12.8gF');
  click('add-food-btn');
  await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect((await meals.getByDate(date)).meals[0]).toMatchObject({
    date, meal_type: 'dinner', food_id: value.kind === 'food' ? value.food.id : 0,
    servings: 3, unit_label: 'cup', unit_scale: 2,
    calories: 300.8, carbs_g: 30.8, protein_g: 15.8, fat_g: 12.8,
  });
});

it('Recipe previews multiply received Display rounding while guest persistence retains its existing Stored rounding', async () => {
  mount(await selection('recipe'));
  expect(find('recipe-per-label').textContent).toBe('Per bowl (3 total)');
  expect(figures()).toBe('101kcal10.1gC5.1gP4.1gF');
  input('1.5');
  expect(figures()).toBe('152kcal15.2gC7.7gP6.1gF');
  click('add-food-btn');
  expect((await meals.getByDate(date)).meals[0]).toMatchObject({
    servings: 1.5, calories: 151, carbs_g: 15.2, protein_g: 7.7, fat_g: 6.2,
  });
});

it.each(['food', 'recipe'] as const)('%s quantity retains minimum, fractions, plus/minus and parse fallback', async kind => {
  mount(await selection(kind));
  click('serv-minus');
  expect(find<HTMLInputElement>('servings-input').value).toBe('1');
  input('1.5');
  click('serv-plus');
  expect(find<HTMLInputElement>('servings-input').value).toBe('2.5');
  click('serv-minus');
  expect(find<HTMLInputElement>('servings-input').value).toBe('1.5');
  input('');
  click('serv-plus');
  expect(find<HTMLInputElement>('servings-input').value).toBe('2');
  input('0');
  click('add-food-btn');
  expect((await meals.getByDate(date)).meals[0].servings).toBe(1);
});

it.each((['food', 'recipe'] as const).flatMap(from =>
  (['food', 'recipe'] as const).map(to => ({ from, to }))))('$from replacement by $to permanently retires retained Add and quantity controls', async ({ from, to }) => {
  const first = await selection(from, 'A');
  const second = await selection(to, 'B');
  const old = mount(first);
  input('3');
  const controls = [...find('modal-body').querySelectorAll<HTMLElement>('button,input,select')];
  mount(second);
  // Replacement itself must retire the predecessor, even before its observer fires.
  find('food-detail-modal').append(...controls);
  const before = snapshot();
  for (const control of controls) {
    control.dispatchEvent(new MouseEvent('click'));
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new Event('change'));
  }
  expect(snapshot()).toEqual(before);
  expect((await meals.getByDate(date)).meals).toHaveLength(0);
  expect(old.saved).not.toHaveBeenCalled();
});

it.each(['food', 'recipe'] as const)('%s fixed controls and ancestors retire permanently across synchronous reconnection', async kind => {
  const value = await selection(kind);
  for (const departure of ['root', 'ancestor', 'fixed replacement', '#modal-food-name', '#modal-close', '#modal-body', '#add-food-btn', '#servings-input', '#serv-plus', '#serv-minus', '#modal-total', ...(kind === 'food' ? ['#food-quantity', '#modal-per-unit', '#modal-per-label', '#unit-select'] : ['#recipe-per-label', '.modal-macros'])]) {
    for (const delivered of [false, true]) {
      const { dispose, saved } = mount(value);
      const controls = [...find('food-detail-modal').querySelectorAll<HTMLElement>('button,input,select')];
      departAndReconnect(find('food-detail-modal'), departure, '#add-food-btn');
      if (delivered) await Promise.resolve();
      const before = snapshot();
      for (const control of controls) {
        control.dispatchEvent(new MouseEvent('click'));
        control.dispatchEvent(new Event('input'));
        control.dispatchEvent(new Event('change'));
      }
      expect(snapshot(), `${departure}, observer=${delivered}`).toEqual(before);
      expect((await meals.getByDate(date)).meals).toHaveLength(0);
      expect(saved).not.toHaveBeenCalled();
      dispose();
    }
  }
});

it.each(['food', 'recipe'] as const)('%s Close, disposal and parent retirement release controls without reviving', async kind => {
  const value = await selection(kind);
  for (const how of ['close', 'dispose', 'parent']) {
    let live = true;
    const { dispose } = mount(value, () => live);
    const initial = snapshot();
    if (how === 'close') click('modal-close');
    else if (how === 'dispose') { dispose(); dispose(); expect(snapshot()).toEqual(initial); }
    else live = false;
    const before = snapshot();
    click('serv-plus');
    live = true;
    click('serv-plus');
    click('add-food-btn');
    expect(snapshot()).toEqual(before);
    expect((await meals.getByDate(date)).meals).toHaveLength(0);
    if (how === 'close') expect(find('food-detail-modal').classList.contains('hidden')).toBe(true);
  }
});

it.each(['food', 'recipe'] as const)('%s initially disconnected or retired-parent mount is inert, and a fresh mount is independent', async kind => {
  const value = await selection(kind);
  const modal = find('food-detail-modal');
  const parent = modal.parentElement!;
  const initial = mount(value);
  initial.dispose();
  modal.remove();
  const before = modal.outerHTML;
  mount(value, () => true, modal);
  parent.append(modal);
  expect(modal.outerHTML).toBe(before);
  click('serv-plus');
  click('add-food-btn');
  expect(modal.outerHTML).toBe(before);
  expect((await meals.getByDate(date)).meals).toHaveLength(0);
  mount(value, () => false);
  expect(modal.outerHTML).toBe(before);
  mount(value);
  click('serv-plus');
  expect(find<HTMLInputElement>('servings-input').value).toBe('2');
});

it.each(['food', 'recipe'] as const)('%s fixed parent departure retires child controls while its modal stays connected', async kind => {
  const parent = createMountedLifetime(document.querySelector('main')!, { ownedNodes: [find('parent-fixed')] });
  disposers.push(parent.dispose);
  mount(await selection(kind), parent.isLive);
  departAndReconnect(document.querySelector('main')!, '#parent-fixed');
  const before = snapshot();
  click('serv-plus');
  if (kind === 'food') unit('0');
  click('add-food-btn');
  expect(find('food-detail-modal').outerHTML).toBe(before.html);
  expect(find<HTMLInputElement>('servings-input').value).toBe(before.quantity);
  expect((await meals.getByDate(date)).meals).toHaveLength(0);
});

it.each(['food', 'recipe'] as const)('%s pending Add rejects synthetic duplicates, retries live failure and captures authenticated payloads', async kind => {
  const value = await selection(kind);
  const { saved } = mount(value);
  setGuestMode(false);
  setToken('meal-token');
  const write = deferred<Response>();
  const network = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue(Response.json({ meal: { id: 1 } }));
  vi.stubGlobal('fetch', network);
  input('1.5');
  if (kind === 'food') unit('0');
  click('add-food-btn');
  find<HTMLButtonElement>('add-food-btn').disabled = false;
  find('add-food-btn').dispatchEvent(new MouseEvent('click'));
  expect(network).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0]).toEqual(['/api/meals', expect.objectContaining({
    method: 'POST', credentials: 'include', headers: expect.objectContaining({ Authorization: 'Bearer meal-token' }),
  })]);
  expect(JSON.parse(network.mock.calls[0][1].body)).toEqual({
    date, mealType: 'dinner', ...(value.kind === 'food'
      ? { foodId: value.food.id, servings: 3, unitLabel: 'cup', unitScale: 2 }
      : { recipeId: value.recipe.id, servings: 1.5 }),
  });
  write.reject(new Error('offline'));
  await vi.waitFor(() => expect(find('add-food-btn').textContent).toBe('Failed - Retry'));
  expect(find<HTMLButtonElement>('add-food-btn').disabled).toBe(false);
  click('add-food-btn');
  await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(network).toHaveBeenCalledTimes(2);
});

it.each(['food', 'recipe'] as const)('%s retired failures leave captured and successor DOM unchanged before observer delivery', async kind => {
  const value = await selection(kind);
  for (const retirement of ['close', 'dispose', 'replacement', 'ancestor', 'add', 'parent']) {
    let live = true;
    const { dispose, saved } = mount(value, () => live);
    setGuestMode(false);
    const write = deferred<Response>();
    vi.stubGlobal('fetch', () => write.promise);
    click('add-food-btn');
    const retained = find('modal-body');
    const oldAdd = find('add-food-btn');
    write.reject(new Error('offline'));
    if (retirement === 'close') click('modal-close');
    else if (retirement === 'dispose') dispose();
    else if (retirement === 'replacement') mount(value);
    else if (retirement === 'parent') live = false;
    else departAndReconnect(find('food-detail-modal'), retirement === 'add' ? '#add-food-btn' : 'ancestor');
    const before = snapshot();
    const retainedHTML = retained.outerHTML;
    const addHTML = oldAdd.outerHTML;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(snapshot()).toEqual(before);
    expect(retained.outerHTML).toBe(retainedHTML);
    expect(oldAdd.outerHTML).toBe(addHTML);
    expect(saved).not.toHaveBeenCalled();
    dispose();
    setGuestMode(true);
  }
});

it.each(['food', 'recipe'] as const)('%s accepted guest write keeps captured inputs and notifies its original owner after local retirement', async kind => {
  const value = await selection(kind);
  for (const retirement of ['close', 'dispose', 'replacement', 'parent']) {
    const parent = createMountedLifetime(document.querySelector('main')!, { ownedNodes: [find('parent-fixed')] });
    disposers.push(parent.dispose);
    const { saved, dispose } = mount(value, parent.isLive);
    input('1.5');
    if (kind === 'food') unit('0');
    click('add-food-btn');
    // The real guest write has completed; its continuation precedes observer delivery.
    input('9');
    if (retirement === 'close') click('modal-close');
    else if (retirement === 'dispose') dispose();
    else if (retirement === 'replacement') mount(value);
    else departAndReconnect(document.querySelector('main')!, '#parent-fixed');
    const before = snapshot();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(snapshot()).toEqual(before);
    expect((await meals.getByDate(date)).meals.slice(-1)[0]).toMatchObject({
      date, meal_type: 'dinner', ...(value.kind === 'food'
        ? { food_id: value.food.id, servings: 3, unit_label: 'cup', unit_scale: 2, calories: 300.8 }
        : { recipe_id: value.recipe.id, servings: 1.5, calories: 151 }),
    });
    parent.dispose();
  }
});

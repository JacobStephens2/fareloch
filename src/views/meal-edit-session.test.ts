import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, recipes, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { deferred } from '../test/food-search-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { mountMealEditSession } from './meal-edit-session';

type Kind = 'food' | 'recipe' | 'quick';
const date = '2026-04-01';
let dispose = () => {};
const find = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const click = (id: string) => find<HTMLButtonElement>(id).click();
const input = (id: string, value: string) => {
  find<HTMLInputElement>(id).value = value;
  find(id).dispatchEvent(new Event('input'));
};

async function entry(kind: Kind) {
  if (kind === 'quick') return (await meals.quickLog({ date, mealType: 'breakfast', name: 'Quick meal', calories: 200, carbsG: 20, proteinG: 10, fatG: 8 })).meal;
  const reference = kind === 'food'
    ? { foodId: (await foods.create({ name: 'Apple', brand: 'Acme<img>', serving_size: 100, serving_unit: 'g', calories: 66.7, carbs_g: 6.7, protein_g: 3.3, fat_g: 2.7 })).food.id }
    : { recipeId: (await recipes.create({ name: 'Recipe', totalServings: 1, ingredients: [], manualCalories: 66.7, manualCarbsG: 6.7, manualProteinG: 3.3, manualFatG: 2.7 })).recipe.id };
  return (await meals.log({ date, mealType: 'breakfast', ...reference, servings: 3, unitLabel: 'cup<img>', unitScale: 1.5, note: 'Keep note' })).meal;
}

async function open(kind: Kind = 'quick', parentIsCurrent = () => true) {
  const meal = await entry(kind);
  const saved = vi.fn();
  dispose = mountMealEditSession(find('edit-meal-modal'), meal, parentIsCurrent, saved);
  return { meal, saved };
}

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  document.body.innerHTML = '<main><div id="edit-meal-modal" class="hidden"><section><h2 id="edit-meal-name"></h2><button id="edit-modal-close">Close</button><div id="edit-meal-body"></div></section></div></main>';
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['food', 'recipe'] as const)('%s edits derive quantity previews and Stored rounding from the captured meal', async kind => {
  const { meal, saved } = await open(kind);
  expect(find<HTMLInputElement>('edit-servings').value).toBe('2');
  expect(find('edit-total').textContent).toContain('200 kcal');
  expect(find('edit-per-label').textContent).toBe('Per cup<img>');
  expect(find('edit-qty-label').textContent).toBe('cup<img>');
  expect(document.querySelector('img')).toBeNull();
  if (kind === 'food') expect(document.querySelector('.food-brand')!.textContent).toBe('Acme<img>');
  // Catalogue changes must not replace the stored meal's nutrition.
  if (meal.recipe_id) await recipes.update(meal.recipe_id, { manualCalories: 999 });
  click('edit-serv-plus');
  expect(find('edit-total').textContent).toContain('300 kcal');
  expect(find('edit-total').textContent).toContain('14.9g P');
  find<HTMLSelectElement>('edit-meal-type').value = 'dinner';
  click('edit-save-btn');
  await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect((await meals.getByDate(date)).meals[0]).toEqual({ ...meal, servings: 4.5, meal_type: 'dinner', calories: 300.2, carbs_g: 30.2, protein_g: 14.9, fat_g: 12.1 });
  expect(find('edit-meal-modal').classList.contains('hidden')).toBe(true);
  expect(find('edit-meal-body').children).toHaveLength(0);
});

it.each(['food', 'recipe'] as const)('%s quantities preserve minimum, plus and parse fallback', async kind => {
  await open(kind);
  input('edit-servings', '1');
  click('edit-serv-minus');
  expect(find<HTMLInputElement>('edit-servings').value).toBe('1');
  input('edit-servings', '');
  click('edit-serv-plus');
  expect(find<HTMLInputElement>('edit-servings').value).toBe('2');
  input('edit-servings', '0');
  expect(find('edit-total').textContent).toContain('100 kcal');
  click('edit-save-btn');
  expect((await meals.getByDate(date)).meals[0]).toMatchObject({ servings: 1.5, calories: 100.1 });
});

it('initial displayed quantity keeps two decimals and default unit labels', async () => {
  const meal = await entry('food');
  dispose = mountMealEditSession(find('edit-meal-modal'), { ...meal, servings: 1, unit_scale: 3, unit_label: null }, () => true, () => {});
  expect(find<HTMLInputElement>('edit-servings').value).toBe('0.33');
  expect(find('edit-per-label').textContent).toBe('Per 100g');
  expect(find('edit-qty-label').textContent).toBe('Servings');
});

it('zero servings and Unit scale retain the existing quantity fallback', async () => {
  const meal = await entry('food');
  dispose = mountMealEditSession(find('edit-meal-modal'), { ...meal, servings: 0, unit_scale: 0, unit_label: null, serving_size: null, serving_unit: null }, () => true, () => {});
  expect(find<HTMLInputElement>('edit-servings').value).toBe('0');
  expect(find('edit-per-label').textContent).toBe('Per serving');
  input('edit-servings', '');
  click('edit-save-btn');
  expect((await meals.getByDate(date)).meals[0]).toMatchObject({ servings: 1, calories: 200.1, protein_g: 9.9 });
});

it('linked quantities preserve the existing per-unit arithmetic before Stored rounding', async () => {
  const meal = await entry('food');
  dispose = mountMealEditSession(find('edit-meal-modal'), { ...meal, calories: 0.9 }, () => true, () => {});
  input('edit-servings', '3');
  click('edit-save-btn');
  expect((await meals.getByDate(date)).meals[0].calories).toBe(1.3);
});

it('Quick entry title renders the captured note as text', async () => {
  const meal = await entry('quick');
  dispose = mountMealEditSession(find('edit-meal-modal'), { ...meal, note: 'Meal<img alt="name">' }, () => true, () => {});
  expect(find('edit-meal-name').textContent).toBe('Meal<img alt="name">');
  expect(document.querySelector('img')).toBeNull();
});

it('Quick entry preserves independent calories, input precision and parse-to-zero fallback', async () => {
  const { meal } = await open();
  input('edit-cal', '321.456');
  input('edit-carbs', '22.234');
  input('edit-protein', '33.345');
  input('edit-fat', '');
  expect(find<HTMLInputElement>('edit-cal').value).toBe('321.456');
  find<HTMLSelectElement>('edit-meal-type').value = 'dinner';
  click('edit-save-btn');
  expect((await meals.getByDate(date)).meals[0]).toEqual({ ...meal, meal_type: 'dinner', calories: 321.456, carbs_g: 22.234, protein_g: 33.345, fat_g: 0 });
});

it.each(['food', 'recipe', 'quick'] as const)('current %s Save prevents repeat submissions and permits retry after failure', async kind => {
  const { meal, saved } = await open(kind);
  setGuestMode(false);
  setToken('editor-token');
  const write = deferred<Response>();
  const network = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue(Response.json({ meal }));
  vi.stubGlobal('fetch', network);
  const save = find<HTMLButtonElement>('edit-save-btn');
  save.click();
  save.dispatchEvent(new MouseEvent('click'));
  expect(network).toHaveBeenCalledTimes(1);
  expect(save.disabled).toBe(true);
  write.resolve(Response.json({ error: 'Failed' }, { status: 500 }));
  await vi.waitFor(() => expect(save.textContent).toBe('Failed - Retry'));
  expect(save.disabled).toBe(false);
  save.click();
  await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(network).toHaveBeenCalledTimes(2);
  expect(network.mock.calls[0][0]).toBe(`/api/meals/${meal.id}`);
});

it('Delete preserves confirmation cancellation and silent failure', async () => {
  const { meal, saved } = await open();
  const confirmation = vi.mocked(window.confirm).mockReturnValue(false);
  setGuestMode(false);
  const network = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json({ success: true }));
  vi.stubGlobal('fetch', network);
  click('edit-delete-btn');
  expect(confirmation).toHaveBeenLastCalledWith('Remove this entry?');
  expect(network).not.toHaveBeenCalled();
  confirmation.mockReturnValue(true);
  const before = find('edit-meal-modal').outerHTML;
  click('edit-delete-btn');
  await Promise.resolve();
  await Promise.resolve();
  expect(find('edit-meal-modal').outerHTML).toBe(before);
  expect(saved).not.toHaveBeenCalled();
  click('edit-delete-btn');
  await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(network).toHaveBeenLastCalledWith(`/api/meals/${meal.id}`, expect.objectContaining({ method: 'DELETE' }));
});

it.each(['food', 'recipe', 'quick'] as const)('%s retained controls remain inert on departure and reconnection before and after observer delivery', async kind => {
  for (const departure of ['root', 'ancestor', 'fixed replacement', '#edit-meal-body', '#edit-meal-name', '#edit-modal-close', '#edit-meal-type', '#edit-save-btn', '#edit-delete-btn', ...(kind === 'quick' ? ['#edit-cal', '#edit-carbs', '#edit-protein', '#edit-fat'] : ['#edit-servings', '#edit-serv-plus', '#edit-serv-minus', '#edit-total'])]) {
    for (const delivered of [false, true]) {
      const { saved } = await open(kind);
      const modal = find('edit-meal-modal');
      const controls = [...modal.querySelectorAll<HTMLElement>('button,input')];
      const data = await meals.getByDate(date);
      // Capture removal synchronously; no helper await may deliver the observer.
      departAndReconnect(modal, departure, '#edit-save-btn');
      if (delivered) await Promise.resolve();
      const before = modal.outerHTML;
      for (const control of controls) {
        control.click();
        control.dispatchEvent(new Event('input'));
      }
      expect(modal.outerHTML, `${departure}, observer=${delivered}`).toBe(before);
      expect(await meals.getByDate(date)).toEqual(data);
      expect(saved).not.toHaveBeenCalled();
      expect(window.confirm).not.toHaveBeenCalled();
      dispose();
    }
  }
});

it.each(['dispose', 'parent', 'close'] as const)('%s permanently retires retained editor controls', async how => {
  let current = true;
  const { saved } = await open('food', () => current);
  const modal = find('edit-meal-modal');
  const controls = [...modal.querySelectorAll<HTMLElement>('button,input')];
  const data = await meals.getByDate(date);
  if (how === 'dispose') { dispose(); dispose(); }
  else if (how === 'parent') current = false;
  else click('edit-modal-close');
  const before = modal.outerHTML;
  for (const control of controls) control.click();
  current = true;
  for (const control of controls) control.click();
  expect(modal.outerHTML).toBe(before);
  expect(await meals.getByDate(date)).toEqual(data);
  expect(saved).not.toHaveBeenCalled();
});

it.each(['save', 'delete'] as const)('accepted %s completes without DOM effects after same-turn retirement', async action => {
  for (const outcome of ['success', 'failure'] as const) {
    for (const delivered of [false, true]) {
      const { saved } = await open('food');
      setGuestMode(false);
      const write = deferred<Response>();
      vi.stubGlobal('fetch', vi.fn(() => write.promise));
      click(action === 'save' ? 'edit-save-btn' : 'edit-delete-btn');
      const modal = find('edit-meal-modal');
      // Resolve first so the completion can run before observer delivery.
      if (outcome === 'success') write.resolve(Response.json({ success: true }));
      else write.reject(new Error('offline'));
      departAndReconnect(modal, 'ancestor');
      const before = modal.outerHTML;
      if (delivered) await Promise.resolve();
      await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(modal.outerHTML).toBe(before);
      dispose();
      setGuestMode(true);
    }
  }
});

it.each(['save', 'delete'] as const)('guest %s completion checks departure before observer delivery', async action => {
  const { meal, saved } = await open('food');
  const modal = find('edit-meal-modal');
  // The guest adapter has already fulfilled its write when the editor awaits it.
  // This queues the editor completion ahead of the removal observer callback.
  click(action === 'save' ? 'edit-save-btn' : 'edit-delete-btn');
  departAndReconnect(modal, 'ancestor');
  const before = modal.outerHTML;
  await Promise.resolve();
  expect(saved).toHaveBeenCalledOnce();
  expect(modal.outerHTML).toBe(before);
  expect((await meals.getByDate(date)).meals.some(entry => entry.id === meal.id)).toBe(action === 'save');
});

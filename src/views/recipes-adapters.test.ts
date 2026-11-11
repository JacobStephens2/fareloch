import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods, recipes, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { deferred, externalFood, food } from '../test/food-search-fixtures';
import { change, click, go, submit } from '../test/recipe-editor-fixtures';
import { recipeEditView } from './recipes';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/recipes/:id', recipeEditView);
  route('/recipes', () => ({ html: '<p>Recipes destination</p>', init() {} }));
  route('/other', () => ({ html: '<p>Other view</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  vi.useFakeTimers();
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seedRecipe() {
  const { food: saved } = await foods.create(food('Guest apple'));
  const { recipe } = await recipes.create({
    name: 'Guest recipe', totalServings: 2, servingUnit: 'bowl',
    ingredients: [{ foodId: saved.id, servings: 2, qty: 1, unitLabel: 'cup' }],
  });
  return { id: recipe.id, foodId: saved.id };
}

it('guest Recipe edit/save round trip retains ingredient identity, quantity and nutrition', async () => {
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const { id, foodId } = await seedRecipe();
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('.ingredient-name')!.textContent).toBe('Guest apple');
  click('.ingredient-clickable');
  change('ing-qty', '2');
  click('#ing-add-btn');
  change('recipe-name', 'Edited guest recipe');
  change('recipe-servings', '4');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect(window.location.hash).toBe('#/recipes');
  const saved = await recipes.get(id);
  expect(saved.recipe.name).toBe('Edited guest recipe');
  expect(saved.ingredients).toEqual([expect.objectContaining({ food_id: foodId, servings: 4, qty: 2 })]);
  expect(saved.recipe.perServing).toEqual({ calories: 100, carbsG: 10, proteinG: 5, fatG: 4 });
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector<HTMLInputElement>('#recipe-name')!.value).toBe('Edited guest recipe');
  expect(document.querySelectorAll('.ingredient-row')).toHaveLength(1);
  expect([...document.querySelectorAll('#recipe-totals strong')].map(el => el.textContent)).toEqual(['100', '10g', '5g', '4g']);
  expect(network).not.toHaveBeenCalled();
});

it('closed ingredient Update cannot change the guest draft or saved servings', async () => {
  const { id, foodId } = await seedRecipe();
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  click('.ingredient-clickable');
  const update = document.querySelector<HTMLElement>('#ing-add-btn')!;
  click('#ing-modal-close');
  change('ing-qty', '3');
  update.click();
  expect(document.querySelector('.ingredient-unit')!.textContent).toBe('cup');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect((await recipes.get(id)).ingredients).toEqual([
    expect.objectContaining({ food_id: foodId, servings: 2, qty: 1 }),
  ]);
});

async function seedOccurrences(sameFood: boolean) {
  const { food: first } = await foods.create(food('First apple'));
  const second = sameFood ? first : (await foods.create(food('Second apple'))).food;
  const { recipe } = await recipes.create({
    name: 'Occurrences', totalServings: 1,
    ingredients: [
      { foodId: first.id, servings: 1, qty: 1, unitLabel: '100g' },
      { foodId: second.id, servings: 2, qty: 2, unitLabel: '2x 100g' },
    ],
  });
  go(`/recipes/${recipe.id}`);
  await vi.advanceTimersByTimeAsync(0);
  return { id: recipe.id, first, second };
}

it.each(['Edit', 'Remove'])('retained row %s cannot act after Update replaces its list; fresh rows still save', async action => {
  const { id, foodId } = await seedRecipe();
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  const oldRow = document.querySelector<HTMLElement>('.ingredient-row')!;
  click('.ingredient-clickable');
  change('ing-qty', '2');
  click('#ing-add-btn');
  document.querySelector('#ingredients-list')!.append(oldRow);
  const before = document.querySelector('.page')!.outerHTML;
  oldRow.querySelector<HTMLElement>(action === 'Edit' ? '.ingredient-clickable' : '.btn-remove-ing')!.click();
  expect(document.querySelector('.page')!.outerHTML).toBe(before);
  oldRow.remove();
  click('.ingredient-clickable');
  change('ing-qty', '3');
  click('#ing-add-btn');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect((await recipes.get(id)).ingredients).toEqual([
    expect.objectContaining({ food_id: foodId, servings: 6, qty: 3 }),
  ]);
});

it.each(['Add', 'row Remove', 'modal Remove'])(
  '%s replaces its list without reviving old controls or changing search rules', async action => {
    const { id, first } = await seedOccurrences(false);
    const oldRow = document.querySelector<HTMLElement>('.ingredient-row')!;
    change('ing-search', 'First apple');
    await vi.advanceTimersByTimeAsync(400);
    if (action === 'Add') {
      click('#ing-results .food-item');
      click('#ing-add-btn');
    } else {
      const secondRow = document.querySelectorAll('.ingredient-row')[1];
      if (action === 'row Remove') secondRow.querySelector<HTMLElement>('.btn-remove-ing')!.click();
      else {
        secondRow.querySelector<HTMLElement>('.ingredient-clickable')!.click();
        click('#ing-remove-btn');
      }
    }
    expect(document.querySelector<HTMLInputElement>('#ing-search')!.value).toBe(action === 'Add' ? '' : 'First apple');
    document.querySelector('#ingredients-list')!.append(oldRow);
    const before = document.querySelector('.page')!.outerHTML;
    oldRow.querySelector<HTMLElement>('.ingredient-clickable')!.click();
    oldRow.querySelector<HTMLElement>('.btn-remove-ing')!.click();
    expect(document.querySelector('.page')!.outerHTML).toBe(before);
    oldRow.remove();
    submit();
    await vi.advanceTimersByTimeAsync(0);
    const saved = (await recipes.get(id)).ingredients;
    expect(saved).toHaveLength(action === 'Add' ? 3 : 1);
    expect(saved[0]).toMatchObject({ food_id: first.id, servings: 1, qty: 1 });
  },
);

it.each(['.ingredient-row', '.ingredient-clickable', '.ingredient-name', '.btn-remove-ing'])(
  'same-turn %s removal/reconnection retires rows, preserving the open modal and parent controls', async departure => {
    const { id, second } = await seedOccurrences(true);
    const retained = [...document.querySelectorAll<HTMLElement>('.ingredient-clickable, .btn-remove-ing')];
    document.querySelectorAll<HTMLElement>('.ingredient-clickable')[1].click();
    const update = document.querySelector<HTMLElement>('#ing-add-btn')!;
    departAndReconnect(document.querySelector('#ingredients-list')!, departure);
    const before = document.querySelector('.page')!.outerHTML;
    retained.forEach(control => control.click());
    expect(document.querySelector('.page')!.outerHTML).toBe(before);
    expect(document.querySelector('#ing-add-btn')).toBe(update);
    change('ing-qty', '3');
    update.click();
    update.click();
    expect([...document.querySelectorAll('.ingredient-unit')].map(node => node.textContent)).toEqual(['100g', '3x 100g']);
    click('.btn-remove-ing');
    click('.ingredient-clickable');
    change('ing-qty', '4');
    click('#ing-add-btn');
    change('recipe-servings', '2');
    expect(document.querySelector('#recipe-totals strong')!.textContent).toBe('200');
    submit();
    await vi.advanceTimersByTimeAsync(0);
    expect((await recipes.get(id)).ingredients).toEqual([
      expect.objectContaining({ food_id: second.id, servings: 4, qty: 4 }),
    ]);
  },
);

it('repeated ingredient Remove deletes one occurrence and preserves the other in guest storage', async () => {
  const { id, second } = await seedOccurrences(false);
  click('.ingredient-clickable');
  const remove = document.querySelector<HTMLElement>('#ing-remove-btn')!;
  remove.click();
  remove.click();
  expect([...document.querySelectorAll('.ingredient-name')].map(el => el.textContent)).toEqual(['Second apple']);
  expect(document.querySelector('#recipe-totals')!.textContent).toContain('200');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect((await recipes.get(id)).ingredients).toEqual([
    expect.objectContaining({ food_id: second.id, servings: 2, qty: 2 }),
  ]);
});

it.each([false, true])('earlier sibling removal preserves the edited occurrence without duplication (same Food=%s)', async sameFood => {
  const { id, second } = await seedOccurrences(sameFood);
  document.querySelectorAll<HTMLElement>('.ingredient-clickable')[1].click();
  click('.btn-remove-ing');
  change('ing-qty', '3');
  click('#ing-add-btn');
  expect(document.querySelectorAll('.ingredient-row')).toHaveLength(1);
  expect(document.querySelector('.ingredient-name')!.textContent).toBe(second.name);
  expect(document.querySelector('.ingredient-unit')!.textContent).toBe('3x 100g');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect((await recipes.get(id)).ingredients).toEqual([
    expect.objectContaining({ food_id: second.id, servings: 3, qty: 3 }),
  ]);
});

it.each(['update', 'remove'] as const)('removing the active target retires its retained %s without touching a duplicate Food occurrence', async action => {
  const { id, first } = await seedOccurrences(true);
  click('.ingredient-clickable');
  const retained = document.querySelector<HTMLElement>(action === 'update' ? '#ing-add-btn' : '#ing-remove-btn')!;
  click('.btn-remove-ing');
  const quantity = document.querySelector<HTMLInputElement>('#ing-qty')!;
  click('#ing-qty-plus');
  expect(quantity.value).toBe('1');
  retained.click();
  retained.click();
  expect(document.querySelectorAll('.ingredient-row')).toHaveLength(1);
  expect(document.querySelector('.ingredient-unit')!.textContent).toBe('2x 100g');
  // The surviving occurrence remains independently editable and removable.
  click('.ingredient-clickable');
  change('ing-qty', '4');
  click('#ing-add-btn');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect((await recipes.get(id)).ingredients).toEqual([
    expect.objectContaining({ food_id: first.id, servings: 4, qty: 4 }),
  ]);
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  click('.ingredient-clickable');
  click('#ing-remove-btn');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect((await recipes.get(id)).ingredients).toEqual([]);
});

it.each(['#ing-add-btn', '#ing-qty-plus'])('%s removal/reconnection retires the child quantity before observer delivery, leaving its parent usable', async departure => {
  const { id, foodId } = await seedRecipe();
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  click('.ingredient-clickable');
  departAndReconnect(document.querySelector('#ing-modal')!, departure);
  const quantity = document.querySelector<HTMLInputElement>('#ing-qty')!;
  const before = document.querySelector('#ing-modal')!.outerHTML;
  click('#ing-qty-plus');
  click('#ing-add-btn');
  expect(quantity.value).toBe('1');
  expect(document.querySelector('#ing-modal')!.outerHTML).toBe(before);
  click('.ingredient-clickable');
  change('ing-qty', '2');
  click('#ing-add-btn');
  submit();
  await vi.advanceTimersByTimeAsync(0);
  expect((await recipes.get(id)).ingredients).toEqual([
    expect.objectContaining({ food_id: foodId, servings: 4, qty: 2 }),
  ]);
});

it.each(['create', 'update', 'copy', 'delete'] as const)('guest %s finishes persistence after raw ancestor departure and reconnection', async action => {
  const { id } = await seedRecipe();
  const wait = deferred<void>();
  const operation = recipes[action];
  // Delay delivery after the actual guest write, preserving the public persistence adapter.
  const delayed = vi.spyOn(recipes, action).mockImplementation(async (...args: unknown[]) => {
    const result = await Reflect.apply(operation, recipes, args);
    await wait.promise;
    return result;
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  go(action === 'create' ? '/recipes/new' : `/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  change('recipe-name', 'Captured guest draft');
  if (action === 'create' || action === 'update') submit();
  else click(action === 'copy' ? '#copy-recipe' : '#delete-recipe');
  const root = document.querySelector('.page')!;
  const ancestor = root.parentElement!;
  ancestor.remove();
  document.body.append(ancestor);
  const before = root.outerHTML;
  const hash = window.location.hash;
  wait.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(delayed).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe(hash);
  expect(root.outerHTML).toBe(before);
  const saved = (await recipes.list()).recipes;
  if (action === 'delete') expect(saved).toHaveLength(0);
  else if (action === 'copy') {
    expect(saved).toHaveLength(2);
    expect(saved.find(recipe => recipe.id !== id)?.name).toBe('Guest recipe (Copy)');
  } else expect(saved.find(recipe => recipe.name === 'Captured guest draft')).toBeDefined();
});

it('signed-in HTTP adapters preserve update and external-selection inputs across departure', async () => {
  const { id } = await seedRecipe();
  const existing = await recipes.get(id);
  setGuestMode(false);
  setToken('test-token');
  const external = externalFood('HTTP apple');
  const pendingSave = deferred<Response>();
  const pendingUpdate = deferred<Response>();
  const requests: { path: string; method: string; body: unknown }[] = [];
  const network = vi.fn(async (url: string, options?: RequestInit) => {
    const path = url.replace('/api', '');
    const method = options?.method ?? 'GET';
    requests.push({ path, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (path.startsWith('/foods/search?')) return Response.json({ foods: [], external: [external] });
    if (path === '/foods/save-external') return pendingSave.promise;
    if (path === `/recipes/${id}` && method === 'GET') return Response.json(existing);
    if (path === `/recipes/${id}` && method === 'PUT') return pendingUpdate.promise;
    throw new Error(`Unexpected HTTP request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', network);
  go(`/recipes/${id}`);
  await vi.advanceTimersByTimeAsync(0);
  change('ing-search', 'apple');
  await vi.advanceTimersByTimeAsync(400);
  click('#ing-results .food-item');
  pendingSave.resolve(Response.json({ food: { ...food('HTTP apple'), id: 91 } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#ing-modal-name')!.textContent).toBe('HTTP apple');
  click('#ing-add-btn');
  change('recipe-name', 'HTTP edit');
  submit();
  go('/recipes/new');
  change('recipe-name', 'Current draft');
  const current = document.querySelector('#app')!.innerHTML;
  pendingUpdate.resolve(Response.json({ success: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector<HTMLInputElement>('#recipe-name')!.value).toBe('Current draft');
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(window.location.hash).toBe('#/recipes/new');
  expect(requests).toContainEqual({ path: '/foods/save-external', method: 'POST', body: external });
  expect(requests).toContainEqual({ path: `/recipes/${id}`, method: 'PUT', body: {
    name: 'HTTP edit', totalServings: 2, servingUnit: 'bowl',
    ingredients: [
      { foodId: existing.ingredients[0].food_id, servings: 2, qty: 1, unitLabel: 'cup' },
      { foodId: 91, servings: 1, qty: 1, unitLabel: '100g' },
    ],
    manualCalories: null, manualCarbsG: null, manualProteinG: null, manualFatG: null,
  } });
  expect(network.mock.calls.every(([, options]) => options?.credentials === 'include'
    && new Headers(options.headers).get('Authorization') === 'Bearer test-token')).toBe(true);
});

it.each((['create', 'update'] as const).flatMap(action =>
  (['close', 'replacement', 'list replacement', 'list departure', 'parent'] as const).map(retirement => ({ action, retirement }))))(
  'accepted HTTP $action retains ingredient inputs after $retirement retirement', async ({ action, retirement }) => {
    const { id, foodId } = await seedRecipe();
    const existing = await recipes.get(id);
    const savedFood = (await foods.search('Guest apple')).foods.find(value => value.id === foodId)!;
    const pending = deferred<Response>();
    const writes: { url: string; options: RequestInit }[] = [];
    setGuestMode(false);
    setToken('captured-token');
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (options.method === 'POST' || options.method === 'PUT') {
        writes.push({ url, options });
        return pending.promise;
      }
      if (url.includes('/foods/search?')) return Response.json({ foods: [savedFood], external: [] });
      if (url === `/api/recipes/${id}`) return Response.json(existing);
      throw new Error(`Unexpected request: ${url}`);
    });
    go(action === 'create' ? '/recipes/new' : `/recipes/${id}`);
    await vi.advanceTimersByTimeAsync(0);
    if (action === 'create') {
      change('ing-search', 'apple');
      await vi.advanceTimersByTimeAsync(400);
      click('#ing-results .food-item');
    } else click('.ingredient-clickable');
    change('ing-qty', '3');
    click('#ing-add-btn');
    change('recipe-name', 'Captured ingredients');
    submit();
    click('.ingredient-clickable');
    change('ing-qty', '9');
    if (retirement === 'close') click('#ing-modal-close');
    else if (retirement === 'replacement') click('.ingredient-clickable');
    else if (retirement === 'list replacement') click('#ing-add-btn');
    else if (retirement === 'list departure') departAndReconnect(document.querySelector('#ingredients-list')!, '.ingredient-row');
    else departAndReconnect(document.querySelector('.page')!, 'ancestor');
    const before = document.querySelector('.page')!.outerHTML;
    pending.resolve(Response.json({ recipe: { id: 90 }, success: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toBe(action === 'create' ? '/api/recipes' : `/api/recipes/${id}`);
    expect(writes[0].options).toMatchObject({
      method: action === 'create' ? 'POST' : 'PUT', credentials: 'include',
      headers: expect.objectContaining({ Authorization: 'Bearer captured-token' }),
    });
    expect(JSON.parse(String(writes[0].options.body))).toEqual({
      name: 'Captured ingredients', totalServings: action === 'create' ? 1 : 2,
      servingUnit: action === 'create' ? 'serving' : 'bowl',
      ingredients: [{ foodId, servings: action === 'create' ? 3 : 6, qty: 3, unitLabel: '3x 100g' }],
      manualCalories: null, manualCarbsG: null, manualProteinG: null, manualFatG: null,
    });
    expect(window.location.hash).toBe(retirement === 'parent'
      ? action === 'create' ? '#/recipes/new' : `#/recipes/${id}` : '#/recipes');
    if (retirement === 'parent') expect(document.querySelector('.page')!.outerHTML).toBe(before);
  },
);

it.each((['create', 'update'] as const).flatMap(action =>
  (['list replacement', 'list departure', 'parent'] as const).map(retirement => ({ action, retirement }))))(
  'accepted guest $action saves captured ingredients after $retirement retirement', async ({ action, retirement }) => {
    const { id, foodId } = await seedRecipe();
    const pending = deferred<void>();
    const operation = recipes[action];
    // Delay the real guest adapter so the draft can change before persistence finishes.
    vi.spyOn(recipes, action).mockImplementation(async (...args: unknown[]) => {
      await pending.promise;
      return Reflect.apply(operation, recipes, args);
    });
    go(action === 'create' ? '/recipes/new' : `/recipes/${id}`);
    await vi.advanceTimersByTimeAsync(0);
    if (action === 'create') {
      change('ing-search', 'apple');
      await vi.advanceTimersByTimeAsync(400);
      click('#ing-results .food-item');
    } else click('.ingredient-clickable');
    change('ing-qty', '3');
    click('#ing-add-btn');
    change('recipe-name', 'Captured guest ingredients');
    submit();
    click('.ingredient-clickable');
    change('ing-qty', '9');
    click('#ing-add-btn');
    if (retirement === 'list departure') departAndReconnect(document.querySelector('#ingredients-list')!, '.ingredient-row');
    else if (retirement === 'parent') departAndReconnect(document.querySelector('.page')!, 'ancestor');
    const before = document.querySelector('.page')!.outerHTML;
    const origin = window.location.hash;
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const savedRecipe = (await recipes.list()).recipes.find(value => value.name === 'Captured guest ingredients')!;
    expect((await recipes.get(savedRecipe.id)).ingredients).toEqual([
      expect.objectContaining({ food_id: foodId, servings: action === 'create' ? 3 : 6, qty: 3, unit_label: '3x 100g' }),
    ]);
    expect(window.location.hash).toBe(retirement === 'parent' ? origin : '#/recipes');
    if (retirement === 'parent') expect(document.querySelector('.page')!.outerHTML).toBe(before);
  },
);

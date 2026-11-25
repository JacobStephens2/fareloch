import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, recipes } from './api';
import { clearGuestData, setGuestMode } from './local-db';

const canonicalKey = 'guest_recipe_state';
const date = '2026-11-13';

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
});

afterEach(() => vi.restoreAllMocks());

async function seedFood() {
  return (await foods.create({
    name: 'Oats', brand: 'Guest pantry', serving_size: 40, serving_unit: 'g',
    calories: 101, carbs_g: 10, protein_g: 5, fat_g: 2,
  })).food;
}

function rejectRecipeCommit() {
  const setItem = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    // The legacy key reproduces the old split-write failure as well.
    if (key === canonicalKey || key === 'guest_recipe_ingredients') {
      throw new DOMException('Recipe quota exceeded', 'QuotaExceededError');
    }
    setItem.call(this, key, value);
  });
}

it('creation rejects without publishing metadata or consuming identities, then retries completely', async () => {
  const food = await seedFood();
  const input = {
    name: 'Breakfast', totalServings: 3,
    ingredients: [{ foodId: food.id, servings: 2 }, { foodId: food.id, servings: 1 }],
  };
  const fault = rejectRecipeCommit();
  await expect(recipes.create(input)).rejects.toThrow('Recipe quota exceeded');
  expect(await recipes.list()).toEqual({ recipes: [] });
  fault.mockRestore();

  const { recipe } = await recipes.create(input);
  expect(recipe.id).toBe(2);
  const saved = await recipes.get(recipe.id);
  expect(saved.ingredients.map(ingredient => ingredient.id)).toEqual([3, 4]);
  expect(saved.ingredients.map(ingredient => ingredient.food_id)).toEqual([food.id, food.id]);
  expect(saved.recipe).toMatchObject({
    name: 'Breakfast', ingredientCount: 2,
    perServing: { calories: 101, carbsG: 10, proteinG: 5, fatG: 2 },
  });
});

it('update rejects without changing metadata, occurrences or nutrition and retries with unconsumed identities', async () => {
  const food = await seedFood();
  const { recipe } = await recipes.create({
    name: 'Breakfast', totalServings: 3, ingredients: [{ foodId: food.id, servings: 1 }],
  });
  const before = await recipes.get(recipe.id);
  const input = { name: 'Changed', totalServings: 2, ingredients: [{ foodId: food.id, servings: 4 }] };
  const fault = rejectRecipeCommit();
  await expect(recipes.update(recipe.id, input)).rejects.toThrow('Recipe quota exceeded');
  expect(await recipes.get(recipe.id)).toEqual(before);
  fault.mockRestore();
  expect(await recipes.update(recipe.id, input)).toEqual({ success: true });
  expect(await recipes.get(recipe.id)).toMatchObject({
    recipe: { name: 'Changed', total_servings: 2, perServing: { calories: 202, carbsG: 20, proteinG: 10, fatG: 4 } },
    ingredients: [{ id: 4, food_id: food.id, servings: 4 }],
  });
});

it('deletion rejects without removing a Recipe, then deletes completely without reusing its identities', async () => {
  const food = await seedFood();
  const { recipe } = await recipes.create({
    name: 'Breakfast', totalServings: 1, ingredients: [{ foodId: food.id, servings: 1 }],
  });
  const before = await recipes.get(recipe.id);
  const fault = rejectRecipeCommit();
  await expect(recipes.delete(recipe.id)).rejects.toThrow('Recipe quota exceeded');
  expect(await recipes.get(recipe.id)).toEqual(before);
  fault.mockRestore();
  expect(await recipes.delete(recipe.id)).toEqual({ success: true });
  expect(await recipes.list()).toEqual({ recipes: [] });
  await expect(recipes.get(recipe.id)).rejects.toThrow('Recipe not found');
  expect((await recipes.create({ name: 'Next', totalServings: 1, ingredients: [] })).recipe.id).toBe(4);
});

it('copy rejects without publishing a partial duplicate or consuming identities and retries in list order', async () => {
  const food = await seedFood();
  const { recipe } = await recipes.create({
    name: 'Breakfast', totalServings: 1, ingredients: [{ foodId: food.id, servings: 2 }],
  });
  const before = await recipes.get(recipe.id);
  const fault = rejectRecipeCommit();
  await expect(recipes.copy(recipe.id)).rejects.toThrow('Recipe quota exceeded');
  expect((await recipes.list()).recipes).toEqual([before.recipe]);
  expect(await recipes.get(recipe.id)).toEqual(before);
  fault.mockRestore();
  const { recipe: copy } = await recipes.copy(recipe.id);
  expect(copy.id).toBe(4);
  expect(await recipes.get(copy.id)).toMatchObject({
    recipe: { name: 'Breakfast (Copy)', perServing: before.recipe.perServing },
    ingredients: [{ ...before.ingredients[0], id: 5 }],
  });
  expect((await recipes.list()).recipes.map(recipe => recipe.id)).toEqual([recipe.id, copy.id]);
});

function seedLegacy(nextId = 100) {
  const recipe = {
    id: 12, user_id: 0, name: 'Legacy oats', total_servings: 3, serving_unit: 'bowl',
    manual_calories: null, manual_carbs_g: null, manual_protein_g: null, manual_fat_g: null,
    perServing: { calories: 9999, carbsG: 9999, proteinG: 9999, fatG: 9999 }, ingredientCount: 9999,
  };
  const occurrence = {
    id: 13, food_id: 1, name: 'Legacy food', brand: '', serving_size: 0, serving_unit: '',
    calories: 101, carbs_g: 10, protein_g: 5, fat_g: 2, qty: 0, unit_label: '', measures: null,
  };
  const ingredients = { 12: [{ ...occurrence, servings: 0 }, { ...occurrence, id: 14 }], 50: [{ ...occurrence, id: 60, servings: 2 }] };
  localStorage.setItem('guest_recipes', JSON.stringify([recipe]));
  localStorage.setItem('guest_recipe_ingredients', JSON.stringify(ingredients));
  localStorage.setItem('guest_next_id', JSON.stringify(nextId));
  return { recipe, ingredients };
}

it('legacy reads recompute nutrition without writes and copy preserves stored occurrence values verbatim', async () => {
  const { ingredients } = seedLegacy();
  const fault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Reads must not write'); });
  const before = await recipes.get(12);
  expect(before.ingredients).toEqual(ingredients[12]);
  expect(before.recipe).toMatchObject({ ingredientCount: 2, perServing: { calories: 34, carbsG: 3.3, proteinG: 1.7, fatG: 0.7 } });
  expect((await recipes.list()).recipes).toEqual([before.recipe]);
  fault.mockRestore();
  const { recipe: copy } = await recipes.copy(12);
  expect(copy.id).toBe(100);
  expect((await recipes.get(copy.id)).ingredients).toEqual([
    { ...ingredients[12][0], id: 101 }, { ...ingredients[12][1], id: 102 },
  ]);
  expect((await recipes.get(copy.id)).recipe).toMatchObject({
    name: 'Legacy oats (Copy)', ingredientCount: 2, perServing: before.recipe.perServing,
  });
  expect(await recipes.get(12)).toEqual(before);
  // The persisted-format contract excludes stale derived fields on the copy.
  const state = JSON.parse(localStorage.getItem(canonicalKey)!);
  expect(state.recipes[1]).not.toHaveProperty('perServing');
  expect(state.recipes[1]).not.toHaveProperty('ingredientCount');
});

const mutations = {
  create: () => recipes.create({ name: 'New', totalServings: 1, ingredients: [{ foodId: 1, servings: 1 }] }),
  update: () => recipes.update(12, { name: 'Changed', ingredients: [{ foodId: 1, servings: 2 }] }),
  copy: () => recipes.copy(12),
  delete: () => recipes.delete(12),
};

it.each(Object.keys(mutations) as (keyof typeof mutations)[])('failed first promotion during %s leaves all legacy state and the shared counter retryable', async action => {
  seedLegacy();
  const before = await recipes.get(12);
  const fault = rejectRecipeCommit();
  await expect(mutations[action]()).rejects.toThrow('Recipe quota exceeded');
  expect(await recipes.get(12)).toEqual(before);
  expect((await recipes.list()).recipes).toEqual([before.recipe]);
  fault.mockRestore();
  expect((await foods.create({ name: 'Still shared' })).food.id).toBe(100);
  await mutations[action]();
  if (action === 'delete') {
    await expect(recipes.get(12)).rejects.toThrow('Recipe not found');
  } else if (action === 'update') {
    expect(await recipes.get(12)).toMatchObject({ recipe: { name: 'Changed' }, ingredients: [{ id: 101 }] });
  } else {
    expect((await recipes.list()).recipes.map(recipe => recipe.id)).toEqual([12, 101]);
    expect((await recipes.get(101)).ingredients[0].id).toBe(102);
  }
});

it('failed creation in canonical storage leaves existing Recipes and its allocation unchanged', async () => {
  await mutations.create();
  const before = await recipes.list();
  const fault = rejectRecipeCommit();
  await expect(mutations.create()).rejects.toThrow('Recipe quota exceeded');
  expect(await recipes.list()).toEqual(before);
  fault.mockRestore();
  expect((await mutations.create()).recipe.id).toBe(3);
  expect((await recipes.get(3)).ingredients[0].id).toBe(4);
});

it.each([2, 100])('promotion allocates above all retained identities and orphan map keys with legacy counter %s', async nextId => {
  seedLegacy(nextId);
  // Even an empty orphan entry reserves its numeric Recipe identity.
  const ingredients = JSON.parse(localStorage.getItem('guest_recipe_ingredients')!);
  ingredients[80] = [];
  localStorage.setItem('guest_recipe_ingredients', JSON.stringify(ingredients));
  const expected = nextId === 2 ? 81 : 100;
  expect((await mutations.create()).recipe.id).toBe(expected);
  expect((await recipes.get(expected)).ingredients[0].id).toBe(expected + 1);
  expect((await recipes.get(12)).ingredients.map(ingredient => ingredient.id)).toEqual([13, 14]);
  expect((await foods.create({ name: 'Independent' })).food.id).toBe(nextId);
});

it('cleanup failure cannot reject a committed promotion and stale legacy data never becomes authoritative', async () => {
  seedLegacy();
  const fault = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Cleanup denied'); });
  expect(await recipes.delete(12)).toEqual({ success: true });
  expect(await recipes.list()).toEqual({ recipes: [] });
  fault.mockRestore();
  vi.resetModules();
  const reloaded = await import('./api');
  expect(await reloaded.recipes.list()).toEqual({ recipes: [] });
  expect((await reloaded.recipes.create({ name: 'After reload', totalServings: 1, ingredients: [] })).recipe.id).toBe(100);
});

it('replacement and deletion never reuse identities across a module reload or unrelated collection writes', async () => {
  const food = await seedFood();
  const { recipe } = await recipes.create({ name: 'First', totalServings: 1, ingredients: [{ foodId: food.id, servings: 1 }] });
  await recipes.update(recipe.id, { ingredients: [{ foodId: food.id, servings: 1 }] });
  expect((await recipes.get(recipe.id)).ingredients[0].id).toBe(4);
  await recipes.delete(recipe.id);
  vi.resetModules();
  const reloaded = await import('./api');
  expect((await reloaded.foods.create({ name: 'Second food' })).food.id).toBe(2);
  expect((await reloaded.meals.quickLog({ date, mealType: 'snack' })).meal.id).toBe(3);
  const next = await reloaded.recipes.create({ name: 'Next', totalServings: 1, ingredients: [{ foodId: food.id, servings: 1 }] });
  expect(next.recipe.id).toBe(5);
  expect((await reloaded.recipes.get(5)).ingredients[0].id).toBe(6);
});

it('creation and ingredient replacement retain guest truthy defaults and Food snapshot fallbacks', async () => {
  const food = await seedFood();
  const { recipe } = await recipes.create({
    name: 'Defaults', totalServings: 0, servingUnit: '',
    ingredients: [{ foodId: food.id, servings: 0, qty: 0, unitLabel: '' }, { foodId: 999, servings: 0 }],
  });
  expect(await recipes.get(recipe.id)).toMatchObject({
    recipe: { total_servings: 1, serving_unit: 'serving', manual_calories: null },
    ingredients: [
      { servings: 1, qty: null, unit_label: null, name: 'Oats', brand: 'Guest pantry', serving_size: 40, serving_unit: 'g', calories: 101 },
      { servings: 1, qty: null, unit_label: null, name: '', brand: null, serving_size: 1, serving_unit: 'serving', calories: 0, measures: null },
    ],
  });
  await recipes.update(recipe.id, { ingredients: [{ foodId: food.id, servings: 0, qty: 0, unitLabel: '' }] });
  expect((await recipes.get(recipe.id)).ingredients).toEqual([expect.objectContaining({ servings: 1, qty: null, unit_label: null })]);
});

it('partial updates preserve omitted metadata, Manual macros and occurrences, while null and empty ingredients clear them', async () => {
  const food = await seedFood();
  const { recipe } = await recipes.create({
    name: 'Manual', totalServings: 2, servingUnit: 'bowl', manualCalories: 0, manualCarbsG: 0, manualProteinG: 6,
    ingredients: [{ foodId: food.id, servings: 2 }],
  });
  const before = await recipes.get(recipe.id);
  expect(before.recipe).toMatchObject({ ingredientCount: 0, manual_calories: 0, manual_carbs_g: 0, manual_fat_g: null, perServing: { calories: 0, carbsG: 0, proteinG: 3, fatG: 0 } });
  expect(before.ingredients).toHaveLength(1);
  await recipes.update(recipe.id, { name: 'Renamed' });
  expect(await recipes.get(recipe.id)).toEqual({ ...before, recipe: { ...before.recipe, name: 'Renamed' } });
  await recipes.update(recipe.id, { manualCalories: null, manualCarbsG: null, manualProteinG: null, manualFatG: null, totalServings: 0, servingUnit: '' });
  expect(await recipes.get(recipe.id)).toMatchObject({
    recipe: { total_servings: 0, serving_unit: '', ingredientCount: 1, perServing: { calories: 202, carbsG: 20, proteinG: 10, fatG: 4 } },
    ingredients: before.ingredients,
  });
  await recipes.update(recipe.id, { ingredients: [] });
  expect(await recipes.get(recipe.id)).toMatchObject({ recipe: { ingredientCount: 0, perServing: { calories: 0, carbsG: 0, proteinG: 0, fatG: 0 } }, ingredients: [] });
});

it('Meal logging reads legacy and canonical nutrition unrounded before Stored rounding and retains existing links', async () => {
  seedLegacy();
  const before = await meals.log({ date, mealType: 'breakfast', recipeId: 12, servings: 2 });
  expect(before.meal).toMatchObject({ recipe_id: 12, recipe_name: 'Legacy oats', calories: 67.3, carbs_g: 6.7, protein_g: 3.3, fat_g: 1.3 });
  await recipes.update(12, { name: 'Canonical oats' });
  // Present stale legacy data must be ignored by the sole other Recipe reader.
  seedLegacy();
  const after = await meals.log({ date, mealType: 'lunch', recipeId: 12, servings: 2 });
  expect(after.meal).toMatchObject({ recipe_id: 12, recipe_name: 'Canonical oats', calories: 67.3, carbs_g: 6.7, protein_g: 3.3, fat_g: 1.3 });
  expect((await meals.getByDate(date)).meals[0]).toEqual(before.meal);
  expect((await recipes.get(12)).recipe.perServing.calories).toBe(34);
  await recipes.update(12, { manualCalories: 0, manualCarbsG: 1, manualProteinG: null, manualFatG: 0 });
  expect((await meals.log({ date, mealType: 'snack', recipeId: 12, servings: 2 })).meal).toMatchObject({ calories: 0, carbs_g: 0.7, protein_g: 0, fat_g: 0 });
});

it('missing-Recipe outcomes remain compatible without consuming Recipe identities', async () => {
  await expect(recipes.get(500)).rejects.toThrow('Recipe not found');
  await expect(recipes.update(500, { name: 'Missing' })).rejects.toThrow('Recipe not found');
  await expect(recipes.copy(500)).rejects.toThrow('Recipe not found');
  expect(await recipes.delete(500)).toEqual({ success: true });
  expect((await recipes.create({ name: 'First', totalServings: 1, ingredients: [] })).recipe.id).toBe(1);
  expect((await meals.log({ date, mealType: 'snack', recipeId: 500, calories: 123 })).meal).toMatchObject({ recipe_id: 500, recipe_name: null, calories: 123 });
});

it('clearGuestData removes canonical and legacy Recipes and resets unrelated guest collections on re-entry', async () => {
  const food = await seedFood();
  await recipes.create({ name: 'Canonical', totalServings: 1, ingredients: [] });
  await meals.log({ date, mealType: 'snack', foodId: food.id });
  seedLegacy();
  clearGuestData();
  setGuestMode(true);
  expect(await recipes.list()).toEqual({ recipes: [] });
  expect(await foods.custom()).toEqual({ foods: [] });
  expect(await meals.getByDate(date)).toEqual({ meals: [] });
  expect((await recipes.create({ name: 'Fresh', totalServings: 1, ingredients: [] })).recipe.id).toBe(1);
  expect((await foods.create({ name: 'Fresh food' })).food.id).toBe(1);
});

const invalidCanonicalRecords = [
  '', '{broken', 'null', '[]',
  JSON.stringify({ version: 2, recipes: [], ingredients: {}, nextId: 1 }),
  JSON.stringify({ version: 1, recipes: {}, ingredients: {}, nextId: 1 }),
  JSON.stringify({ version: 1, recipes: [], ingredients: [], nextId: 1 }),
  JSON.stringify({ version: 1, recipes: [], ingredients: {}, nextId: 0 }),
  JSON.stringify({ version: 1, recipes: [], ingredients: {}, nextId: 1.5 }),
  JSON.stringify({ version: 1, recipes: [], ingredients: {}, nextId: Number.MAX_SAFE_INTEGER + 1 }),
  JSON.stringify({ version: 1, recipes: [{ id: 1, name: 'Bad total', total_servings: 'three' }], ingredients: {}, nextId: 2 }),
  JSON.stringify({ version: 1, recipes: [{ id: 1, name: 'At counter' }], ingredients: {}, nextId: 1 }),
  JSON.stringify({ version: 1, recipes: [{ id: 1, name: 'Duplicate' }, { id: 1, name: 'Duplicate' }], ingredients: {}, nextId: 2 }),
  JSON.stringify({ version: 1, recipes: [], ingredients: { 1: [{ id: 2, name: 'At counter', food_id: 1 }] }, nextId: 2 }),
  JSON.stringify({ version: 1, recipes: [], ingredients: { 2: [] }, nextId: 2 }),
  JSON.stringify({ version: 1, recipes: [], ingredients: { bad: [] }, nextId: 3 }),
];

it.each(invalidCanonicalRecords)('rejects invalid canonical data without legacy fallback or overwriting it: %s', async raw => {
  seedLegacy();
  localStorage.setItem(canonicalKey, raw);
  await expect(recipes.list()).rejects.toThrow();
  await expect(recipes.get(12)).rejects.toThrow();
  await expect(recipes.create({ name: 'Must not overwrite', totalServings: 1, ingredients: [] })).rejects.toThrow();
  await expect(recipes.update(12, { name: 'Must not overwrite' })).rejects.toThrow();
  await expect(recipes.copy(12)).rejects.toThrow();
  await expect(recipes.delete(12)).rejects.toThrow();
  await expect(meals.log({ date, mealType: 'snack', recipeId: 12 })).rejects.toThrow();
  expect(localStorage.getItem(canonicalKey)).toBe(raw);
  expect((await foods.create({ name: 'Counter unchanged' })).food.id).toBe(100);
});

it.each([
  ['guest_recipes', '{broken'],
  ['guest_recipes', 'null'],
  ['guest_recipes', '{}'],
  ['guest_recipes', '[null]'],
  ['guest_recipes', '[{"id":0,"name":"Invalid identity"}]'],
  ['guest_recipe_ingredients', '[]'],
  ['guest_recipe_ingredients', '{"12":null}'],
  ['guest_recipe_ingredients', '{"12":[{"id":13,"food_id":1,"name":"Duplicate"},{"id":13,"food_id":1,"name":"Duplicate"}]}'],
  ['guest_recipe_ingredients', '{"12":[{"id":12,"food_id":1,"name":"Recipe collision"}]}'],
  ['guest_next_id', '0'],
  ['guest_next_id', '"100"'],
])('malformed legacy %s is rejected without promotion', async (key, raw) => {
  seedLegacy();
  localStorage.setItem(key, raw);
  await expect(recipes.list()).rejects.toThrow();
  await expect(recipes.create({ name: 'Must not promote', totalServings: 1, ingredients: [] })).rejects.toThrow();
  expect(localStorage.getItem(key)).toBe(raw);
  expect(localStorage.getItem(canonicalKey)).toBeNull();
});

it('storage read errors propagate to Recipe operations and Meal logging without overwriting Recipes', async () => {
  seedLegacy();
  const before = await recipes.get(12);
  const getItem = Storage.prototype.getItem;
  const fault = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (key === canonicalKey) throw new Error('Storage unavailable');
    return getItem.call(this, key);
  });
  await expect(recipes.list()).rejects.toThrow('Storage unavailable');
  await expect(recipes.delete(12)).rejects.toThrow('Storage unavailable');
  await expect(meals.log({ date, mealType: 'snack', recipeId: 12 })).rejects.toThrow('Storage unavailable');
  fault.mockRestore();
  expect(await recipes.get(12)).toEqual(before);
  expect((await foods.create({ name: 'Counter unchanged' })).food.id).toBe(100);
});

it('staging and serialization errors reject without consuming identities or changing committed Recipes', async () => {
  seedLegacy();
  const before = await recipes.get(12);
  await expect(recipes.update(12, { ingredients: [{
    get foodId(): number { throw new Error('Invalid ingredient input'); }, servings: 1,
  }] })).rejects.toThrow('Invalid ingredient input');
  expect(await recipes.get(12)).toEqual(before);
  vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('Serialization failed'); });
  await expect(recipes.copy(12)).rejects.toThrow('Serialization failed');
  expect(await recipes.get(12)).toEqual(before);
  expect((await recipes.copy(12)).recipe.id).toBe(100);
  expect((await recipes.get(100)).ingredients.map(ingredient => ingredient.id)).toEqual([101, 102]);
});

it('identity exhaustion rejects the staged mutation without losing Recipes or their occurrences', async () => {
  seedLegacy(Number.MAX_SAFE_INTEGER - 1);
  const before = await recipes.get(12);
  await expect(recipes.copy(12)).rejects.toThrow('Guest Recipe identities exhausted');
  expect(await recipes.get(12)).toEqual(before);
  expect((await recipes.create({ name: 'Last allocatable', totalServings: 1, ingredients: [] })).recipe.id).toBe(Number.MAX_SAFE_INTEGER - 1);
  await expect(recipes.copy(12)).rejects.toThrow('Guest Recipe identities exhausted');
  expect(await recipes.get(12)).toEqual(before);
});

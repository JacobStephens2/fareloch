// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { getDb, initDb } from './db.js';
import { createRecipe, updateRecipe, copyRecipe } from './recipe-mutations.js';

beforeAll(() => { initDb(':memory:'); });
afterAll(() => getDb().close());

beforeEach(() => {
  getDb().exec(`
    DROP TRIGGER IF EXISTS reject_second_ingredient;
    DELETE FROM recipe_ingredients;
    DELETE FROM recipes;
    DELETE FROM foods;
    DELETE FROM users;
    INSERT INTO users (id, email, password_hash, first_name)
      VALUES (1, 'recipe@example.com', 'hash', 'Recipe'),
             (2, 'other@example.com', 'hash', 'Other');
    INSERT INTO foods (id, user_id, name) VALUES (10, 1, 'Oats');
    INSERT INTO recipes (id, user_id, name, total_servings, serving_unit,
                         manual_calories, manual_carbs_g, manual_protein_g, manual_fat_g)
      VALUES (20, 1, 'Original', 4, 'bowl', 0, 12, 8, 3);
    INSERT INTO recipe_ingredients (id, recipe_id, food_id, servings, qty, unit_label)
      VALUES (30, 20, 10, 0, 0, ''), (31, 20, 10, 2.5, NULL, NULL);
  `);
});

function recipe(id: number | bigint) {
  return getDb().prepare('SELECT * FROM recipes WHERE id = ?').get(id);
}

function ingredients(recipeId: number | bigint) {
  return getDb().prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id').all(recipeId);
}

function storedRecipes() {
  return {
    recipes: getDb().prepare('SELECT * FROM recipes ORDER BY id').all(),
    ingredients: getDb().prepare('SELECT * FROM recipe_ingredients ORDER BY id').all(),
  };
}

function rejectSecondIngredient() {
  getDb().exec(`
    CREATE TEMP TRIGGER reject_second_ingredient BEFORE INSERT ON recipe_ingredients
    WHEN (SELECT count(*) FROM recipe_ingredients WHERE recipe_id = NEW.recipe_id) = 1
    BEGIN SELECT RAISE(ABORT, 'second ingredient rejected'); END;
  `);
}

it('creates metadata and ingredient occurrences with truthy and nullish defaults', () => {
  const result = createRecipe(getDb(), 1, {
    name: 'Breakfast', totalServings: 0, servingUnit: '',
    manualCalories: 0, manualCarbsG: 0, manualProteinG: null,
    ingredients: [
      { foodId: 10, servings: 2, qty: 0, unitLabel: '' },
      ...[undefined, null, 0, false, ''].map(servings => ({ foodId: 10, servings })),
    ],
  });
  expect(result).toEqual({ id: expect.any(Number), name: 'Breakfast', totalServings: 1 });
  expect(recipe(result.id)).toMatchObject({
    user_id: 1, name: 'Breakfast', total_servings: 1, serving_unit: 'serving',
    manual_calories: 0, manual_carbs_g: 0, manual_protein_g: null, manual_fat_g: null,
  });
  expect(ingredients(result.id)).toEqual([
    expect.objectContaining({ food_id: 10, servings: 2, qty: 0, unit_label: '' }),
    ...Array.from({ length: 5 }, () => expect.objectContaining({
      food_id: 10, servings: 1, qty: null, unit_label: null,
    })),
  ]);
});

it('rolls back all creation writes when the second ingredient insert fails', () => {
  const before = storedRecipes();
  rejectSecondIngredient();
  expect(() => createRecipe(getDb(), 1, {
    name: 'Rejected', ingredients: [{ foodId: 10 }, { foodId: 10 }],
  })).toThrow('second ingredient rejected');
  expect(getDb().inTransaction).toBe(false);
  expect(storedRecipes()).toEqual(before);
});

it('updates metadata and replaces ingredient occurrences with create/update defaults', () => {
  expect(updateRecipe(getDb(), 1, '20', {
    name: 'Changed', totalServings: 0, servingUnit: '',
    manualCalories: 0, manualCarbsG: 0, manualProteinG: 0, manualFatG: 0,
    ingredients: [
      { foodId: 10, servings: 0, qty: 0, unitLabel: '' },
      { foodId: 10, servings: 3, qty: null },
    ],
  })).toEqual({ saved: true });
  expect(recipe(20)).toMatchObject({
    name: 'Changed', total_servings: 0, serving_unit: '',
    manual_calories: 0, manual_carbs_g: 0, manual_protein_g: 0, manual_fat_g: 0,
  });
  expect(ingredients(20)).toEqual([
    expect.objectContaining({ food_id: 10, servings: 1, qty: 0, unit_label: '' }),
    expect.objectContaining({ food_id: 10, servings: 3, qty: null, unit_label: null }),
  ]);
  expect(ingredients(20).map(row => (row as { id: number }).id)).not.toEqual([30, 31]);
});

it.each([{}, { name: null, totalServings: null, servingUnit: null }])(
  'preserves omitted/null metadata and clears omitted Manual macros for %j', input => {
    const beforeIngredients = ingredients(20);
    expect(updateRecipe(getDb(), 1, 20, input)).toEqual({ saved: true });
    expect(recipe(20)).toMatchObject({
      name: 'Original', total_servings: 4, serving_unit: 'bowl',
      manual_calories: null, manual_carbs_g: null, manual_protein_g: null, manual_fat_g: null,
    });
    expect(ingredients(20)).toEqual(beforeIngredients);
  },
);

it.each([null, false, 'not an array', {}])('keeps ingredient identities for non-array input %j', input => {
  const before = ingredients(20);
  updateRecipe(getDb(), 1, 20, { ingredients: input });
  expect(ingredients(20)).toEqual(before);
});

it('clears an empty ingredient array and explicitly null Manual macros', () => {
  updateRecipe(getDb(), 1, 20, {
    ingredients: [], manualCalories: null, manualCarbsG: null, manualProteinG: null, manualFatG: null,
  });
  expect(ingredients(20)).toEqual([]);
  expect(recipe(20)).toMatchObject({
    manual_calories: null, manual_carbs_g: null, manual_protein_g: null, manual_fat_g: null,
  });
});

it('rolls back metadata and original ingredient identities when the second replacement insert fails', () => {
  const before = storedRecipes();
  rejectSecondIngredient();
  expect(() => updateRecipe(getDb(), 1, 20, {
    name: 'Rejected', totalServings: 9, servingUnit: 'cup', manualCalories: 99,
    ingredients: [{ foodId: 10 }, { foodId: 10 }],
  })).toThrow('second ingredient rejected');
  expect(getDb().inTransaction).toBe(false);
  expect(storedRecipes()).toEqual(before);
});

it.each([
  {},
  { totalServings: null, servingUnit: null, ingredients: null },
  { ingredients: 'not an array' },
  { ingredients: [] },
])('creates without ingredients and uses missing/null defaults for %j', input => {
  const result = createRecipe(getDb(), 1, { name: 'Plain', ...input });
  expect(result).toEqual({ id: expect.any(Number), name: 'Plain', totalServings: 1 });
  expect(recipe(result.id)).toMatchObject({
    total_servings: 1, serving_unit: 'serving',
    manual_calories: null, manual_carbs_g: null, manual_protein_g: null, manual_fat_g: null,
  });
  expect(ingredients(result.id)).toEqual([]);
});

it('preserves supplied creation metadata, Manual macros and ingredient values', () => {
  const result = createRecipe(getDb(), 1, {
    name: 'Lunch', totalServings: 4, servingUnit: 'bowl',
    manualCalories: 500, manualCarbsG: 60, manualProteinG: 30, manualFatG: 15,
    ingredients: [{ foodId: 10, servings: 2.5, qty: 100, unitLabel: 'g' }],
  });
  expect(result).toEqual({ id: expect.any(Number), name: 'Lunch', totalServings: 4 });
  expect(recipe(result.id)).toMatchObject({
    user_id: 1, name: 'Lunch', total_servings: 4, serving_unit: 'bowl',
    manual_calories: 500, manual_carbs_g: 60, manual_protein_g: 30, manual_fat_g: 15,
  });
  expect(ingredients(result.id)).toEqual([
    expect.objectContaining({ food_id: 10, servings: 2.5, qty: 100, unit_label: 'g' }),
  ]);
});

it('duplicates stored metadata and occurrences exactly with fresh identities and legacy zero servings', () => {
  const source = { recipe: recipe(20), ingredients: ingredients(20) };
  const result = copyRecipe(getDb(), 1, '20');
  expect(result).toEqual({ id: expect.any(Number) });
  expect(result!.id).not.toBe(20);
  expect(recipe(result!.id)).toMatchObject({
    user_id: 1, name: 'Original (Copy)', total_servings: 4, serving_unit: 'bowl',
    manual_calories: 0, manual_carbs_g: 12, manual_protein_g: 8, manual_fat_g: 3,
  });
  const copied = ingredients(result!.id) as { id: number; recipe_id: number; food_id: number; servings: number; qty: number | null; unit_label: string | null }[];
  expect(copied.map(({ id, ...values }) => values)).toEqual([
    { recipe_id: result!.id, food_id: 10, servings: 0, qty: 0, unit_label: '' },
    { recipe_id: result!.id, food_id: 10, servings: 2.5, qty: null, unit_label: null },
  ]);
  expect(new Set(copied.map(row => row.id)).size).toBe(2);
  expect(copied.every(row => row.id !== 30 && row.id !== 31)).toBe(true);
  expect({ recipe: recipe(20), ingredients: ingredients(20) }).toEqual(source);
});

it('rolls back all duplication writes when the second copied ingredient insert fails', () => {
  const before = storedRecipes();
  rejectSecondIngredient();
  expect(() => copyRecipe(getDb(), 1, 20)).toThrow('second ingredient rejected');
  expect(getDb().inTransaction).toBe(false);
  expect(storedRecipes()).toEqual(before);
});

it.each([
  { userId: 2, id: '20' },
  { userId: 1, id: '999999' },
  { userId: 1, id: '20suffix' },
])('treats missing and other-user identities as not found without writes: %j', ({ userId, id }) => {
  const before = storedRecipes();
  expect(updateRecipe(getDb(), userId, id, { name: 'Forbidden', ingredients: [] })).toEqual({ saved: false });
  expect(copyRecipe(getDb(), userId, id)).toBeNull();
  expect(storedRecipes()).toEqual(before);
});

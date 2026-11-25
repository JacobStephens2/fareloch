// @vitest-environment node
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { MealLog } from '../../../src/types.js';
import { getDb, initDb } from '../db.js';
import { signToken } from '../middleware/auth.js';
import mealRoutes from './meals.js';

const date = '2026-11-23';
const nextDate = '2026-11-24';
let server: Server;
let base: string;
let token: string;
let otherToken: string;

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'meal-route-test-secret');
  initDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/meals', mealRoutes);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  base = `http://127.0.0.1:${address.port}/api/meals`;
});

beforeEach(() => {
  getDb().exec(`
    DELETE FROM meal_logs;
    DELETE FROM recipe_ingredients;
    DELETE FROM recipes;
    DELETE FROM foods;
    DELETE FROM users;
    INSERT INTO users (id, email, password_hash, first_name)
      VALUES (1, 'meals@example.com', 'hash', 'Meals'),
             (2, 'other@example.com', 'hash', 'Other');
    INSERT INTO foods (id, user_id, name, brand, serving_size, serving_unit, calories, carbs_g, protein_g, fat_g)
      VALUES (10, 1, 'Oats, "rolled"', 'Mill "A"', 40, 'g', 80.32, 13.24, 4.46, 1.29);
    INSERT INTO recipes (id, user_id, name, total_servings, manual_calories, manual_carbs_g, manual_protein_g, manual_fat_g)
      VALUES (20, 1, 'Oat bake', 3, NULL, NULL, NULL, NULL),
             (21, 2, 'Other recipe', 2, 200.66, 32.22, 12.36, 4.88);
    INSERT INTO recipe_ingredients (recipe_id, food_id, servings) VALUES (20, 10, 2);
  `);
  token = signToken({ userId: 1, email: 'meals@example.com', firstName: 'Meals' });
  otherToken = signToken({ userId: 2, email: 'other@example.com', firstName: 'Other' });
});

afterEach(() => {
  getDb().exec(`
    DROP VIEW IF EXISTS temp.foods;
    DROP TRIGGER IF EXISTS hide_saved_meal;
    DROP TRIGGER IF EXISTS reject_second_copy;
  `);
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  getDb().close();
  vi.unstubAllEnvs();
});

function request(method: string, path: string, body?: unknown, auth: string | null = token) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(method: string, path: string, body?: unknown, auth: string | null = token) {
  const response = await request(method, path, body, auth);
  return { status: response.status, body: await response.json() };
}

async function log(body: object, auth = token): Promise<MealLog> {
  const response = await json('POST', '', body, auth);
  expect(response.status).toBe(200);
  return response.body.meal;
}

async function meals(day = date, auth = token): Promise<MealLog[]> {
  const response = await json('GET', `/${day}`, undefined, auth);
  expect(response.status).toBe(200);
  return response.body.meals;
}

it('rolls back an edit when SQLite fails during its joined readback and can retry', async () => {
  const original = await log({ date, mealType: 'breakfast', foodId: 10, servings: 1.25, unitLabel: 'cup', unitScale: 2.5 });
  await log({ date, mealType: 'snack', calories: 120 }, otherToken);
  const otherBefore = await meals(date, otherToken);

  // Shadow the Food join with a projection that fails only once the new value is visible.
  getDb().exec(`
    CREATE TEMP VIEW foods AS
    SELECT f.id, f.user_id, f.brand, f.serving_size, f.serving_unit,
           CASE WHEN EXISTS (SELECT 1 FROM meal_logs WHERE user_id = 1 AND calories = 200.4)
                THEN json('invalid') ELSE f.name END AS name
    FROM main.foods f;
  `);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const path = `/${original.id}`;
  expect(await json('PUT', path, { calories: 200.4 })).toEqual({
    status: 500, body: { error: 'Failed to update meal' },
  });
  expect(error).toHaveBeenCalledWith('Update meal error:', expect.objectContaining({ message: 'malformed JSON' }));
  getDb().exec('DROP VIEW temp.foods');

  expect(await meals()).toEqual([original]);
  expect(await meals(date, otherToken)).toEqual(otherBefore);

  const updated = { ...original, calories: 200.4 };
  expect(await json('PUT', path, { calories: 200.4 })).toEqual({ status: 200, body: { meal: updated } });
  expect(await meals()).toEqual([updated]);
  expect(await meals(date, otherToken)).toEqual(otherBefore);
});

it.each([
  { operation: 'log', path: '', entry: { note: 'Temporary entry' } },
  { operation: 'Quick Add', path: '/quick', entry: { name: 'Temporary entry' } },
])('rolls back $operation when the saved row is missing from the readback and can retry', async ({ path, entry }) => {
  await log({ date, mealType: 'breakfast', calories: 110, note: 'Existing meal' });
  await log({ date, mealType: 'snack', calories: 120 }, otherToken);
  const before = await meals();
  const otherBefore = await meals(date, otherToken);

  getDb().exec(`
    CREATE TRIGGER hide_saved_meal AFTER INSERT ON meal_logs WHEN NEW.note = 'Temporary entry'
    BEGIN
      UPDATE meal_logs SET calories = 999 WHERE user_id = NEW.user_id AND note = 'Existing meal';
      DELETE FROM meal_logs WHERE id = NEW.id;
    END;
  `);
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const body = { date, mealType: 'snack', calories: 90, ...entry };
  expect.soft(await json('POST', path, body)).toEqual({ status: 500, body: { error: 'Failed to log meal' } });
  expect.soft(await meals()).toEqual(before);
  expect.soft(await meals(date, otherToken)).toEqual(otherBefore);

  getDb().exec('DROP TRIGGER hide_saved_meal');
  const retry = await json('POST', path, body);
  expect(retry.status).toBe(200);
  expect(retry.body.meal).toMatchObject({ calories: 90, note: 'Temporary entry' });
  expect(await meals()).toEqual([...before, expect.objectContaining(retry.body.meal)]);
  expect(await meals(date, otherToken)).toEqual(otherBefore);
});

it.each([
  { fault: 'aborts', action: "RAISE(ABORT, 'injected second copy insert failure')" },
  { fault: 'skips', action: 'RAISE(IGNORE)' },
])('preserves the destination when SQLite $fault the second copy insert and can retry', async ({ action }) => {
  await log({ date, mealType: 'breakfast', foodId: 10, servings: 1.25, unitLabel: 'cup', unitScale: 2.5 });
  await log({ date, mealType: 'lunch', calories: 75.22, note: 'Packed lunch' });
  await log({ date: nextDate, mealType: 'snack', calories: 50 });
  await log({ date, mealType: 'dinner', calories: 200 }, otherToken);
  await log({ date: nextDate, mealType: 'snack', calories: 30 }, otherToken);
  const source = await meals();
  const destination = await meals(nextDate);
  const otherSource = await meals(date, otherToken);
  const otherDestination = await meals(nextDate, otherToken);

  getDb().exec(`
    CREATE TRIGGER reject_second_copy BEFORE INSERT ON meal_logs
    WHEN NEW.date = '${nextDate}' AND (
      SELECT COUNT(*) FROM meal_logs WHERE user_id = NEW.user_id AND date = NEW.date
    ) = 2
    BEGIN SELECT ${action}; END;
  `);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const copy = { fromDate: date, toDate: nextDate };
  expect(await json('POST', '/copy', copy)).toEqual({ status: 500, body: { error: 'Failed to copy meals' } });
  expect(await meals(nextDate)).toEqual(destination);
  expect(await meals()).toEqual(source);
  expect(await meals(nextDate, otherToken)).toEqual(otherDestination);

  getDb().exec('DROP TRIGGER reject_second_copy');
  expect(await json('POST', '/copy', copy)).toEqual({ status: 200, body: { copied: 2 } });
  expect(await meals(nextDate)).toEqual([
    ...source.map(meal => ({
      ...meal, id: expect.any(Number), date: nextDate, created_at: expect.any(String), unit_label: null, unit_scale: null,
    })),
    ...destination,
  ]);
  expect(await meals()).toEqual(source);
  expect(await meals(date, otherToken)).toEqual(otherSource);
  expect(await meals(nextDate, otherToken)).toEqual(otherDestination);
});

it('logs and reads Food, Recipe and manual meals with existing precedence, rounding and Unit fields', async () => {
  const manual = await log({ date, mealType: 'dinner', servings: 0, calories: 30.46, carbsG: 0.73, note: '' });
  expect(manual).toMatchObject({ servings: 1, calories: 30.5, carbs_g: 0.7, protein_g: 0, fat_g: 0, note: null });

  const food = await log({
    date, mealType: 'breakfast', foodId: 10, servings: 1.25, calories: 999, unitLabel: 'cup', unitScale: 2.5,
  });
  expect(food).toMatchObject({
    user_id: 1, food_id: 10, food_name: 'Oats, "rolled"', food_brand: 'Mill "A"', serving_size: 40, serving_unit: 'g',
    servings: 1.25, calories: 100.4, carbs_g: 16.6, protein_g: 5.6, fat_g: 1.6, unit_label: 'cup', unit_scale: 2.5,
  });

  const recipe = await log({ date, mealType: 'lunch', foodId: 10, recipeId: 20, servings: 2, calories: 999 });
  expect(recipe).toMatchObject({
    food_id: 10, food_name: 'Oats, "rolled"', recipe_id: 20, recipe_name: 'Oat bake', servings: 2,
    calories: 107.1, carbs_g: 17.7, protein_g: 5.9, fat_g: 1.7,
  });

  const foodFallback = await log({ date, mealType: 'breakfast', foodId: 10, recipeId: 21, calories: 999 });
  expect(foodFallback).toMatchObject({
    recipe_id: 21, recipe_name: 'Other recipe', servings: 1, calories: 80.3, carbs_g: 13.2, protein_g: 4.5, fat_g: 1.3,
  });
  const manualFallback = await log({ date, mealType: 'snack', recipeId: 21, servings: 2, calories: 47.44 });
  expect(manualFallback).toMatchObject({ recipe_id: 21, recipe_name: 'Other recipe', servings: 2, calories: 47.4 });

  const other = await log({ date, mealType: 'breakfast', recipeId: 21 }, otherToken);
  expect(other).toMatchObject({
    user_id: 2, recipe_name: 'Other recipe', servings: 1, calories: 100.3, carbs_g: 16.1, protein_g: 6.2, fat_g: 2.4,
  });

  getDb().prepare('UPDATE meal_logs SET created_at = ? WHERE id = ?').run('2020-01-01 00:00:00', foodFallback.id);
  expect(await meals()).toEqual([
    { ...foodFallback, created_at: '2020-01-01 00:00:00' }, food, recipe, manual, manualFallback,
  ]);
  expect(await meals(date, otherToken)).toEqual([other]);
});

it('keeps the Quick Add response bare and uses raw Macros, one serving and the name as the note', async () => {
  const response = await json('POST', '/quick', {
    date, mealType: 'snack', name: 'Granola', calories: 42.347, carbsG: 1.234, proteinG: 2.345, fatG: 3.456,
    servings: 5, foodId: 10, unitLabel: 'cup', note: 'Ignored',
  });
  expect(response).toEqual({ status: 200, body: { meal: {
    id: expect.any(Number), user_id: 1, date, meal_type: 'snack', food_id: null, recipe_id: null, servings: 1,
    calories: 42.347, carbs_g: 1.234, protein_g: 2.345, fat_g: 3.456, note: 'Granola', unit_label: null,
    unit_scale: null, created_at: expect.any(String),
  } } });
  expect(await meals()).toEqual([{
    ...response.body.meal, food_name: null, food_brand: null, recipe_name: null, serving_size: null, serving_unit: null,
  }]);
});

it('preserves omitted and null edit fields, saves supplied zeroes and empty notes, and scopes edit and delete', async () => {
  const original = await log({
    date, mealType: 'breakfast', foodId: 10, servings: 1.25, note: 'Packed', unitLabel: 'cup', unitScale: 2.5,
  });
  const other = await log({ date, mealType: 'snack', calories: 20 }, otherToken);
  const path = `/${original.id}.0`;
  for (const missingPath of [`/${other.id}`, '/missing']) {
    expect(await json('PUT', missingPath, { calories: { invalid: true } })).toEqual({
      status: 404, body: { error: 'Meal log not found' },
    });
    expect(await json('DELETE', missingPath)).toEqual({ status: 404, body: { error: 'Meal log not found' } });
  }

  expect(await json('PUT', path, { servings: null, mealType: null, calories: null, note: null })).toEqual({
    status: 200, body: { meal: original },
  });
  const edited = { ...original, meal_type: 'lunch', servings: 0, calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0, note: '' };
  expect(await json('PUT', path, {
    servings: 0, mealType: 'lunch', calories: 0, carbsG: 0, proteinG: 0, fatG: 0, note: '',
    date: nextDate, foodId: null, recipeId: 20, unitLabel: 'g', unitScale: 0,
  })).toEqual({ status: 200, body: { meal: edited } });
  expect(await meals()).toEqual([edited]);
  expect(await meals(nextDate)).toEqual([]);
  expect(await json('DELETE', path)).toEqual({ status: 200, body: { success: true } });
  expect(await meals()).toEqual([]);
  expect(await meals(date, otherToken)).toEqual([other]);
});

it('appends a snapshot when copying onto the same date, with fresh identities and timestamps', async () => {
  const food = await log({ date, mealType: 'lunch', foodId: 10, servings: 1.25, unitLabel: 'cup', unitScale: 2.5 });
  const quick = await json('POST', '/quick', { date, mealType: 'snack', name: 'Raw', calories: 20.493 });
  expect(quick.status).toBe(200);
  const other = await log({ date, mealType: 'lunch', calories: 70 }, otherToken);
  getDb().prepare('UPDATE meal_logs SET created_at = ? WHERE id IN (?, ?)')
    .run('2020-01-01 00:00:00', food.id, quick.body.meal.id);
  const [originalFood, originalQuick] = await meals();

  expect(await json('POST', '/copy', { fromDate: date, toDate: date })).toEqual({ status: 200, body: { copied: 2 } });
  const [savedFood, copiedFood, savedQuick, copiedQuick] = await meals();
  expect(savedFood).toEqual(originalFood);
  expect(savedQuick).toEqual(originalQuick);
  for (const [original, copy] of [[originalFood, copiedFood], [originalQuick, copiedQuick]]) {
    expect(copy).toEqual({ ...original, id: expect.any(Number), created_at: expect.any(String), unit_label: null, unit_scale: null });
    expect(copy.created_at).not.toBe(original.created_at);
  }
  expect(new Set((await meals()).map(meal => meal.id)).size).toBe(4);
  expect(await meals(date, otherToken)).toEqual([other]);
});

it('keeps inclusive date totals and caller-scoped CSV ordering, escaping and fallback names', async () => {
  await log({ date: nextDate, mealType: 'lunch', foodId: 10, note: 'Packed, "early"' });
  await log({ date: nextDate, mealType: 'breakfast', calories: 8.7 });
  await log({ date, mealType: 'lunch', recipeId: 20, servings: 2 });
  const quick = await json('POST', '/quick', { date, mealType: 'dinner', name: 'Late "bite"', calories: 0.125 });
  expect(quick.status).toBe(200);
  await log({ date, mealType: 'snack', calories: 15 }, otherToken);

  expect(await json('GET', `/totals/${date}/${nextDate}`)).toEqual({ status: 200, body: { totals: [
    { date, total_calories: 107.225, total_carbs: 17.7, total_protein: 5.9, total_fat: 1.7 },
    { date: nextDate, total_calories: 89, total_carbs: 13.2, total_protein: 4.5, total_fat: 1.3 },
  ] } });
  expect(await json('GET', `/totals/${date}/${nextDate}`, undefined, otherToken)).toEqual({
    status: 200, body: { totals: [{ date, total_calories: 15, total_carbs: 0, total_protein: 0, total_fat: 0 }] },
  });

  const csv = await request('GET', '/export/csv');
  const header = 'Date,Meal,Food,Brand,Servings,Calories,Carbs(g),Protein(g),Fat(g),Note';
  expect(csv.status).toBe(200);
  expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(csv.headers.get('content-disposition')).toBe('attachment; filename=fareloch-meals.csv');
  expect(await csv.text()).toBe([
    header,
    `${nextDate},breakfast,"Quick entry",,1,8.7,0,0,0,`,
    `${nextDate},lunch,"Oats, ""rolled""","Mill ""A""",1,80.3,13.2,4.5,1.3,"Packed, ""early"""`,
    `${date},dinner,"Late ""bite""",,1,0.125,0,0,0,"Late ""bite"""`,
    `${date},lunch,"Oat bake",,2,107.1,17.7,5.9,1.7,`,
  ].join('\n'));
  const otherCsv = await request('GET', '/export/csv', undefined, otherToken);
  expect(await otherCsv.text()).toBe(`${header}\n${date},snack,"Quick entry",,1,15,0,0,0,`);
});

it('preserves authentication, request validation and empty-source responses', async () => {
  expect(await json('GET', `/${date}`, undefined, null)).toEqual({ status: 401, body: { error: 'Not authenticated' } });
  expect(await json('POST', '/quick', {}, 'invalid-token')).toEqual({
    status: 401, body: { error: 'Invalid or expired token' },
  });
  expect(await json('POST', '', { date })).toEqual({ status: 400, body: { error: 'Date and meal type are required' } });
  expect(await json('POST', '', { date, mealType: 'lunch' })).toEqual({
    status: 400, body: { error: 'A food, recipe, or manual macros are required' },
  });
  expect(await json('POST', '/quick', { mealType: 'lunch' })).toEqual({
    status: 400, body: { error: 'Date and meal type are required' },
  });
  expect(await json('POST', '/copy', { fromDate: date })).toEqual({
    status: 400, body: { error: 'fromDate and toDate are required' },
  });
  await log({ date, mealType: 'snack', calories: 15 }, otherToken);
  expect(await json('POST', '/copy', { fromDate: date, toDate: nextDate })).toEqual({
    status: 404, body: { error: 'No meals found on that date' },
  });
  expect(await meals()).toEqual([]);
  expect(await meals(nextDate)).toEqual([]);
});

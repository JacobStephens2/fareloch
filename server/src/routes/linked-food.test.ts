import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { signToken } from '../middleware/auth.js';
import { getDb, initDb } from '../db.js';
import foodRoutes from './foods.js';
import mealRoutes from './meals.js';
import recipeRoutes from './recipes.js';

process.env.JWT_SECRET = 'test-secret';

let server: Server;
let port: number;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fareloch-linked-food-'));
  initDb(join(dir, 'macros.db'));
  const app = express();
  app.use(express.json());
  app.use('/api/foods', foodRoutes);
  app.use('/api/meals', mealRoutes);
  app.use('/api/recipes', recipeRoutes);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a tcp port');
  port = address.port;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
  getDb().close();
});

function addUser(email: string, firstName: string): number {
  const result = getDb().prepare(
    'INSERT INTO users (email, password_hash, first_name) VALUES (?, ?, ?)'
  ).run(email, 'hash', firstName);
  return Number(result.lastInsertRowid);
}

function tokenFor(userId: number, email: string, firstName: string): string {
  return signToken({ userId, email, firstName });
}

function addFood(userId: number | null, name: string, brand: string | null, calories: number): number {
  const result = getDb().prepare(`
    INSERT INTO foods (user_id, name, brand, serving_size, serving_unit, calories, carbs_g, protein_g, fat_g, source)
    VALUES (?, ?, ?, 40, 'g', ?, 10, 4, 2, 'manual')
  `).run(userId, name, brand, calories);
  return Number(result.lastInsertRowid);
}

function addMeal(userId: number, date: string, foodId: number, note: string): number {
  const result = getDb().prepare(`
    INSERT INTO meal_logs (user_id, date, meal_type, food_id, servings, calories, carbs_g, protein_g, fat_g, note)
    VALUES (?, ?, 'breakfast', ?, 1, 1, 1, 1, 1, ?)
  `).run(userId, date, foodId, note);
  return Number(result.lastInsertRowid);
}

async function getJson(path: string, token: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, data: await res.json(), text: '' };
}

async function getText(path: string, token: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, text: await res.text() };
}

async function postJson(path: string, token: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function putJson(path: string, token: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

it('shows a meal food only when the caller owns it or it has no owner', async () => {
  const ada = addUser('ada-meals@example.com', 'Ada');
  const grace = addUser('grace-meals@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-meals@example.com', 'Ada');
  const own = addFood(ada, 'Ada oats', 'Ada Mill', 150);
  const shared = addFood(null, 'Pantry rice', null, 40);
  const secret = addFood(grace, 'Secret granola', 'Grace Pantry', 999);
  addMeal(ada, '2026-10-22', own, 'own');
  addMeal(ada, '2026-10-22', shared, 'shared');
  addMeal(ada, '2026-10-22', secret, 'theirs');

  const listed = await getJson('/api/meals/2026-10-22', adaToken);
  expect(listed.status).toBe(200);
  const byNote = Object.fromEntries(listed.data.meals.map((meal: { note: string }) => [meal.note, meal]));
  expect(byNote.own).toMatchObject({ food_name: 'Ada oats', food_brand: 'Ada Mill', serving_size: 40, serving_unit: 'g' });
  expect(byNote.shared).toMatchObject({ food_name: 'Pantry rice', food_brand: null, serving_size: 40, serving_unit: 'g' });
  expect(byNote.theirs).toMatchObject({ food_name: null, food_brand: null, serving_size: null, serving_unit: null });
  expect(JSON.stringify(listed.data)).not.toContain('Secret granola');
  expect(JSON.stringify(listed.data)).not.toContain('Grace Pantry');
});

it('logs a meal from the caller food or an unowned food, and not from another caller food', async () => {
  const ada = addUser('ada-log@example.com', 'Ada');
  const grace = addUser('grace-log@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-log@example.com', 'Ada');
  const own = addFood(ada, 'Ada lentils', 'Ada Mill', 150);
  const shared = addFood(null, 'Pantry beans', null, 40);
  const secret = addFood(grace, 'Secret stew', 'Grace Pantry', 999);

  const loggedOwn = await postJson('/api/meals', adaToken, {
    date: '2026-10-23', mealType: 'lunch', foodId: own, servings: 2,
  });
  expect(loggedOwn.status).toBe(200);
  expect(loggedOwn.data.meal).toMatchObject({
    food_id: own,
    food_name: 'Ada lentils',
    food_brand: 'Ada Mill',
    calories: 300,
    carbs_g: 20,
    protein_g: 8,
    fat_g: 4,
  });

  const loggedShared = await postJson('/api/meals', adaToken, {
    date: '2026-10-23', mealType: 'dinner', foodId: shared, servings: 1,
  });
  expect(loggedShared.status).toBe(200);
  expect(loggedShared.data.meal).toMatchObject({
    food_id: shared,
    food_name: 'Pantry beans',
    food_brand: null,
    calories: 40,
    carbs_g: 10,
    protein_g: 4,
    fat_g: 2,
  });

  const loggedSecret = await postJson('/api/meals', adaToken, {
    date: '2026-10-23', mealType: 'snack', foodId: secret, servings: 2,
  });
  expect(loggedSecret.status).toBe(200);
  expect(loggedSecret.data.meal).toMatchObject({
    food_name: null,
    food_brand: null,
    serving_size: null,
    serving_unit: null,
    calories: 0,
    carbs_g: 0,
    protein_g: 0,
    fat_g: 0,
  });
  expect(JSON.stringify(loggedSecret.data)).not.toContain('Secret stew');
  expect(JSON.stringify(loggedSecret.data)).not.toContain('Grace Pantry');
});

it('keeps another caller food off an updated meal and a meal export', async () => {
  const ada = addUser('ada-export@example.com', 'Ada');
  const grace = addUser('grace-export@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-export@example.com', 'Ada');
  const own = addFood(ada, 'Ada toast', 'Ada Mill', 150);
  const shared = addFood(null, 'Pantry toast', null, 40);
  const secret = addFood(grace, 'Secret toast', 'Grace Pantry', 999);
  const ownMeal = addMeal(ada, '2026-10-24', own, 'own toast');
  addMeal(ada, '2026-10-24', shared, 'shared toast');
  const secretMeal = addMeal(ada, '2026-10-24', secret, 'their toast');

  const updatedOwn = await putJson(`/api/meals/${ownMeal}`, adaToken, { servings: 2 });
  expect(updatedOwn.status).toBe(200);
  expect(updatedOwn.data.meal).toMatchObject({ food_name: 'Ada toast', food_brand: 'Ada Mill' });

  const updatedSecret = await putJson(`/api/meals/${secretMeal}`, adaToken, { note: 'still theirs' });
  expect(updatedSecret.status).toBe(200);
  expect(updatedSecret.data.meal).toMatchObject({
    food_name: null, food_brand: null, serving_size: null, serving_unit: null, note: 'still theirs',
  });
  expect(JSON.stringify(updatedSecret.data)).not.toContain('Secret toast');
  expect(JSON.stringify(updatedSecret.data)).not.toContain('Grace Pantry');

  const exported = await getText('/api/meals/export/csv', adaToken);
  expect(exported.status).toBe(200);
  expect(exported.text).toContain('Ada toast');
  expect(exported.text).toContain('Pantry toast');
  expect(exported.text).not.toContain('Secret toast');
  expect(exported.text).not.toContain('Grace Pantry');
});

it('lists a food from the caller meals only when the caller owns it or it has no owner', async () => {
  const ada = addUser('ada-recent@example.com', 'Ada');
  const grace = addUser('grace-recent@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-recent@example.com', 'Ada');
  const own = addFood(ada, 'Ada yogurt', 'Ada Mill', 150);
  const shared = addFood(null, 'Pantry yogurt', null, 40);
  const secret = addFood(grace, 'Secret yogurt', 'Grace Pantry', 999);
  addMeal(ada, '2026-10-25', own, 'own yogurt');
  addMeal(ada, '2026-10-25', shared, 'shared yogurt');
  addMeal(ada, '2026-10-25', secret, 'their yogurt');

  const recent = await getJson('/api/foods/recent', adaToken);
  expect(recent.status).toBe(200);
  const names = recent.data.foods.map((food: { name: string }) => food.name);
  expect(names).toContain('Ada yogurt');
  expect(names).toContain('Pantry yogurt');
  expect(names).not.toContain('Secret yogurt');
  expect(JSON.stringify(recent.data)).not.toContain('Grace Pantry');
  expect(JSON.stringify(recent.data)).not.toContain('"calories":999');
});

it('returns a recipe ingredient only when the caller owns the food or it has no owner', async () => {
  const ada = addUser('ada-recipe@example.com', 'Ada');
  const grace = addUser('grace-recipe@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-recipe@example.com', 'Ada');
  const own = addFood(ada, 'Ada flour', 'Ada Mill', 150);
  const shared = addFood(null, 'Pantry flour', null, 40);
  const secret = addFood(grace, 'Secret flour', 'Grace Pantry', 999);

  const created = await postJson('/api/recipes', adaToken, {
    name: 'Ada bread',
    totalServings: 2,
    ingredients: [
      { foodId: own, servings: 1 },
      { foodId: shared, servings: 1 },
      { foodId: secret, servings: 1 },
    ],
  });
  expect(created.status).toBe(200);

  const loaded = await getJson(`/api/recipes/${created.data.recipe.id}`, adaToken);
  expect(loaded.status).toBe(200);
  const ingredients = loaded.data.ingredients as { name: string; calories: number; brand: string | null }[];
  expect(ingredients.map((ingredient) => ingredient.name).sort()).toEqual(['Ada flour', 'Pantry flour']);
  expect(ingredients.find((ingredient) => ingredient.name === 'Ada flour')).toMatchObject({ calories: 150, brand: 'Ada Mill' });
  expect(ingredients.find((ingredient) => ingredient.name === 'Pantry flour')).toMatchObject({ calories: 40, brand: null });
  expect(JSON.stringify(loaded.data)).not.toContain('Secret flour');
  expect(JSON.stringify(loaded.data)).not.toContain('Grace Pantry');
  expect(JSON.stringify(loaded.data)).not.toContain('"calories":999');
});

it('counts per-serving nutrition only from a food the caller owns or that has no owner', async () => {
  const ada = addUser('ada-serving@example.com', 'Ada');
  const grace = addUser('grace-serving@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-serving@example.com', 'Ada');
  const own = addFood(ada, 'Ada millet', 'Ada Mill', 150);
  const shared = addFood(null, 'Pantry millet', null, 40);
  const secret = addFood(grace, 'Secret millet', 'Grace Pantry', 999);

  const created = await postJson('/api/recipes', adaToken, {
    name: 'Ada porridge',
    totalServings: 2,
    ingredients: [
      { foodId: own, servings: 1 },
      { foodId: shared, servings: 1 },
      { foodId: secret, servings: 1 },
    ],
  });
  expect(created.status).toBe(200);

  const listed = await getJson('/api/recipes', adaToken);
  expect(listed.status).toBe(200);
  const recipe = listed.data.recipes.find((item: { name: string }) => item.name === 'Ada porridge');
  expect(recipe).toMatchObject({
    ingredientCount: 2,
    perServing: { calories: 95, carbsG: 10, proteinG: 4, fatG: 2 },
  });
  expect(JSON.stringify(recipe)).not.toContain('Secret millet');
  expect(JSON.stringify(recipe)).not.toContain('Grace Pantry');

  const logged = await postJson('/api/meals', adaToken, {
    date: '2026-10-26', mealType: 'breakfast', recipeId: created.data.recipe.id, servings: 1,
  });
  expect(logged.status).toBe(200);
  expect(logged.data.meal).toMatchObject({
    recipe_name: 'Ada porridge',
    calories: 95,
    carbs_g: 10,
    protein_g: 4,
    fat_g: 2,
  });
  expect(JSON.stringify(logged.data)).not.toContain('Secret millet');
});

it('does not link another caller food when logging a meal', async () => {
  const ada = addUser('ada-store-meal@example.com', 'Ada');
  const grace = addUser('grace-store-meal@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-store-meal@example.com', 'Ada');
  const secret = addFood(grace, 'Secret stew', 'Grace Pantry', 999);

  const logged = await postJson('/api/meals', adaToken, {
    date: '2026-10-27', mealType: 'snack', foodId: secret, servings: 1,
  });

  if (logged.status === 200) {
    expect(logged.data.meal.food_id).not.toBe(secret);
  } else {
    expect(logged.status).toBe(400);
  }
  const stored = getDb().prepare(
    'SELECT food_id FROM meal_logs WHERE user_id = ? AND date = ?'
  ).all(ada, '2026-10-27') as { food_id: number | null }[];
  expect(stored.map((row) => row.food_id)).not.toContain(secret);
});

it('does not link another caller food when saving a recipe', async () => {
  const ada = addUser('ada-store-recipe@example.com', 'Ada');
  const grace = addUser('grace-store-recipe@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-store-recipe@example.com', 'Ada');
  const own = addFood(ada, 'Ada flour', 'Ada Mill', 150);
  const secret = addFood(grace, 'Secret flour', 'Grace Pantry', 999);

  const created = await postJson('/api/recipes', adaToken, {
    name: 'Ada bread',
    totalServings: 2,
    ingredients: [
      { foodId: own, servings: 1 },
      { foodId: secret, servings: 1 },
    ],
  });
  expect(created.status).toBe(200);
  const stored = getDb().prepare(
    'SELECT food_id FROM recipe_ingredients WHERE recipe_id = ?'
  ).all(created.data.recipe.id) as { food_id: number }[];
  expect(stored.map((row) => row.food_id)).toContain(own);
  expect(stored.map((row) => row.food_id)).not.toContain(secret);
});

it('does not keep another caller food when a recipe is updated or copied', async () => {
  const ada = addUser('ada-recipe-copy@example.com', 'Ada');
  const grace = addUser('grace-recipe-copy@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-recipe-copy@example.com', 'Ada');
  const own = addFood(ada, 'Ada rye', 'Ada Mill', 150);
  const shared = addFood(null, 'Pantry rye', null, 40);
  const secret = addFood(grace, 'Secret rye', 'Grace Pantry', 999);
  const created = await postJson('/api/recipes', adaToken, {
    name: 'Ada rye loaf',
    totalServings: 1,
    ingredients: [{ foodId: own, servings: 1 }],
  });
  expect(created.status).toBe(200);
  const recipeId = created.data.recipe.id as number;

  const updated = await putJson(`/api/recipes/${recipeId}`, adaToken, {
    ingredients: [
      { foodId: shared, servings: 1 },
      { foodId: secret, servings: 1 },
    ],
  });
  expect(updated.status).toBe(200);
  const afterUpdate = getDb().prepare(
    'SELECT food_id FROM recipe_ingredients WHERE recipe_id = ?'
  ).all(recipeId) as { food_id: number }[];
  expect(afterUpdate.map((row) => row.food_id)).toEqual([shared]);

  getDb().prepare(
    'INSERT INTO recipe_ingredients (recipe_id, food_id, servings) VALUES (?, ?, 1)'
  ).run(recipeId, secret);
  const copied = await postJson(`/api/recipes/${recipeId}/copy`, adaToken, {});
  expect(copied.status).toBe(200);
  const copiedIds = getDb().prepare(
    'SELECT food_id FROM recipe_ingredients WHERE recipe_id = ?'
  ).all(copied.data.recipe.id) as { food_id: number }[];
  expect(copiedIds.map((row) => row.food_id)).toEqual([shared]);
});

it('does not copy a link to another caller food onto another day', async () => {
  const ada = addUser('ada-meal-copy@example.com', 'Ada');
  const grace = addUser('grace-meal-copy@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-meal-copy@example.com', 'Ada');
  const own = addFood(ada, 'Ada copy oats', 'Ada Mill', 150);
  const shared = addFood(null, 'Pantry copy rice', null, 40);
  const secret = addFood(grace, 'Secret copy granola', 'Grace Pantry', 999);
  addMeal(ada, '2026-10-28', own, 'own copy');
  addMeal(ada, '2026-10-28', shared, 'shared copy');
  addMeal(ada, '2026-10-28', secret, 'their copy');

  const copied = await postJson('/api/meals/copy', adaToken, {
    fromDate: '2026-10-28', toDate: '2026-10-29',
  });
  expect(copied.status).toBe(200);
  expect(copied.data.copied).toBe(3);
  const stored = getDb().prepare(
    'SELECT food_id, note FROM meal_logs WHERE user_id = ? AND date = ?'
  ).all(ada, '2026-10-29') as { food_id: number | null; note: string }[];
  const byNote = Object.fromEntries(stored.map((row) => [row.note, row.food_id]));
  expect(byNote['own copy']).toBe(own);
  expect(byNote['shared copy']).toBe(shared);
  expect(byNote['their copy']).toBeNull();
});

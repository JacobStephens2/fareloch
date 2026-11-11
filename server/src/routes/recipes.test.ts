// @vitest-environment node
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../db.js';
import { signToken } from '../middleware/auth.js';
import recipeRoutes from './recipes.js';

process.env.JWT_SECRET = 'recipe-route-test-secret';

let server: Server;
let base: string;
let token: string;

beforeAll(async () => {
  initDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/recipes', recipeRoutes);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  base = `http://127.0.0.1:${address.port}/api/recipes`;
});

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
    INSERT INTO recipes (id, user_id, name, total_servings, manual_calories)
      VALUES (20, 1, 'Original', 4, 100);
    INSERT INTO recipe_ingredients (id, recipe_id, food_id, servings, qty, unit_label)
      VALUES (30, 20, 10, 2, 80, 'g'), (31, 20, 10, 3, 120, 'g');
  `);
  token = signToken({ userId: 1, email: 'recipe@example.com', firstName: 'Recipe' });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  getDb().close();
});

async function request(method: string, path = '', body?: unknown, auth: string | null = token) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function storedRecipes() {
  return {
    recipes: getDb().prepare('SELECT * FROM recipes ORDER BY id').all(),
    ingredients: getDb().prepare('SELECT * FROM recipe_ingredients ORDER BY id').all(),
  };
}

it.each([
  { operation: 'creation', method: 'POST', path: '', errorMessage: 'Failed to create recipe' },
  { operation: 'update', method: 'PUT', path: '/20', errorMessage: 'Failed to update recipe' },
  { operation: 'duplication', method: 'POST', path: '/20/copy', errorMessage: 'Failed to copy recipe' },
])('rolls back $operation before reporting a late ingredient failure', async ({ method, path, errorMessage }) => {
  const before = storedRecipes();
  getDb().exec(`
    CREATE TEMP TRIGGER reject_second_ingredient BEFORE INSERT ON recipe_ingredients
    WHEN (SELECT count(*) FROM recipe_ingredients WHERE recipe_id = NEW.recipe_id) = 1
    BEGIN SELECT RAISE(ABORT, 'second ingredient rejected'); END;
  `);
  let atFailure: unknown;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    atFailure = { inTransaction: getDb().inTransaction, stored: storedRecipes() };
  });

  expect(await request(method, path, {
    name: 'New recipe', ingredients: [{ foodId: 10 }, { foodId: 10 }],
  })).toEqual({ status: 500, body: { error: errorMessage } });
  expect(error).toHaveBeenCalled();
  expect(atFailure).toEqual({ inTransaction: false, stored: before });
  expect(storedRecipes()).toEqual(before);
});

it('maps successful creation, update and duplication to the existing response bodies', async () => {
  const created = await request('POST', '', { name: 'New recipe', totalServings: 0 });
  expect(created).toEqual({
    status: 200, body: { recipe: { id: expect.any(Number), name: 'New recipe', totalServings: 1 } },
  });
  expect(await request('PUT', `/${created.body.recipe.id}`, { name: 'Changed', ingredients: [] }))
    .toEqual({ status: 200, body: { success: true } });
  const copied = await request('POST', `/${created.body.recipe.id}/copy`);
  expect(copied).toEqual({ status: 200, body: { recipe: { id: expect.any(Number) } } });
  expect(copied.body.recipe.id).not.toBe(created.body.recipe.id);
  const read = await request('GET', `/${copied.body.recipe.id}`);
  expect(read.status).toBe(200);
  expect(read.body.recipe.name).toBe('Changed (Copy)');
});

it.each([{}, { name: '' }, { name: null }, { name: 0 }])('keeps missing-name validation for %j', async body => {
  const before = storedRecipes();
  expect(await request('POST', '', body)).toEqual({ status: 400, body: { error: 'Name is required' } });
  expect(storedRecipes()).toEqual(before);
});

it.each([
  { method: 'POST', path: '' },
  { method: 'PUT', path: '/20' },
  { method: 'POST', path: '/20/copy' },
])('requires authentication for $method $path', async ({ method, path }) => {
  const before = storedRecipes();
  expect(await request(method, path, { name: 'Forbidden' }, null))
    .toEqual({ status: 401, body: { error: 'Not authenticated' } });
  expect(await request(method, path, { name: 'Forbidden' }, 'invalid-token'))
    .toEqual({ status: 401, body: { error: 'Invalid or expired token' } });
  expect(storedRecipes()).toEqual(before);
});

it.each([
  { method: 'PUT', suffix: '' },
  { method: 'POST', suffix: '/copy' },
])('maps missing and other-user identities to not found for $method', async ({ method, suffix }) => {
  const before = storedRecipes();
  const otherToken = signToken({ userId: 2, email: 'other@example.com', firstName: 'Other' });
  for (const [id, auth] of [['20', otherToken], ['999999', token], ['20suffix', token]]) {
    expect(await request(method, `/${id}${suffix}`, { name: 'Forbidden', ingredients: [] }, auth))
      .toEqual({ status: 404, body: { error: 'Recipe not found' } });
  }
  expect(storedRecipes()).toEqual(before);
});

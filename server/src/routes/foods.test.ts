import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { signToken } from '../middleware/auth.js';
import { getDb } from '../db.js';
import foodRoutes from './foods.js';

process.env.JWT_SECRET = 'test-secret';

const oats = {
  name: 'Rolled oats',
  brand: "Bob's Red Mill",
  barcode: '012345678905',
  servingSize: 40,
  servingUnit: 'g',
  calories: 150,
  carbsG: 27,
  proteinG: 5,
  fatG: 2.5,
  fiberG: 4,
  sugarG: 1,
  source: 'usda',
  sourceId: '168878',
  measures: [{ label: '1/2 cup', gramWeight: 40 }],
};

let server: Server;
let port: number;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fareloch-foods-'));
  getDb(join(dir, 'macros.db'));
  const app = express();
  app.use(express.json());
  app.use('/api/foods', foodRoutes);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a tcp port');
  port = address.port;
});

afterAll(async () => {
  vi.unstubAllGlobals();
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

async function postSave(token: string | null, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/foods/save-external`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function getBarcode(code: string, token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/foods/barcode/${code}`, { headers });
  return { status: res.status, data: await res.json() };
}

function upstream(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function product(name: string): Response {
  return upstream({
    status: 1,
    product: {
      product_name: name,
      brands: 'Pod',
      serving_quantity: '80',
      serving_quantity_unit: 'g',
      nutriments: {
        'energy-kcal_serving': 90,
        carbohydrates_serving: 12,
        proteins_serving: 6,
        fat_serving: 1,
        fiber_serving: 4,
        sugars_serving: 2,
      },
    },
  });
}

const realFetch = globalThis.fetch.bind(globalThis);

function stubUpstream(product: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    return product();
  }));
}

it('refuses to save an external food without a signed-in caller', async () => {
  const missing = await postSave(null, oats);
  expect(missing.status).toBe(401);
  expect(missing.data).toEqual({ error: 'Not authenticated' });

  const invalid = await postSave('not-a-token', oats);
  expect(invalid.status).toBe(401);
  expect(invalid.data).toEqual({ error: 'Invalid or expired token' });
});

it('saves an external food under the signed-in caller', async () => {
  const ada = addUser('ada@example.com', 'Ada');
  const saved = await postSave(tokenFor(ada, 'ada@example.com', 'Ada'), oats);

  expect(saved.status).toBe(200);
  expect(saved.data.food).toMatchObject({
    user_id: ada,
    name: 'Rolled oats',
    brand: "Bob's Red Mill",
    barcode: '012345678905',
    serving_size: 40,
    serving_unit: 'g',
    calories: 150,
    carbs_g: 27,
    protein_g: 5,
    fat_g: 2.5,
    fiber_g: 4,
    sugar_g: 1,
    source: 'usda',
    source_id: '168878',
  });
  expect(JSON.parse(saved.data.food.measures)).toEqual([{ label: '1/2 cup', gramWeight: 40 }]);
});

it('returns the same caller saved food for the same source and source id', async () => {
  const ada = addUser('ada-again@example.com', 'Ada');
  const first = await postSave(tokenFor(ada, 'ada-again@example.com', 'Ada'), oats);
  const second = await postSave(tokenFor(ada, 'ada-again@example.com', 'Ada'), {
    ...oats,
    name: 'Not the saved oats',
    calories: 1,
  });

  expect(second.status).toBe(200);
  expect(second.data.food.id).toBe(first.data.food.id);
  expect(second.data.food.name).toBe('Rolled oats');
  expect(second.data.food.calories).toBe(150);
  expect(second.data.food.user_id).toBe(ada);
});

it('does not return another caller food for the same source and source id', async () => {
  const ada = addUser('ada-owner@example.com', 'Ada');
  const grace = addUser('grace@example.com', 'Grace');
  const adas = await postSave(tokenFor(ada, 'ada-owner@example.com', 'Ada'), oats);
  const graces = await postSave(tokenFor(grace, 'grace@example.com', 'Grace'), {
    ...oats,
    name: 'Steel cut oats',
    calories: 170,
  });

  expect(graces.status).toBe(200);
  expect(graces.data.food.id).not.toBe(adas.data.food.id);
  expect(graces.data.food).toMatchObject({
    user_id: grace,
    name: 'Steel cut oats',
    calories: 170,
    source: 'usda',
    source_id: '168878',
  });
});

it('does not return another caller saved food from the barcode cache', async () => {
  stubUpstream(() => upstream({ status: 0 }));
  const ada = addUser('ada-barcode@example.com', 'Ada');
  const grace = addUser('grace-barcode@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-barcode@example.com', 'Ada');
  const saved = await postSave(adaToken, {
    ...oats,
    barcode: '000111222333',
    sourceId: 'barcode-oats',
  });

  const graces = await getBarcode('000111222333', tokenFor(grace, 'grace-barcode@example.com', 'Grace'));
  expect(graces.status).toBe(404);
  expect(graces.data).toEqual({ error: 'Product not found' });

  const guest = await getBarcode('000111222333', null);
  expect(guest.status).toBe(404);
  expect(guest.data).toEqual({ error: 'Product not found' });

  const adas = await getBarcode('000111222333', adaToken);
  expect(adas.status).toBe(200);
  expect(adas.data.food.id).toBe(saved.data.food.id);
  expect(adas.data.food.user_id).toBe(ada);
  expect(adas.data.food.name).toBe('Rolled oats');
});

it('returns an unowned barcode cache to a caller who is not signed in', async () => {
  stubUpstream(() => product('Shared beans'));
  const first = await getBarcode('444444444444', null);
  expect(first.status).toBe(200);
  expect(first.data.food.name).toBe('Shared beans');
  expect(first.data.food.calories).toBe(90);

  stubUpstream(() => {
    throw new Error('upstream should not be read');
  });
  const second = await getBarcode('444444444444', null);
  expect(second.status).toBe(200);
  expect(second.data.food.id).toBe(first.data.food.id);
  expect(second.data.food.name).toBe('Shared beans');
  expect(second.data.food.user_id).toBeNull();

  stubUpstream(() => upstream({ status: 0 }));
  const ada = addUser('ada-unowned@example.com', 'Ada');
  const signedIn = await getBarcode('444444444444', tokenFor(ada, 'ada-unowned@example.com', 'Ada'));
  expect(signedIn.status).toBe(404);
  expect(signedIn.data).toEqual({ error: 'Product not found' });
});

it('caches a barcode food under the signed-in caller', async () => {
  stubUpstream(() => product('Upstream peas'));
  const ada = addUser('ada-cache@example.com', 'Ada');
  const grace = addUser('grace-cache@example.com', 'Grace');
  const adaToken = tokenFor(ada, 'ada-cache@example.com', 'Ada');
  const first = await getBarcode('666666666666', adaToken);
  expect(first.status).toBe(200);
  expect(first.data.food.name).toBe('Upstream peas');
  expect(first.data.food.calories).toBe(90);

  stubUpstream(() => product('Different peas'));
  const second = await getBarcode('666666666666', adaToken);
  expect(second.status).toBe(200);
  expect(second.data.food.id).toBe(first.data.food.id);
  expect(second.data.food.name).toBe('Upstream peas');
  expect(second.data.food.user_id).toBe(ada);

  const graceToken = tokenFor(grace, 'grace-cache@example.com', 'Grace');
  const graces = await getBarcode('666666666666', graceToken);
  expect(graces.status).toBe(200);
  expect(graces.data.food.name).toBe('Different peas');
  expect(graces.data.food.calories).toBe(90);

  stubUpstream(() => {
    throw new Error('upstream should not be read');
  });
  const gracesCached = await getBarcode('666666666666', graceToken);
  expect(gracesCached.status).toBe(200);
  expect(gracesCached.data.food.id).toBe(graces.data.food.id);
  expect(gracesCached.data.food.name).toBe('Different peas');
  expect(gracesCached.data.food.user_id).toBe(grace);
});

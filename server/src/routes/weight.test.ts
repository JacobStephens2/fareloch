// @vitest-environment node
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { getDb, initDb } from '../db.js';
import { signToken } from '../middleware/auth.js';
import weightRoutes from './weight.js';
import authRoutes from './auth.js';

process.env.JWT_SECRET = 'weight-test-secret';

let server: Server;
let base: string;
let token: string;

beforeAll(async () => {
  initDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/weight', weightRoutes);
  app.use('/api/auth', authRoutes);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  base = `http://127.0.0.1:${address.port}/api/weight`;
});

beforeEach(() => {
  getDb().exec('DELETE FROM weight_logs; DELETE FROM users;');
  const result = getDb().prepare(
    'INSERT INTO users (email, password_hash, first_name) VALUES (?, ?, ?)'
  ).run('waist@example.com', 'hash', 'Waist');
  token = signToken({ userId: Number(result.lastInsertRowid), email: 'waist@example.com', firstName: 'Waist' });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  getDb().close();
});

async function request(path = '', body?: unknown) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it('persists an optional navel waist measurement and returns it in weight history', async () => {
  const response = await request('', { date: '2026-11-04', time: '07:30', weightLbs: 165, waistInches: 30.8 });
  expect(response.status).toBe(200);
  expect((await response.json()).log).toMatchObject({ weight_lbs: 165, waist_inches: 30.8 });
  expect((await (await request()).json()).logs).toEqual([
    expect.objectContaining({ date: '2026-11-04', time: '07:30', waist_inches: 30.8 }),
  ]);
});

it('updates the matching date and time, keeps other times, and clears an omitted waist', async () => {
  const entry = { date: '2026-11-04', time: '07:30', weightLbs: 165, waistInches: 30.8 };
  const original = (await (await request('', entry)).json()).log;
  await request('', { ...entry, time: '08:30', waistInches: 31 });
  const updated = (await (await request('', { ...entry, weightLbs: 166, waistInches: 31.2 })).json()).log;
  expect(updated).toMatchObject({ id: original.id, weight_lbs: 166, waist_inches: 31.2 });
  const cleared = (await (await request('', { date: entry.date, time: entry.time, weightLbs: 167 })).json()).log;
  expect(cleared).toMatchObject({ id: original.id, waist_inches: null });
  expect((await (await request()).json()).logs).toEqual([
    expect.objectContaining({ time: '08:30', waist_inches: 31 }),
    expect.objectContaining({ time: '07:30', waist_inches: null }),
  ]);
});

it.each([{}, { waistInches: null }])('allows weight-only logging with %j', async (waist) => {
  const response = await request('', { date: '2026-11-04', weightLbs: 165, ...waist });
  expect(response.status).toBe(200);
  expect((await response.json()).log).toMatchObject({ time: '', waist_inches: null });
});

it('exports measured and weight-only rows with a blank waist cell and escaped notes', async () => {
  await request('', { date: '2026-11-04', time: '07:30', weightLbs: 165, waistInches: 30.8, notes: 'Navel, relaxed "AM"' });
  await request('', { date: '2026-11-03', weightLbs: 164 });
  const response = await request('/export/csv');
  expect(response.headers.get('content-type')).toContain('text/csv');
  expect(await response.text()).toBe(
    'Date,Time,Weight(lbs),Waist(in),Notes\n2026-11-04,07:30,165,30.8,"Navel, relaxed ""AM"""\n2026-11-03,,164,,'
  );
});

it.each(['30.8', {}, true, 19.9, 60.1])('rejects an invalid waist measurement %j without writing a log', async (waistInches) => {
  const response = await request('', { date: '2026-11-04', weightLbs: 165, waistInches });
  expect(response.status).toBe(400);
  expect((await (await request()).json()).logs).toEqual([]);
});

it('saves, reads and clears a personal waist ceiling without changing macro targets', async () => {
  const profile = async (body?: unknown) => fetch(`${base.replace('/weight', '/auth/me')}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const before = (await (await profile()).json()).user;
  expect(before.targetWaistInches).toBeNull();
  const saved = await profile({ targetWaistInches: 31.25 });
  expect(saved.status).toBe(200);
  const savedUser = (await saved.json()).user;
  expect(savedUser.targetWaistInches).toBe(31.25);
  expect((await (await profile()).json()).user).toEqual({ ...before, targetWaistInches: 31.25 });
  await request('', { date: '2026-11-04', weightLbs: 165, waistInches: 32 });
  expect((await (await profile({})).json()).user).toEqual({ ...savedUser, currentWeightLbs: 165 });
  expect((await (await profile()).json()).user).toEqual({ ...before, currentWeightLbs: 165, targetWaistInches: 31.25 });
  const invalid = await profile({ targetWaistInches: '31.25' });
  expect(invalid.status).toBe(400);
  await profile({ firstName: 'Changed' });
  expect((await (await profile()).json()).user.targetWaistInches).toBe(31.25);
  await profile({ targetWaistInches: null });
  expect((await (await profile()).json()).user.targetWaistInches).toBeNull();
});

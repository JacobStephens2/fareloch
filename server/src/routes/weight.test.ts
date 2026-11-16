// @vitest-environment node
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../db.js';
import { signToken } from '../middleware/auth.js';
import weightRoutes from './weight.js';
import authRoutes from './auth.js';

process.env.JWT_SECRET = 'weight-test-secret';

let server: Server;
let base: string;
let token: string;
let otherToken: string;
const responseErrors: Error[] = [];

beforeAll(async () => {
  initDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/weight', weightRoutes);
  app.use('/api/auth', authRoutes);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    responseErrors.push(error);
    if (!res.headersSent) res.status(500).json({ error: 'Unexpected test server error' });
  });
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  base = `http://127.0.0.1:${address.port}/api/weight`;
});

beforeEach(() => {
  responseErrors.length = 0;
  getDb().exec('DELETE FROM weight_logs; DELETE FROM users;');
  const insertUser = getDb().prepare(
    'INSERT INTO users (email, password_hash, first_name) VALUES (?, ?, ?)'
  );
  const result = insertUser.run('waist@example.com', 'hash', 'Waist');
  token = signToken({ userId: Number(result.lastInsertRowid), email: 'waist@example.com', firstName: 'Waist' });
  const other = insertUser.run('other@example.com', 'hash', 'Other');
  otherToken = signToken({ userId: Number(other.lastInsertRowid), email: 'other@example.com', firstName: 'Other' });
});

afterEach(() => {
  getDb().exec('DROP TRIGGER IF EXISTS reject_weight_save');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  getDb().close();
});

async function request(path = '', body?: unknown, auth: string | null = token) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function profile(body?: unknown, auth = token) {
  return fetch(`${base.replace('/weight', '/auth/me')}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function storedState(auth = token) {
  const history = await request('', undefined, auth);
  const user = await profile(undefined, auth);
  expect(history.status).toBe(200);
  expect(user.status).toBe(200);
  return { logs: (await history.json()).logs, user: (await user.json()).user };
}

async function seedSaveScenario(replacement: boolean) {
  const entry = { date: '2026-11-04', time: '07:30', weightLbs: 166, waistInches: 31.2, notes: 'Updated reading' };
  await request('', { ...entry, weightLbs: 180, notes: 'Other caller' }, otherToken);
  await request('', { date: '2026-11-05', time: '08:30', weightLbs: 160, notes: 'Unrelated' });
  await request('', { date: '2026-11-05', weightLbs: 185 }, otherToken);
  await profile({ currentWeightLbs: 155, heightInches: 68, targetWaistInches: 32, targetCalories: 2400 });
  await profile({ heightInches: 72, targetWaistInches: 34, targetProteinG: 180 }, otherToken);
  const user = (await (await profile()).json()).user;
  if (replacement) {
    getDb().prepare(`
      INSERT INTO weight_logs (user_id, date, time, weight_lbs, waist_inches, notes, created_at)
      VALUES (?, ?, ?, 156, 30, 'Original reading', '2020-01-02 03:04:05')
    `).run(user.id, entry.date, entry.time);
  }
  return { entry, before: await storedState(), otherBefore: await storedState(otherToken) };
}

it.each([
  { operation: 'creation', replacement: false, fault: 'profile update', statement: 'BEFORE UPDATE OF current_weight_lbs ON users' },
  { operation: 'replacement', replacement: true, fault: 'profile update', statement: 'BEFORE UPDATE OF current_weight_lbs ON users' },
  { operation: 'creation', replacement: false, fault: 'reading insert', statement: 'AFTER INSERT ON weight_logs' },
  { operation: 'replacement', replacement: true, fault: 'reading update', statement: 'AFTER UPDATE ON weight_logs' },
])('rolls back $operation and reports only failure when the $fault fails', async ({ replacement, statement }) => {
  const { entry, before, otherBefore } = await seedSaveScenario(replacement);
  getDb().exec(`
    CREATE TRIGGER reject_weight_save ${statement}
    BEGIN SELECT RAISE(ABORT, 'injected weight save failure'); END;
  `);
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const response = await request('', entry);
  expect.soft(response.status).toBe(500);
  expect.soft(await response.json()).toEqual({ error: 'Failed to log weight' });
  expect.soft(await storedState()).toEqual(before);
  expect.soft(await storedState(otherToken)).toEqual(otherBefore);
  expect.soft(responseErrors).toEqual([]);

  getDb().exec('DROP TRIGGER reject_weight_save');
  const retry = await request('', entry);
  expect(retry.status).toBe(200);
  const log = (await retry.json()).log;
  expect(log).toMatchObject({
    user_id: before.user.id, date: '2026-11-04', time: '07:30', weight_lbs: 166,
    waist_inches: 31.2, notes: 'Updated reading',
  });
  if (replacement) expect(log).toMatchObject({ id: before.logs[1].id, created_at: '2020-01-02 03:04:05' });
  expect(await storedState()).toEqual({ logs: [before.logs[0], log], user: { ...before.user, currentWeightLbs: 166 } });
  expect(await storedState(otherToken)).toEqual(otherBefore);
  expect(responseErrors).toEqual([]);
});

it.each([
  { operation: 'creation', replacement: false },
  { operation: 'replacement', replacement: true },
])('commits backdated $operation with only the caller profile and matching reading changed', async ({ replacement }) => {
  const { entry, before, otherBefore } = await seedSaveScenario(replacement);
  const response = await request('', entry);
  expect(response.status).toBe(200);
  const log = (await response.json()).log;
  expect(log).toEqual({
    id: replacement ? before.logs[1].id : expect.any(Number),
    user_id: before.user.id, date: '2026-11-04', time: '07:30', weight_lbs: 166,
    waist_inches: 31.2, notes: 'Updated reading',
    created_at: replacement ? '2020-01-02 03:04:05' : expect.any(String),
  });
  expect(await storedState()).toEqual({ logs: [before.logs[0], log], user: { ...before.user, currentWeightLbs: 166 } });
  expect(await storedState(otherToken)).toEqual(otherBefore);
  expect(responseErrors).toEqual([]);
});

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

it.each([
  {},
  { time: null, waistInches: null, notes: null },
  { time: '', notes: '' },
  { time: 0, notes: 0 },
  { time: false, notes: false },
])('preserves creation and replacement defaults for %j', async (defaults) => {
  const entry = { date: '2026-11-04', weightLbs: 165, ...defaults };
  const created = await request('', entry);
  expect(created.status).toBe(200);
  const original = (await created.json()).log;
  expect(original).toMatchObject({ time: '', waist_inches: null, notes: null });

  await request('', { date: entry.date, time: '', weightLbs: 166, waistInches: 31, notes: 'Clear these' });
  const replaced = await request('', { ...entry, weightLbs: 167 });
  expect(replaced.status).toBe(200);
  const log = (await replaced.json()).log;
  expect(log).toEqual({ ...original, weight_lbs: 167 });
  const state = await storedState();
  expect(state.logs).toEqual([log]);
  expect(state.user.currentWeightLbs).toBe(167);
});

it('preserves accepted date and time strings and SQLite weight coercion', async () => {
  const response = await request('', { date: 'unparsed date', time: ' 07:30 ', weightLbs: '165.5' });
  expect(response.status).toBe(200);
  const log = (await response.json()).log;
  expect(log).toMatchObject({ date: 'unparsed date', time: ' 07:30 ', weight_lbs: 165.5 });
  const state = await storedState();
  expect(state.logs).toEqual([log]);
  expect(state.user.currentWeightLbs).toBe(165.5);
});

it.each([{}, { date: '2026-11-04' }, { weightLbs: 165 }, { date: '', weightLbs: 165 }, { date: '2026-11-04', weightLbs: 0 }])(
  'keeps required-date and weight validation for %j', async (body) => {
    const before = await storedState();
    const response = await request('', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Date and weight are required' });
    expect(await storedState()).toEqual(before);
  },
);

it('requires authentication before saving a reading', async () => {
  const before = await storedState();
  const entry = { date: '2026-11-04', weightLbs: 165 };
  const missing = await request('', entry, null);
  expect(missing.status).toBe(401);
  expect(await missing.json()).toEqual({ error: 'Not authenticated' });
  const invalid = await request('', entry, 'invalid-token');
  expect(invalid.status).toBe(401);
  expect(await invalid.json()).toEqual({ error: 'Invalid or expired token' });
  expect(await storedState()).toEqual(before);
});

it('keeps profile weight unchanged on deletion and scopes deletion to the caller', async () => {
  const { entry, otherBefore } = await seedSaveScenario(true);
  await request('', entry);
  const before = await storedState();
  const log = before.logs[1];
  const remove = (id: number) => fetch(`${base}/${id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  const denied = await remove(otherBefore.logs[1].id);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: 'Weight log not found' });
  expect(await storedState()).toEqual(before);
  const deleted = await remove(log.id);
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ success: true });
  expect(await storedState()).toEqual({ ...before, logs: [before.logs[0]] });
  expect(await storedState(otherToken)).toEqual(otherBefore);
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
  const before = await storedState();
  const response = await request('', { date: '2026-11-04', weightLbs: 165, waistInches });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Waist must be a number between 20 and 60 inches' });
  expect((await (await request()).json()).logs).toEqual([]);
  expect(await storedState()).toEqual(before);
});

it('saves, reads and clears a personal waist ceiling without changing macro targets', async () => {
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

// @vitest-environment node
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { getDb, initDb } from '../db.js';
import { signToken } from '../middleware/auth.js';
import dailyCheckRoutes from './daily-checks.js';

process.env.JWT_SECRET = 'daily-checks-test-secret';

let server: Server;
let base: string;
let tokens: string[];

beforeAll(async () => {
  initDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/daily-checks', dailyCheckRoutes);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  base = `http://127.0.0.1:${address.port}/api/daily-checks`;
});

beforeEach(() => {
  getDb().exec('DELETE FROM daily_checks; DELETE FROM users;');
  tokens = ['first@example.com', 'second@example.com'].map(email => {
    const result = getDb().prepare(
      'INSERT INTO users (email, password_hash, first_name) VALUES (?, ?, ?)'
    ).run(email, 'hash', 'Habits');
    return signToken({ userId: Number(result.lastInsertRowid), email, firstName: 'Habits' });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  getDb().close();
});

async function request(date: string, body?: unknown, token = tokens[0]) {
  return fetch(`${base}/${date}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it('persists independent, idempotent checks per user and date', async () => {
  const read = async (date: string, token?: string) => (await request(date, undefined, token)).json();
  expect(await read('2026-11-04')).toEqual({ checks: [] });
  expect((await request('2026-11-04', { key: 'creatine', checked: true })).status).toBe(200);
  await request('2026-11-04', { key: 'creatine', checked: true });
  expect(await read('2026-11-04')).toEqual({ checks: ['creatine'] });
  expect(await read('2026-11-03')).toEqual({ checks: [] });
  expect(await read('2026-11-04', tokens[1])).toEqual({ checks: [] });
  await request('2026-11-03', { key: 'carotenoids', checked: true });
  await request('2026-11-04', { key: 'carotenoids', checked: true }, tokens[1]);
  await request('2026-11-04', { key: 'carotenoids', checked: true });
  await request('2026-11-04', { key: 'creatine', checked: false });
  await request('2026-11-04', { key: 'creatine', checked: false });
  expect(await read('2026-11-04')).toEqual({ checks: ['carotenoids'] });
  expect(await read('2026-11-03')).toEqual({ checks: ['carotenoids'] });
  expect(await read('2026-11-04', tokens[1])).toEqual({ checks: ['carotenoids'] });
});

it.each([
  { key: 'unknown', checked: true },
  { key: '', checked: true },
  { key: 'x'.repeat(200), checked: true },
  { key: 1, checked: true },
  { key: 'creatine', checked: 'false' },
  { key: 'creatine', checked: 0 },
  { key: 'creatine' },
  {},
  null,
])('rejects invalid check input %j without changing saved checks', async body => {
  await request('2026-11-04', { key: 'carotenoids', checked: true });
  expect((await request('2026-11-04', body)).status).toBe(400);
  expect(await (await request('2026-11-04')).json()).toEqual({ checks: ['carotenoids'] });
});

it('requires authentication to read or change checks', async () => {
  expect((await fetch(`${base}/2026-11-04`)).status).toBe(401);
  expect((await fetch(`${base}/2026-11-04`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'creatine', checked: true }),
  })).status).toBe(401);
});

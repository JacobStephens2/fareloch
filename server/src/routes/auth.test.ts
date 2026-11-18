// @vitest-environment node
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../db.js';
import { signToken } from '../middleware/auth.js';
import authRoutes from './auth.js';

const { sendMail } = vi.hoisted(() => ({
  sendMail: vi.fn<(message: { html?: string }) => Promise<object>>().mockResolvedValue({}),
}));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

let server: Server;
let base: string;
let passwordHash: string;
let userId: number;
let otherId: number;
let token: string;
let otherToken: string;
const password = 'profile-test-password';
const defaults = {
  heightInches: 71, currentWeightLbs: 155, targetWaistInches: null,
  targetCalories: 2590, targetCarbsG: 340, targetProteinG: 150, targetFatG: 70,
  workoutTargetCalories: 2890, workoutTargetCarbsG: 380, workoutTargetProteinG: 170, workoutTargetFatG: 80,
};

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'profile-test-secret');
  initDb(':memory:');
  passwordHash = await bcrypt.hash(password, 4);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  base = `http://127.0.0.1:${address.port}/api/auth`;
});

beforeEach(() => {
  getDb().exec('DELETE FROM email_verification_tokens; DELETE FROM password_reset_tokens; DELETE FROM users;');
  const insert = getDb().prepare(`
    INSERT INTO users (email, password_hash, first_name, height_inches, current_weight_lbs)
    VALUES (?, ?, ?, 71, 155)
  `);
  userId = Number(insert.run('person@example.com', passwordHash, 'Person').lastInsertRowid);
  otherId = Number(insert.run('other@example.com', passwordHash, 'Other').lastInsertRowid);
  token = signToken({ userId, email: 'person@example.com', firstName: 'Person' });
  otherToken = signToken({ userId: otherId, email: 'other@example.com', firstName: 'Other' });
});

afterEach(() => {
  getDb().exec('DROP TRIGGER IF EXISTS reject_profile_update');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  getDb().close();
  vi.unstubAllEnvs();
});

async function request(method: string, path: string, body?: unknown, auth: string | null = token) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function profile(body?: unknown, auth: string | null = token) {
  const response = await request(body === undefined ? 'GET' : 'PUT', '/me', body, auth);
  expect(response.status).toBe(200);
  return response.json();
}

it('retains the complete saved Profile across current-user reads and login', async () => {
  const saved = await profile({
    firstName: 'Updated', heightInches: 68, currentWeightLbs: 166, targetWaistInches: 32,
    targetCalories: 2400, targetCarbsG: 300, targetProteinG: 160, targetFatG: 65,
    workoutTargetCalories: 3100, workoutTargetCarbsG: 400, workoutTargetProteinG: 180, workoutTargetFatG: 90,
  });
  expect(saved).toEqual({ user: {
    id: userId, email: 'person@example.com', firstName: 'Updated', emailVerified: false,
    heightInches: 68, currentWeightLbs: 166, targetWaistInches: 32,
    targetCalories: 2400, targetCarbsG: 300, targetProteinG: 160, targetFatG: 65,
    workoutTargetCalories: 3100, workoutTargetCarbsG: 400, workoutTargetProteinG: 180, workoutTargetFatG: 90,
  } });
  expect(await profile()).toEqual(saved);
  const login = await request('POST', '/login', { email: ' PERSON@example.com ', password }, null);
  expect(login.status).toBe(200);
  const signedIn = await login.json();
  expect(signedIn).toEqual({ ...saved, token: expect.any(String) });
  expect(await profile(undefined, signedIn.token)).toEqual(saved);
});

it('registers the persisted normalized Profile with all defaults and keeps verification and cookie auth', async () => {
  const response = await request('POST', '/register', {
    email: ' NEW@example.com ', firstName: '  New Person  ', password,
  }, null);
  expect(response.status).toBe(200);
  const registered = await response.json();
  expect(registered).toEqual({ user: {
    id: expect.any(Number), email: 'new@example.com', firstName: 'New Person', emailVerified: false,
    ...defaults,
  }, token: expect.any(String) });
  expect(await profile(undefined, registered.token)).toEqual({ user: registered.user });

  const cookie = response.headers.get('set-cookie');
  expect(cookie).toContain(`token=${registered.token};`);
  expect(cookie).toContain('Max-Age=2592000');
  expect(cookie).toContain('Path=/');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');
  const current = await fetch(`${base}/me`, { headers: { Cookie: cookie!.split(';')[0] } });
  expect(current.status).toBe(200);
  expect(await current.json()).toEqual({ user: registered.user });

  const login = await request('POST', '/login', { email: 'new@example.com', password }, null);
  expect(login.status).toBe(200);
  const signedIn = await login.json();
  expect(signedIn).toEqual({ user: registered.user, token: expect.any(String) });
  expect(login.headers.get('set-cookie')).toContain(`token=${signedIn.token};`);

  const verificationMail = sendMail.mock.calls.find(([message]) => message.html)?.[0].html;
  const verificationToken = verificationMail?.match(/verify-email\?token=([a-f0-9]+)/)?.[1];
  expect(verificationToken).toBeTruthy();
  const verified = await request('POST', '/verify-email', { token: verificationToken }, null);
  expect(verified.status).toBe(200);
  expect(await verified.json()).toEqual({ success: true });
  expect(await profile(undefined, registered.token)).toEqual({ user: { ...registered.user, emailVerified: true } });
});

it('preserves omitted and null ordinary fields, clears only an explicit null waist, and writes zero and empty name', async () => {
  const saved = await profile({
    firstName: 'Saved', heightInches: 69, currentWeightLbs: 165, targetWaistInches: 33,
    targetCalories: 2300, targetCarbsG: 290, targetProteinG: 155, targetFatG: 60,
    workoutTargetCalories: 3000, workoutTargetCarbsG: 390, workoutTargetProteinG: 175, workoutTargetFatG: 85,
  });
  expect(await profile({})).toEqual(saved);
  const ordinaryNulls = {
    firstName: null, heightInches: null, currentWeightLbs: null,
    targetCalories: null, targetCarbsG: null, targetProteinG: null, targetFatG: null,
    workoutTargetCalories: null, workoutTargetCarbsG: null, workoutTargetProteinG: null, workoutTargetFatG: null,
  };
  expect(await profile(ordinaryNulls)).toEqual(saved);
  const cleared = { user: { ...saved.user, targetWaistInches: null } };
  expect(await profile({ ...ordinaryNulls, targetWaistInches: null })).toEqual(cleared);
  expect(await profile()).toEqual(cleared);

  const zeros = {
    firstName: '', heightInches: 0, currentWeightLbs: 0,
    targetCalories: 0, targetCarbsG: 0, targetProteinG: 0, targetFatG: 0,
    workoutTargetCalories: 0, workoutTargetCarbsG: 0, workoutTargetProteinG: 0, workoutTargetFatG: 0,
  };
  const zeroProfile = { user: { ...cleared.user, ...zeros } };
  expect(await profile(zeros)).toEqual(zeroProfile);
  expect(await profile()).toEqual(zeroProfile);
  expect(await profile(ordinaryNulls)).toEqual(zeroProfile);
});

it.each([null, 0, 2, -1])('preserves stored nulls and converts verification value %j across reads, updates and login', async (verified) => {
  getDb().prepare(`
    UPDATE users SET email_verified = ?, height_inches = NULL, current_weight_lbs = NULL,
      target_waist_inches = NULL, target_calories = NULL, target_carbs_g = NULL,
      target_protein_g = NULL, target_fat_g = NULL, workout_target_calories = NULL,
      workout_target_carbs_g = NULL, workout_target_protein_g = NULL, workout_target_fat_g = NULL
    WHERE id = ?
  `).run(verified, userId);
  const expected = { user: {
    id: userId, email: 'person@example.com', firstName: 'Person', emailVerified: verified === 2 || verified === -1,
    heightInches: null, currentWeightLbs: null, targetWaistInches: null,
    targetCalories: null, targetCarbsG: null, targetProteinG: null, targetFatG: null,
    workoutTargetCalories: null, workoutTargetCarbsG: null, workoutTargetProteinG: null, workoutTargetFatG: null,
  } };
  expect(await profile()).toEqual(expected);
  expect(await profile({})).toEqual(expected);
  const login = await request('POST', '/login', { email: 'person@example.com', password }, null);
  expect(login.status).toBe(200);
  expect(await login.json()).toEqual({ ...expected, token: expect.any(String) });
});

it.each([20, 32.5, 60])('saves the valid waist ceiling %j', async (targetWaistInches) => {
  const before = await profile();
  const expected = { user: { ...before.user, targetWaistInches } };
  expect(await profile({ targetWaistInches })).toEqual(expected);
  expect(await profile()).toEqual(expected);
});

it.each([0, 19.9, 60.1, '32', '', false, [], {}])('rejects invalid waist %j before any Profile field changes', async (targetWaistInches) => {
  const before = await profile({ targetWaistInches: 33 });
  const otherBefore = await profile(undefined, otherToken);
  const response = await request('PUT', '/me', {
    firstName: 'Rejected', heightInches: 60, currentWeightLbs: 199, targetWaistInches,
    targetCalories: 1, targetCarbsG: 2, targetProteinG: 3, targetFatG: 4,
    workoutTargetCalories: 5, workoutTargetCarbsG: 6, workoutTargetProteinG: 7, workoutTargetFatG: 8,
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Waist ceiling must be a number between 20 and 60 inches' });
  expect(await profile()).toEqual(before);
  expect(await profile(undefined, otherToken)).toEqual(otherBefore);
});

it('uses authenticated identity and ignores credentials, protected fields, stored names and unknown fields', async () => {
  const before = await profile();
  const otherBefore = await profile(undefined, otherToken);
  const expected = { user: { ...before.user, firstName: 'Allowed', targetCalories: 2200 } };
  expect(await profile({
    id: otherId, userId: otherId, user_id: otherId,
    email: 'other@example.com', emailVerified: true, email_verified: 1,
    password: 'injected-password', passwordHash: 'injected-hash', password_hash: 'injected-hash',
    first_name: 'Injected', height_inches: 80, workout_target_calories: 9999,
    created_at: 'injected', token: 'injected', admin: true, unknown: 'injected',
    firstName: 'Allowed', targetCalories: 2200,
  })).toEqual(expected);
  expect(await profile()).toEqual(expected);
  expect(await profile(undefined, otherToken)).toEqual(otherBefore);
  const spoofedRead = await request('GET', `/me?id=${otherId}&userId=${otherId}&email=other@example.com`);
  expect(spoofedRead.status).toBe(200);
  expect(await spoofedRead.json()).toEqual(expected);

  const login = await request('POST', '/login', { email: 'person@example.com', password }, null);
  expect(login.status).toBe(200);
  expect(await login.json()).toEqual({ ...expected, token: expect.any(String) });
  const otherLogin = await request('POST', '/login', { email: 'other@example.com', password }, null);
  expect(otherLogin.status).toBe(200);
  expect(await otherLogin.json()).toEqual({ ...otherBefore, token: expect.any(String) });
  const rejected = await request('POST', '/login', { email: 'person@example.com', password: 'injected-password' }, null);
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toEqual({ error: 'Invalid email or password' });
});

it.each(['GET', 'PUT'])('preserves %s authentication checks before reading or writing a Profile', async (method) => {
  const before = await profile();
  for (const [auth, error] of [[null, 'Not authenticated'], ['invalid-token', 'Invalid or expired token']]) {
    const response = await request(method, '/me', method === 'PUT' ? { firstName: 'Rejected' } : undefined, auth);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error });
  }
  expect(await profile()).toEqual(before);
});

it('keeps missing current-user reads at 404 and missing Profile updates at the generic 500', async () => {
  const otherBefore = await profile(undefined, otherToken);
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
  const read = await request('GET', '/me');
  expect(read.status).toBe(404);
  expect(await read.json()).toEqual({ error: 'User not found' });
  const update = await request('PUT', '/me', { firstName: 'Missing', targetCalories: 2000 });
  expect(update.status).toBe(500);
  expect(await update.json()).toEqual({ error: 'Update failed' });
  expect(await profile(undefined, otherToken)).toEqual(otherBefore);
});

it('keeps unexpected database update errors at the generic 500 without publishing a Profile', async () => {
  const before = await profile();
  getDb().exec(`
    CREATE TRIGGER reject_profile_update BEFORE UPDATE ON users
    BEGIN SELECT RAISE(ABORT, 'injected profile update failure'); END;
  `);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request('PUT', '/me', { firstName: 'Rejected', workoutTargetCalories: 3100 });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Update failed' });
  expect(await profile()).toEqual(before);
});

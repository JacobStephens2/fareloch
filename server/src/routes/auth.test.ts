// @vitest-environment node
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import express from 'express';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { MailMessage } from '../account-auth.js';
import { getDb, initDb } from '../db.js';
import { signToken } from '../middleware/auth.js';
import { createAuthRouter } from './auth.js';

const sentMail: MailMessage[] = [];
let sendMailError: Error | null = null;
async function sendMail(message: MailMessage) {
  if (sendMailError) throw sendMailError;
  sentMail.push(message);
  return {};
}

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
  app.use('/api/auth', createAuthRouter({ db: getDb, sendMail }));
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  base = `http://127.0.0.1:${address.port}/api/auth`;
});

beforeEach(() => {
  sentMail.length = 0;
  sendMailError = null;
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
  getDb().exec(`
    DROP TRIGGER IF EXISTS reject_profile_update;
    DROP TRIGGER IF EXISTS reject_verify_delete;
    DROP TRIGGER IF EXISTS reject_verify_insert;
    DROP TRIGGER IF EXISTS reject_reset_mark_used;
  `);
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

  const verificationMail = sentMail.find((message) => message.html)?.html;
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

it('rejects case-variant duplicate email registration with 409', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request('POST', '/register', {
    email: '  Person@example.com  ',
    password,
    firstName: 'Duplicate',
  }, null);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'An account with this email already exists' });
});

it('escapes HTML special characters in firstName in verification emails', async () => {
  sentMail.length = 0;
  const response = await request('POST', '/register', {
    email: 'xss@example.com',
    password,
    firstName: `<A & "B" 'C'>`,
  }, null);
  expect(response.status).toBe(200);
  const verificationHtml = sentMail.find((message) => message.html)?.html;
  expect(verificationHtml).toContain('&lt;A &amp; &quot;B&quot; &#39;C&#39;&gt;');
  expect(verificationHtml).not.toContain('<A &');
});

it('rejects same-UTC-day expired verification and reset tokens', async () => {
  const expiredSameDay = new Date(Date.now() - 60_000).toISOString();
  getDb().prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(userId, 'expired-verify-token', expiredSameDay);
  getDb().prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(userId, 'expired-reset-token', expiredSameDay);

  const verify = await request('POST', '/verify-email', { token: 'expired-verify-token' }, null);
  expect(verify.status).toBe(400);
  expect(await verify.json()).toEqual({ error: 'Invalid or expired token' });

  const reset = await request('POST', '/reset-password', { token: 'expired-reset-token', password: 'new-password-123' }, null);
  expect(reset.status).toBe(400);
  expect(await reset.json()).toEqual({ error: 'Invalid or expired reset token' });
});

it('allows at most one concurrent password reset for the same token', async () => {
  getDb().prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(userId, 'race-reset-token', new Date(Date.now() + 60 * 60 * 1000).toISOString());

  const [first, second] = await Promise.all([
    request('POST', '/reset-password', { token: 'race-reset-token', password: 'first-new-password' }, null),
    request('POST', '/reset-password', { token: 'race-reset-token', password: 'second-new-password' }, null),
  ]);
  expect([first.status, second.status].sort()).toEqual([200, 400]);
});

it('returns 404 when the authenticated account is missing on change-password or resend-verification', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);

  const change = await request('POST', '/change-password', {
    currentPassword: password,
    newPassword: 'updated-password',
  });
  expect(change.status).toBe(404);
  expect(await change.json()).toEqual({ error: 'User not found' });

  const resend = await request('POST', '/resend-verification');
  expect(resend.status).toBe(404);
  expect(await resend.json()).toEqual({ error: 'User not found' });
});

it('matches login cookie Secure policy when clearing the token cookie on logout', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'test';
    const devLogin = await request('POST', '/login', { email: 'person@example.com', password }, null);
    const devLogout = await request('POST', '/logout', undefined, null);
    const devLoginCookie = devLogin.headers.get('set-cookie')!;
    const devLogoutCookie = devLogout.headers.get('set-cookie')!;
    expect(devLoginCookie).not.toContain('Secure');
    expect(devLogoutCookie).not.toContain('Secure');
    expect(devLogoutCookie).toContain('HttpOnly');
    expect(devLogoutCookie).toContain('SameSite=Strict');
    expect(devLogoutCookie).toContain('Path=/');
    expect(devLogoutCookie).toContain('Max-Age=0');

    process.env.NODE_ENV = 'production';
    const prodLogin = await request('POST', '/login', { email: 'person@example.com', password }, null);
    const prodLogout = await request('POST', '/logout', undefined, null);
    expect(prodLogin.headers.get('set-cookie')).toContain('Secure');
    expect(prodLogout.headers.get('set-cookie')).toContain('Secure');
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
  }
});

it('returns JSON 500 when email verification fails unexpectedly in the database', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  getDb().prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(userId, 'failing-verify-token', new Date(Date.now() + 60 * 60 * 1000).toISOString());
  getDb().exec(`
    CREATE TRIGGER reject_verify_delete BEFORE DELETE ON email_verification_tokens
    BEGIN SELECT RAISE(ABORT, 'injected verify failure'); END;
  `);

  const response = await request('POST', '/verify-email', { token: 'failing-verify-token' }, null);
  expect(response.status).toBe(500);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ error: 'Email verification failed' });
});

it('handles /change-password validation, incorrect current password, body spoofing, auth checks, and success', async () => {
  const unauth = await request('POST', '/change-password', { currentPassword: password, newPassword: 'new-password-1' }, null);
  expect(unauth.status).toBe(401);

  const missing = await request('POST', '/change-password', {});
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'Current and new password are required' });

  const short = await request('POST', '/change-password', { currentPassword: password, newPassword: 'short' });
  expect(short.status).toBe(400);
  expect(await short.json()).toEqual({ error: 'Password must be at least 8 characters' });

  const wrong = await request('POST', '/change-password', { currentPassword: 'wrong-password', newPassword: 'new-password-1' });
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: 'Current password is incorrect' });

  const changed = await request('POST', '/change-password', {
    userId: otherId,
    id: otherId,
    currentPassword: password,
    newPassword: 'new-password-1',
  });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({ success: true });

  expect((await request('POST', '/login', { email: 'person@example.com', password: 'new-password-1' }, null)).status).toBe(200);
  expect((await request('POST', '/login', { email: 'other@example.com', password }, null)).status).toBe(200);
});

it('handles /resend-verification for unverified, verified, unauthenticated, and mail failure cases', async () => {
  const unauth = await request('POST', '/resend-verification', undefined, null);
  expect(unauth.status).toBe(401);

  const resent = await request('POST', '/resend-verification');
  expect(resent.status).toBe(200);
  expect(await resent.json()).toEqual({ success: true });
  expect(sentMail).toHaveLength(1);
  const resendToken = sentMail[0].html?.match(/verify-email\?token=([a-f0-9]+)/)?.[1];
  expect(resendToken).toBeTruthy();

  vi.spyOn(console, 'error').mockImplementation(() => {});
  sendMailError = new Error('smtp unreachable');
  const failed = await request('POST', '/resend-verification');
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: 'Failed to resend' });
  sendMailError = null;

  const latestToken = (getDb().prepare('SELECT token FROM email_verification_tokens WHERE user_id = ?').get(userId) as { token: string }).token;
  expect((await request('POST', '/verify-email', { token: latestToken }, null)).status).toBe(200);

  sentMail.length = 0;
  const already = await request('POST', '/resend-verification');
  expect(already.status).toBe(200);
  expect(await already.json()).toEqual({ success: true, message: 'Already verified' });
  expect(sentMail).toHaveLength(0);
});

it('handles /forgot-password and /reset-password flows including mail failure and registration non-failure on mail error', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const missingEmail = await request('POST', '/forgot-password', {}, null);
  expect(missingEmail.status).toBe(400);
  expect(await missingEmail.json()).toEqual({ error: 'Email is required' });

  const unknownEmail = await request('POST', '/forgot-password', { email: 'missing@example.com' }, null);
  expect(unknownEmail.status).toBe(200);
  expect(await unknownEmail.json()).toEqual({ success: true });
  expect(sentMail).toHaveLength(0);

  sendMailError = new Error('smtp timeout');
  const forgotFailed = await request('POST', '/forgot-password', { email: 'person@example.com' }, null);
  expect(forgotFailed.status).toBe(500);
  expect(await forgotFailed.json()).toEqual({ error: 'Request failed' });

  const regDespiteMailFail = await request('POST', '/register', {
    email: 'still-ok@example.com',
    password,
    firstName: 'StillOk',
  }, null);
  expect(regDespiteMailFail.status).toBe(200);
  sendMailError = null;

  const forgotOk = await request('POST', '/forgot-password', { email: '  PERSON@example.com ' }, null);
  expect(forgotOk.status).toBe(200);
  expect(await forgotOk.json()).toEqual({ success: true });
  expect(sentMail).toHaveLength(1);
  const resetToken = sentMail[0].html?.match(/reset-password\?token=([a-f0-9]+)/)?.[1];
  expect(resetToken).toBeTruthy();

  const missingResetFields = await request('POST', '/reset-password', {}, null);
  expect(missingResetFields.status).toBe(400);
  expect(await missingResetFields.json()).toEqual({ error: 'Token and password are required' });

  const shortResetPassword = await request('POST', '/reset-password', { token: resetToken, password: 'short' }, null);
  expect(shortResetPassword.status).toBe(400);
  expect(await shortResetPassword.json()).toEqual({ error: 'Password must be at least 8 characters' });

  const resetOk = await request('POST', '/reset-password', { token: resetToken, password: 'reset-password-1' }, null);
  expect(resetOk.status).toBe(200);
  expect(await resetOk.json()).toEqual({ success: true });
  expect((await request('POST', '/login', { email: 'person@example.com', password: 'reset-password-1' }, null)).status).toBe(200);

  const reuseToken = await request('POST', '/reset-password', { token: resetToken, password: 'reset-password-2' }, null);
  expect(reuseToken.status).toBe(400);
  expect(await reuseToken.json()).toEqual({ error: 'Invalid or expired reset token' });
});

it('lazily initializes and reuses one mail transport per router while reading APP_URL and SMTP_FROM dynamically', async () => {
  const delivered: MailMessage[] = [];
  const createTransportSpy = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
    sendMail: async (message: MailMessage) => {
      delivered.push(message);
      return {};
    },
  } as unknown as nodemailer.Transporter);

  const lazyRouter = createAuthRouter();
  expect(createTransportSpy).not.toHaveBeenCalled();

  const lazyApp = express();
  lazyApp.use(express.json());
  lazyApp.use('/api/auth', lazyRouter);
  const lazyServer = createServer(lazyApp);
  lazyServer.listen(0, '127.0.0.1');
  await once(lazyServer, 'listening');

  const prevEnv = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM,
    APP_URL: process.env.APP_URL,
  };

  try {
    const addr = lazyServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected a TCP port');
    const lazyBase = `http://127.0.0.1:${addr.port}/api/auth`;

    process.env.SMTP_HOST = 'smtp.runtime.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_USER = 'mailer';
    process.env.SMTP_PASS = 'secret';
    process.env.SMTP_FROM = 'first@runtime.test';
    process.env.APP_URL = 'https://first.runtime.test';

    const first = await fetch(`${lazyBase}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com' }),
    });
    expect(first.status).toBe(200);
    expect(createTransportSpy).toHaveBeenCalledTimes(1);
    expect(createTransportSpy).toHaveBeenCalledWith({
      host: 'smtp.runtime.test',
      port: 587,
      secure: true,
      auth: { user: 'mailer', pass: 'secret' },
    });

    process.env.SMTP_FROM = 'second@runtime.test';
    process.env.APP_URL = 'https://second.runtime.test';

    const second = await fetch(`${lazyBase}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other@example.com' }),
    });
    expect(second.status).toBe(200);
    expect(createTransportSpy).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(2);
    expect(delivered[0].from).toBe('first@runtime.test');
    expect(delivered[0].html).toContain('https://first.runtime.test/#/reset-password?token=');
    expect(delivered[1].from).toBe('second@runtime.test');
    expect(delivered[1].html).toContain('https://second.runtime.test/#/reset-password?token=');
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => lazyServer.close((err) => (err ? reject(err) : resolve())));
  }
});

// @vitest-environment node
import bcrypt from 'bcrypt';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createAccountAuth, type MailMessage } from './account-auth.js';
import { initDb } from './db.js';

let db: Database.Database;
let sentMail: MailMessage[];
let currentNow: Date;

beforeAll(() => {
  db = initDb(':memory:');
});

beforeEach(() => {
  sentMail = [];
  currentNow = new Date('2026-11-19T07:12:23.000Z');
  db.exec(`
    DROP TRIGGER IF EXISTS reject_verify_insert;
    DROP TRIGGER IF EXISTS reject_verify_delete;
    DROP TRIGGER IF EXISTS reject_user_update;
    DROP TRIGGER IF EXISTS reject_reset_update;
    DELETE FROM email_verification_tokens;
    DELETE FROM password_reset_tokens;
    DELETE FROM users;
  `);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

function makeAuth(overrides: Partial<Parameters<typeof createAccountAuth>[0]> = {}) {
  return createAccountAuth({
    db,
    sendMail: async (message) => {
      sentMail.push(message);
    },
    signToken: (payload) => `token:${payload.userId}:${payload.email}:${payload.firstName}`,
    bcryptRounds: 4,
    now: () => currentNow,
    ...overrides,
  });
}

it('registers a normalized account, commits verification token atomically, escapes email HTML, and reports mail errors without failing', async () => {
  const mailErrors: Array<{ kind: string; error: unknown }> = [];
  const auth = makeAuth({
    db: () => db,
    appUrl: 'https://test.fareloch.app',
    smtpFrom: 'auth@test.fareloch.app',
    adminNotifyEmail: 'admin@test.fareloch.app',
    onMailError: (kind, error) => {
      mailErrors.push({ kind, error });
    },
  });

  const longUa = 'Agent/'.padEnd(1100, 'x');
  const registered = await auth.register(
    { email: '  Alice@Example.COM ', password: 'password123', firstName: `  <Alice> & "Bob" 'C'  ` },
    longUa,
  );
  expect(registered.kind).toBe('registered');
  if (registered.kind !== 'registered') throw new Error('Expected registered');

  expect(registered.user).toEqual({
    id: expect.any(Number),
    email: 'alice@example.com',
    firstName: `<Alice> & "Bob" 'C'`,
    emailVerified: false,
    heightInches: 71,
    currentWeightLbs: 155,
    targetWaistInches: null,
    targetCalories: 2590,
    targetCarbsG: 340,
    targetProteinG: 150,
    targetFatG: 70,
    workoutTargetCalories: 2890,
    workoutTargetCarbsG: 380,
    workoutTargetProteinG: 170,
    workoutTargetFatG: 80,
  });
  expect(registered.token).toBe(`token:${registered.user.id}:alice@example.com:<Alice> & "Bob" 'C'`);

  expect(sentMail).toHaveLength(2);
  expect(sentMail[0]).toMatchObject({
    from: 'auth@test.fareloch.app',
    to: 'alice@example.com',
    subject: 'Verify your Fareloch account',
  });
  expect(sentMail[0].html).toContain('Hi &lt;Alice&gt; &amp; &quot;Bob&quot; &#39;C&#39;,');
  expect(sentMail[0].html).toContain('https://test.fareloch.app/#/verify-email?token=');
  expect(sentMail[1]).toEqual({
    from: 'auth@test.fareloch.app',
    to: 'admin@test.fareloch.app',
    subject: 'Fareloch — New Account Created',
    text: expect.stringContaining(`Device: ${longUa.slice(0, 1024)}`),
  });
  expect(sentMail[1].text).toContain('Date: 2026-11-19T07:12:23.000Z');
  expect(sentMail[1].text?.endsWith(longUa.slice(0, 1024))).toBe(true);

  const duplicate = await auth.register({
    email: 'ALICE@example.com',
    password: 'password123',
    firstName: 'Another',
  });
  expect(duplicate).toEqual({ kind: 'email-taken' });

  const [c1, c2] = await Promise.all([
    auth.register({ email: 'race@example.com', password: 'password123', firstName: 'Race1' }),
    auth.register({ email: 'RACE@example.com', password: 'password123', firstName: 'Race2' }),
  ]);
  expect([c1.kind, c2.kind].sort()).toEqual(['email-taken', 'registered']);

  const failingMailAuth = makeAuth({
    sendMail: async () => {
      throw new Error('smtp down');
    },
    onMailError: (kind, error) => {
      mailErrors.push({ kind, error });
    },
  });
  const okDespiteMailFailure = await failingMailAuth.register({
    email: 'mailfail@example.com',
    password: 'password123',
    firstName: 'MailFail',
  });
  expect(okDespiteMailFailure.kind).toBe('registered');
  expect(mailErrors.map((entry) => entry.kind)).toEqual(['verification', 'admin-notification']);
  expect(await bcrypt.compare('password123', (db.prepare('SELECT password_hash FROM users WHERE email = ?').get('mailfail@example.com') as { password_hash: string }).password_hash)).toBe(true);

  db.exec(`
    CREATE TRIGGER reject_verify_insert BEFORE INSERT ON email_verification_tokens
    BEGIN SELECT RAISE(ABORT, 'token insert failed'); END;
  `);
  await expect(auth.register({ email: 'rollback@example.com', password: 'password123', firstName: 'Roll' }))
    .rejects.toThrow('token insert failed');
  expect(db.inTransaction).toBe(false);
  expect(db.prepare('SELECT id FROM users WHERE email = ?').get('rollback@example.com')).toBeUndefined();
});

it('logs in with normalized email, returns readProfile and signed token, and rejects invalid inputs or credentials', async () => {
  const auth = makeAuth();
  const registered = await auth.register({
    email: 'Login@Example.com',
    password: 'password123',
    firstName: 'LoginUser',
  });
  if (registered.kind !== 'registered') throw new Error('Expected registered');

  expect(await auth.login(null)).toEqual({ kind: 'invalid-input', error: 'Email and password are required' });
  expect(await auth.login({ email: '   ', password: 'password123' })).toEqual({
    kind: 'invalid-input',
    error: 'Email and password are required',
  });
  expect(await auth.login({ email: 'login@example.com', password: 12345678 })).toEqual({
    kind: 'invalid-input',
    error: 'Email and password are required',
  });
  expect(await auth.login({ email: 'missing@example.com', password: 'password123' })).toEqual({
    kind: 'invalid-credentials',
  });
  expect(await auth.login({ email: 'login@example.com', password: 'wrong-password' })).toEqual({
    kind: 'invalid-credentials',
  });

  const loggedIn = await auth.login({ email: '  LOGIN@example.com  ', password: 'password123' });
  expect(loggedIn).toEqual({
    kind: 'logged-in',
    user: registered.user,
    token: `token:${registered.user.id}:login@example.com:LoginUser`,
  });
});

it('changes password for explicit userId only, checks current password and missing users, and validates untrusted input', async () => {
  const auth = makeAuth();
  const alice = await auth.register({ email: 'alice@example.com', password: 'password123', firstName: 'Alice' });
  const bob = await auth.register({ email: 'bob@example.com', password: 'bob-password', firstName: 'Bob' });
  if (alice.kind !== 'registered' || bob.kind !== 'registered') throw new Error('Expected registered');

  expect(await auth.changePassword(alice.user.id, {})).toEqual({
    kind: 'invalid-input',
    error: 'Current and new password are required',
  });
  expect(await auth.changePassword(alice.user.id, {
    currentPassword: 'password123',
    newPassword: 'short',
  })).toEqual({
    kind: 'invalid-input',
    error: 'Password must be at least 8 characters',
  });
  expect(await auth.changePassword(999999, {
    userId: alice.user.id,
    id: alice.user.id,
    currentPassword: 'password123',
    newPassword: 'new-password-1',
  })).toEqual({ kind: 'user-not-found' });
  expect(await auth.changePassword(alice.user.id, {
    currentPassword: 'wrong-password',
    newPassword: 'new-password-1',
  })).toEqual({ kind: 'incorrect-password' });

  const changed = await auth.changePassword(alice.user.id, {
    userId: bob.user.id,
    id: bob.user.id,
    user_id: bob.user.id,
    email: 'bob@example.com',
    currentPassword: 'password123',
    newPassword: 'new-password-1',
  });
  expect(changed).toEqual({ kind: 'changed' });
  expect((await auth.login({ email: 'alice@example.com', password: 'new-password-1' })).kind).toBe('logged-in');
  expect((await auth.login({ email: 'bob@example.com', password: 'bob-password' })).kind).toBe('logged-in');
});

it('verifies email across ISO and SQLite timestamps, enforces same-UTC-day expiry, and rolls back on delete abort', async () => {
  const auth = makeAuth();
  const registered = await auth.register({ email: 'verify@example.com', password: 'password123', firstName: 'Verify' });
  if (registered.kind !== 'registered') throw new Error('Expected registered');

  expect(auth.verifyEmail({})).toEqual({ kind: 'invalid-input', error: 'Token is required' });
  expect(auth.verifyEmail({ token: 123 })).toEqual({ kind: 'invalid-input', error: 'Token is required' });
  expect(auth.verifyEmail({ token: 'unknown-token' })).toEqual({ kind: 'invalid-token' });

  db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(registered.user.id, 'iso-expired-same-day', '2026-11-19T07:11:23.668Z');
  db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(registered.user.id, 'sqlite-expired-same-day', '2026-11-19 07:11:23');
  db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(registered.user.id, 'sqlite-valid', '2026-11-19 07:13:23');

  expect(auth.verifyEmail({ token: 'iso-expired-same-day' })).toEqual({ kind: 'invalid-token' });
  expect(auth.verifyEmail({ token: 'sqlite-expired-same-day' })).toEqual({ kind: 'invalid-token' });

  db.exec(`
    CREATE TRIGGER reject_verify_delete BEFORE DELETE ON email_verification_tokens
    BEGIN SELECT RAISE(ABORT, 'delete aborted'); END;
  `);
  expect(() => auth.verifyEmail({ token: 'sqlite-valid' })).toThrow('delete aborted');
  expect(db.inTransaction).toBe(false);
  expect((db.prepare('SELECT email_verified FROM users WHERE id = ?').get(registered.user.id) as { email_verified: number }).email_verified).toBe(0);
  db.exec('DROP TRIGGER reject_verify_delete');

  expect(auth.verifyEmail({ token: 'sqlite-valid' })).toEqual({ kind: 'verified' });
  expect(db.prepare('SELECT id FROM email_verification_tokens WHERE user_id = ?').all(registered.user.id)).toEqual([]);
  const loggedIn = await auth.login({ email: 'verify@example.com', password: 'password123' });
  if (loggedIn.kind !== 'logged-in') throw new Error('Expected logged-in');
  expect(loggedIn.user.emailVerified).toBe(true);
});

it('resends verification atomically, reads runtime env per call, skips verified or missing users, and propagates mail errors', async () => {
  vi.stubEnv('APP_URL', 'https://one.fareloch.test');
  vi.stubEnv('SMTP_FROM', 'from-one@fareloch.test');

  let committedDuringSend = false;
  const auth = makeAuth({
    sendMail: async (message) => {
      const tokens = db.prepare('SELECT token FROM email_verification_tokens').all();
      committedDuringSend = tokens.length > 0 && !db.inTransaction;
      sentMail.push(message);
    },
  });

  expect(await auth.resendVerification(999999)).toEqual({ kind: 'user-not-found' });

  const registered = await auth.register({
    email: 'resend@example.com',
    password: 'password123',
    firstName: '<Resend & User>',
  });
  if (registered.kind !== 'registered') throw new Error('Expected registered');
  const initialTokens = db.prepare('SELECT token FROM email_verification_tokens WHERE user_id = ?')
    .all(registered.user.id) as Array<{ token: string }>;
  expect(initialTokens).toHaveLength(1);

  db.exec(`
    CREATE TRIGGER reject_verify_insert BEFORE INSERT ON email_verification_tokens
    BEGIN SELECT RAISE(ABORT, 'insert failed'); END;
  `);
  await expect(auth.resendVerification(registered.user.id)).rejects.toThrow('insert failed');
  expect(db.inTransaction).toBe(false);
  expect(db.prepare('SELECT token FROM email_verification_tokens WHERE user_id = ?').all(registered.user.id))
    .toEqual(initialTokens);
  db.exec('DROP TRIGGER reject_verify_insert');

  sentMail = [];
  vi.stubEnv('APP_URL', 'https://two.fareloch.test');
  vi.stubEnv('SMTP_FROM', 'from-two@fareloch.test');
  const resent = await auth.resendVerification(registered.user.id);
  expect(resent).toEqual({ kind: 'sent' });
  expect(committedDuringSend).toBe(true);
  expect(sentMail).toHaveLength(1);
  expect(sentMail[0].from).toBe('from-two@fareloch.test');
  expect(sentMail[0].html).toContain('Hi &lt;Resend &amp; User&gt;,');
  expect(sentMail[0].html).toContain('https://two.fareloch.test/#/verify-email?token=');
  const newTokens = db.prepare('SELECT token FROM email_verification_tokens WHERE user_id = ?')
    .all(registered.user.id) as Array<{ token: string }>;
  expect(newTokens).toHaveLength(1);
  expect(newTokens[0].token).not.toBe(initialTokens[0].token);

  const failingAuth = makeAuth({
    sendMail: async () => {
      throw new Error('smtp rejected');
    },
  });
  await expect(failingAuth.resendVerification(registered.user.id)).rejects.toThrow('smtp rejected');

  const latestTokens = db.prepare('SELECT token FROM email_verification_tokens WHERE user_id = ?')
    .all(registered.user.id) as Array<{ token: string }>;
  expect(latestTokens).toHaveLength(1);
  expect(auth.verifyEmail({ token: latestTokens[0].token })).toEqual({ kind: 'verified' });
  sentMail = [];
  expect(await auth.resendVerification(registered.user.id)).toEqual({ kind: 'already-verified' });
  expect(sentMail).toHaveLength(0);
});

it('handles forgotPassword with normalization, anti-enumeration, HTML escaping, 1h expiry, and mail error propagation', async () => {
  vi.stubEnv('APP_URL', 'https://reset.fareloch.test');
  vi.stubEnv('SMTP_FROM', 'reset@fareloch.test');

  let committedDuringSend = false;
  const auth = makeAuth({
    sendMail: async (message) => {
      const tokens = db.prepare('SELECT token FROM password_reset_tokens').all();
      committedDuringSend = tokens.length > 0 && !db.inTransaction;
      sentMail.push(message);
    },
  });

  expect(await auth.forgotPassword({})).toEqual({ kind: 'invalid-input', error: 'Email is required' });
  expect(await auth.forgotPassword({ email: '   ' })).toEqual({ kind: 'invalid-input', error: 'Email is required' });
  expect(await auth.forgotPassword({ email: 42 })).toEqual({ kind: 'invalid-input', error: 'Email is required' });

  expect(await auth.forgotPassword({ email: 'nobody@example.com' })).toEqual({ kind: 'accepted' });
  expect(sentMail).toHaveLength(0);

  const registered = await auth.register({
    email: 'recover@example.com',
    password: 'password123',
    firstName: `<Recover & "User">`,
  });
  if (registered.kind !== 'registered') throw new Error('Expected registered');
  sentMail = [];

  const accepted = await auth.forgotPassword({ email: '  RECOVER@example.com ' });
  expect(accepted).toEqual({ kind: 'accepted' });
  expect(committedDuringSend).toBe(true);
  expect(sentMail).toHaveLength(1);
  expect(sentMail[0]).toMatchObject({
    from: 'reset@fareloch.test',
    to: 'recover@example.com',
    subject: 'Reset your Fareloch password',
  });
  expect(sentMail[0].html).toContain('Hi &lt;Recover &amp; &quot;User&quot;&gt;,');
  expect(sentMail[0].html).toContain('https://reset.fareloch.test/#/reset-password?token=');

  const resetRow = db.prepare('SELECT expires_at FROM password_reset_tokens WHERE user_id = ?')
    .get(registered.user.id) as { expires_at: string };
  expect(resetRow.expires_at).toBe('2026-11-19T08:12:23.000Z');

  const failingAuth = makeAuth({
    sendMail: async () => {
      throw new Error('smtp failed');
    },
  });
  await expect(failingAuth.forgotPassword({ email: 'recover@example.com' })).rejects.toThrow('smtp failed');
});

it('resets password atomically, eliminates concurrent TOCTOU race, checks same-UTC-day expiry, and rolls back on failure', async () => {
  const auth = makeAuth();
  const registered = await auth.register({ email: 'reset@example.com', password: 'old-password', firstName: 'Reset' });
  if (registered.kind !== 'registered') throw new Error('Expected registered');

  expect(await auth.resetPassword({})).toEqual({ kind: 'invalid-input', error: 'Token and password are required' });
  expect(await auth.resetPassword({ token: 'abc', password: 'short' })).toEqual({
    kind: 'invalid-input',
    error: 'Password must be at least 8 characters',
  });

  const hashSpy = vi.spyOn(bcrypt, 'hash');
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at, used) VALUES (?, ?, ?, ?)')
    .run(registered.user.id, 'iso-expired-same-day', '2026-11-19T07:11:23.668Z', 0);
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at, used) VALUES (?, ?, ?, ?)')
    .run(registered.user.id, 'sqlite-expired-same-day', '2026-11-19 07:11:23', 0);
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at, used) VALUES (?, ?, ?, ?)')
    .run(registered.user.id, 'already-used', '2026-11-19T08:00:00.000Z', 1);

  expect(await auth.resetPassword({ token: 'iso-expired-same-day', password: 'new-password-1' })).toEqual({ kind: 'invalid-token' });
  expect(await auth.resetPassword({ token: 'sqlite-expired-same-day', password: 'new-password-1' })).toEqual({ kind: 'invalid-token' });
  expect(await auth.resetPassword({ token: 'already-used', password: 'new-password-1' })).toEqual({ kind: 'invalid-token' });
  expect(hashSpy).not.toHaveBeenCalled();
  hashSpy.mockRestore();

  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(registered.user.id, 'sqlite-valid-reset', '2026-11-19 07:13:23');

  db.exec(`
    CREATE TRIGGER reject_user_update BEFORE UPDATE ON users
    BEGIN SELECT RAISE(ABORT, 'user update aborted'); END;
  `);
  await expect(auth.resetPassword({ token: 'sqlite-valid-reset', password: 'rolled-back-password' }))
    .rejects.toThrow('user update aborted');
  expect(db.inTransaction).toBe(false);
  expect((db.prepare('SELECT used FROM password_reset_tokens WHERE token = ?').get('sqlite-valid-reset') as { used: number }).used).toBe(0);
  expect((await auth.login({ email: 'reset@example.com', password: 'old-password' })).kind).toBe('logged-in');
  db.exec('DROP TRIGGER reject_user_update');

  const [r1, r2] = await Promise.all([
    auth.resetPassword({ token: 'sqlite-valid-reset', password: 'winner-one-password' }),
    auth.resetPassword({ token: 'sqlite-valid-reset', password: 'winner-two-password' }),
  ]);
  expect([r1.kind, r2.kind].sort()).toEqual(['invalid-token', 'reset']);
  expect((db.prepare('SELECT used FROM password_reset_tokens WHERE token = ?').get('sqlite-valid-reset') as { used: number }).used).toBe(1);

  const winningPassword = r1.kind === 'reset' ? 'winner-one-password' : 'winner-two-password';
  const losingPassword = r1.kind === 'reset' ? 'winner-two-password' : 'winner-one-password';
  expect((await auth.login({ email: 'reset@example.com', password: winningPassword })).kind).toBe('logged-in');
  expect((await auth.login({ email: 'reset@example.com', password: losingPassword })).kind).toBe('invalid-credentials');
});

it('defaults bcrypt work factor to 12 when bcryptRounds is omitted', async () => {
  const auth = createAccountAuth({
    db,
    sendMail: async () => ({}),
    signToken: () => 'tok',
  });
  const result = await auth.register({ email: 'rounds@example.com', password: 'password123', firstName: 'Rounds' });
  expect(result.kind).toBe('registered');
  const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rounds@example.com') as { password_hash: string };
  expect(bcrypt.getRounds(row.password_hash)).toBe(12);
});

it('validates untrusted register inputs, defaults missing userAgent to unknown, and sends mail strictly after commit', async () => {
  let committedBeforeMail = false;
  const auth = makeAuth({
    sendMail: async (message) => {
      const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      committedBeforeMail = userCount === 1 && !db.inTransaction;
      sentMail.push(message);
    },
  });

  expect(await auth.register(null)).toEqual({
    kind: 'invalid-input',
    error: 'Email, password, and first name are required',
  });
  expect(await auth.register({ email: '   ', password: 'password123', firstName: 'A' })).toEqual({
    kind: 'invalid-input',
    error: 'Email, password, and first name are required',
  });
  expect(await auth.register({ email: 'a@example.com', password: 'password123', firstName: '   ' })).toEqual({
    kind: 'invalid-input',
    error: 'Email, password, and first name are required',
  });
  expect(await auth.register({ email: 'a@example.com', password: 'short', firstName: 'A' })).toEqual({
    kind: 'invalid-input',
    error: 'Password must be at least 8 characters',
  });

  const registered = await auth.register({ email: 'after@example.com', password: 'password123', firstName: 'After' });
  expect(registered.kind).toBe('registered');
  expect(committedBeforeMail).toBe(true);
  expect(sentMail[1].text).toContain('Device: unknown');
});

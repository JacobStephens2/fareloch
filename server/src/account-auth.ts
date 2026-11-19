import bcrypt from 'bcrypt';
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { AuthPayload } from './middleware/auth.js';
import { readProfile, type Profile } from './profile.js';

const DEFAULT_BCRYPT_ROUNDS = 12;
const DEFAULT_APP_URL = 'https://fareloch.app';
const DEFAULT_SMTP_FROM = 'noreply@fareloch.app';
const DEFAULT_ADMIN_NOTIFY_EMAIL = 'jacob@stephens.page';
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const DEFAULT_HEIGHT_INCHES = 71;
const DEFAULT_WEIGHT_LBS = 155;
const MIN_PASSWORD_LENGTH = 8;
const MAX_USER_AGENT_LENGTH = 1024;
const UNEXPIRED_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) > ?";

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export type SendMail = (message: MailMessage) => Promise<unknown>;
export type MailErrorKind = 'verification' | 'admin-notification';
export type MailErrorHandler = (kind: MailErrorKind, error: unknown) => void;

export interface AccountAuthDeps {
  db: Database.Database | (() => Database.Database);
  sendMail: SendMail;
  signToken: (payload: AuthPayload) => string;
  appUrl?: string;
  smtpFrom?: string;
  adminNotifyEmail?: string;
  bcryptRounds?: number;
  now?: () => Date;
  onMailError?: MailErrorHandler;
}

export type RegisterResult =
  | { kind: 'registered'; user: Profile; token: string }
  | { kind: 'invalid-input'; error: string }
  | { kind: 'email-taken' };

export type LoginResult =
  | { kind: 'logged-in'; user: Profile; token: string }
  | { kind: 'invalid-input'; error: string }
  | { kind: 'invalid-credentials' };

export type ChangePasswordResult =
  | { kind: 'changed' }
  | { kind: 'invalid-input'; error: string }
  | { kind: 'user-not-found' }
  | { kind: 'incorrect-password' };

export type VerifyEmailResult =
  | { kind: 'verified' }
  | { kind: 'invalid-input'; error: string }
  | { kind: 'invalid-token' };

export type ResendVerificationResult =
  | { kind: 'sent' }
  | { kind: 'already-verified' }
  | { kind: 'user-not-found' };

export type ForgotPasswordResult =
  | { kind: 'accepted' }
  | { kind: 'invalid-input'; error: string };

export type ResetPasswordResult =
  | { kind: 'reset' }
  | { kind: 'invalid-input'; error: string }
  | { kind: 'invalid-token' };

export interface AccountAuth {
  register(input: unknown, userAgent?: string): Promise<RegisterResult>;
  login(input: unknown): Promise<LoginResult>;
  changePassword(userId: number, input: unknown): Promise<ChangePasswordResult>;
  verifyEmail(input: unknown): VerifyEmailResult;
  resendVerification(userId: number): Promise<ResendVerificationResult>;
  forgotPassword(input: unknown): Promise<ForgotPasswordResult>;
  resetPassword(input: unknown): Promise<ResetPasswordResult>;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function normalizeEmail(raw: string): string {
  return raw.toLowerCase().trim();
}

function futureIso(base: Date, offsetMs: number): string {
  return new Date(base.getTime() + offsetMs).toISOString();
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function validateMinPassword(password: string): string | null {
  return password.length < MIN_PASSWORD_LENGTH
    ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    : null;
}

function issueToken(
  db: Database.Database,
  table: 'email_verification_tokens' | 'password_reset_tokens',
  userId: number,
  now: () => Date,
  ttlMs: number,
): string {
  const token = randomToken();
  const expiresAt = futureIso(now(), ttlMs);
  db.prepare(`INSERT INTO ${table} (user_id, token, expires_at) VALUES (?, ?, ?)`).run(
    userId,
    token,
    expiresAt,
  );
  return token;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function buildActionEmail(params: {
  from: string;
  to: string;
  firstName: string;
  appUrl: string;
  subject: string;
  prompt: string;
  route: string;
  token: string;
  ctaLabel: string;
  expiryText: string;
}): MailMessage {
  const safeName = escapeHtml(params.firstName);
  const safeAppUrl = escapeHtml(params.appUrl);
  return {
    from: params.from,
    to: params.to,
    subject: params.subject,
    html: `<p>Hi ${safeName},</p><p>${params.prompt}</p><p><a href="${safeAppUrl}/#/${params.route}?token=${params.token}">${params.ctaLabel}</a></p><p>${params.expiryText}</p>`,
  };
}

function buildVerificationEmail(params: {
  from: string;
  to: string;
  firstName: string;
  appUrl: string;
  token: string;
}): MailMessage {
  return buildActionEmail({
    ...params,
    subject: 'Verify your Fareloch account',
    prompt: 'Click the link below to verify your email:',
    route: 'verify-email',
    ctaLabel: 'Verify Email',
    expiryText: 'This link expires in 24 hours.',
  });
}

function buildPasswordResetEmail(params: {
  from: string;
  to: string;
  firstName: string;
  appUrl: string;
  token: string;
}): MailMessage {
  return buildActionEmail({
    ...params,
    subject: 'Reset your Fareloch password',
    prompt: 'Click the link below to reset your password:',
    route: 'reset-password',
    ctaLabel: 'Reset Password',
    expiryText: 'This link expires in 1 hour.',
  });
}

/**
 * Creates the server-owned Account authentication module with injected
 * database access, mail port, token signer, and clock.
 */
export function createAccountAuth(deps: AccountAuthDeps): AccountAuth {
  const resolveDb = typeof deps.db === 'function' ? deps.db : () => deps.db as Database.Database;
  const bcryptRounds = deps.bcryptRounds ?? DEFAULT_BCRYPT_ROUNDS;
  const now = deps.now ?? (() => new Date());
  const getAppUrl = () => deps.appUrl ?? (process.env.APP_URL || DEFAULT_APP_URL);
  const getSmtpFrom = () => deps.smtpFrom ?? (process.env.SMTP_FROM || DEFAULT_SMTP_FROM);
  const adminNotifyEmail = deps.adminNotifyEmail ?? DEFAULT_ADMIN_NOTIFY_EMAIL;
  const reportMailError: MailErrorHandler = deps.onMailError ?? ((kind, error) => {
    const prefix = kind === 'verification'
      ? 'Failed to send verification email:'
      : 'Failed to send admin notification:';
    console.error(prefix, error);
  });

  async function register(input: unknown, userAgent?: string): Promise<RegisterResult> {
    const body = asRecord(input);
    const email = normalizeEmail(readString(body, 'email'));
    const password = readString(body, 'password');
    const firstName = readString(body, 'firstName').trim();
    if (!email || !password || !firstName) {
      return { kind: 'invalid-input', error: 'Email, password, and first name are required' };
    }
    const passwordError = validateMinPassword(password);
    if (passwordError) {
      return { kind: 'invalid-input', error: passwordError };
    }

    const db = resolveDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return { kind: 'email-taken' };
    }

    // Hash strictly before entering the write transaction so SQLite write locks stay brief.
    const passwordHash = await bcrypt.hash(password, bcryptRounds);

    let created: { taken: true } | { taken: false; user: Profile; verifyToken: string };
    try {
      created = db.transaction((): { taken: true } | { taken: false; user: Profile; verifyToken: string } => {
        const duplicate = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (duplicate) return { taken: true };

        const result = db.prepare(
          'INSERT INTO users (email, password_hash, first_name, height_inches, current_weight_lbs) VALUES (?, ?, ?, ?, ?)'
        ).run(email, passwordHash, firstName, DEFAULT_HEIGHT_INCHES, DEFAULT_WEIGHT_LBS);
        const userId = Number(result.lastInsertRowid);

        const verifyToken = issueToken(db, 'email_verification_tokens', userId, now, VERIFICATION_TOKEN_TTL_MS);

        const user = readProfile(db, userId);
        if (!user) throw new Error('User not found');
        return { taken: false, user, verifyToken };
      }).immediate();
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { kind: 'email-taken' };
      }
      throw error;
    }

    if (created.taken) {
      return { kind: 'email-taken' };
    }

    const smtpFrom = getSmtpFrom();
    const appUrl = getAppUrl();

    try {
      await deps.sendMail(buildVerificationEmail({
        from: smtpFrom,
        to: email,
        firstName,
        appUrl,
        token: created.verifyToken,
      }));
    } catch (error) {
      reportMailError('verification', error);
    }

    try {
      const device = (typeof userAgent === 'string' ? userAgent : '').slice(0, MAX_USER_AGENT_LENGTH) || 'unknown';
      await deps.sendMail({
        from: smtpFrom,
        to: adminNotifyEmail,
        subject: 'Fareloch — New Account Created',
        text: `A new account was created on Fareloch.\n\nName: ${firstName}\nEmail: ${email}\nDate: ${now().toISOString()}\nDevice: ${device}`,
      });
    } catch (error) {
      reportMailError('admin-notification', error);
    }

    const token = deps.signToken({
      userId: created.user.id,
      email: created.user.email,
      firstName: created.user.firstName,
    });
    return { kind: 'registered', user: created.user, token };
  }

  async function login(input: unknown): Promise<LoginResult> {
    const body = asRecord(input);
    const email = normalizeEmail(readString(body, 'email'));
    const password = readString(body, 'password');
    if (!email || !password) {
      return { kind: 'invalid-input', error: 'Email and password are required' };
    }

    const db = resolveDb();
    const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email) as
      | { id: number; password_hash: string }
      | undefined;
    if (!row) {
      return { kind: 'invalid-credentials' };
    }

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      return { kind: 'invalid-credentials' };
    }

    const user = readProfile(db, row.id);
    if (!user) {
      return { kind: 'invalid-credentials' };
    }

    const token = deps.signToken({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
    });
    return { kind: 'logged-in', user, token };
  }

  async function changePassword(userId: number, input: unknown): Promise<ChangePasswordResult> {
    const body = asRecord(input);
    const currentPassword = readString(body, 'currentPassword');
    const newPassword = readString(body, 'newPassword');
    if (!currentPassword || !newPassword) {
      return { kind: 'invalid-input', error: 'Current and new password are required' };
    }
    const passwordError = validateMinPassword(newPassword);
    if (passwordError) {
      return { kind: 'invalid-input', error: passwordError };
    }

    const db = resolveDb();
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      | { password_hash: string }
      | undefined;
    if (!user) {
      return { kind: 'user-not-found' };
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return { kind: 'incorrect-password' };
    }

    const hash = await bcrypt.hash(newPassword, bcryptRounds);
    const updated = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    if (updated.changes === 0) {
      return { kind: 'user-not-found' };
    }

    return { kind: 'changed' };
  }

  function verifyEmail(input: unknown): VerifyEmailResult {
    const body = asRecord(input);
    const token = readString(body, 'token');
    if (!token) {
      return { kind: 'invalid-input', error: 'Token is required' };
    }

    const db = resolveDb();
    const nowIso = now().toISOString();

    return db.transaction((): VerifyEmailResult => {
      const record = db.prepare(
        `SELECT user_id FROM email_verification_tokens WHERE token = ? AND ${UNEXPIRED_SQL}`
      ).get(token, nowIso) as { user_id: number } | undefined;

      if (!record) {
        return { kind: 'invalid-token' };
      }

      const updated = db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(record.user_id);
      if (updated.changes === 0) {
        return { kind: 'invalid-token' };
      }
      db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(record.user_id);
      return { kind: 'verified' };
    }).immediate();
  }

  async function resendVerification(userId: number): Promise<ResendVerificationResult> {
    const db = resolveDb();

    const staged = db.transaction(():
      | { status: 'user-not-found' }
      | { status: 'already-verified' }
      | { status: 'ready'; email: string; firstName: string; verifyToken: string } => {
      const user = db.prepare('SELECT id, email, first_name, email_verified FROM users WHERE id = ?').get(userId) as
        | { id: number; email: string; first_name: string; email_verified: number | null }
        | undefined;
      if (!user) return { status: 'user-not-found' };
      if (user.email_verified) return { status: 'already-verified' };

      db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(user.id);
      const verifyToken = issueToken(db, 'email_verification_tokens', user.id, now, VERIFICATION_TOKEN_TTL_MS);
      return { status: 'ready', email: user.email, firstName: user.first_name, verifyToken };
    }).immediate();

    if (staged.status === 'user-not-found') return { kind: 'user-not-found' };
    if (staged.status === 'already-verified') return { kind: 'already-verified' };

    await deps.sendMail(buildVerificationEmail({
      from: getSmtpFrom(),
      to: staged.email,
      firstName: staged.firstName,
      appUrl: getAppUrl(),
      token: staged.verifyToken,
    }));

    return { kind: 'sent' };
  }

  async function forgotPassword(input: unknown): Promise<ForgotPasswordResult> {
    const body = asRecord(input);
    const email = normalizeEmail(readString(body, 'email'));
    if (!email) {
      return { kind: 'invalid-input', error: 'Email is required' };
    }

    const db = resolveDb();
    const staged = db.transaction((): { email: string; firstName: string; resetToken: string } | null => {
      const user = db.prepare('SELECT id, email, first_name FROM users WHERE email = ?').get(email) as
        | { id: number; email: string; first_name: string }
        | undefined;
      if (!user) return null;

      const resetToken = issueToken(db, 'password_reset_tokens', user.id, now, PASSWORD_RESET_TOKEN_TTL_MS);
      return { email: user.email, firstName: user.first_name, resetToken };
    }).immediate();

    if (!staged) {
      return { kind: 'accepted' };
    }

    await deps.sendMail(buildPasswordResetEmail({
      from: getSmtpFrom(),
      to: staged.email,
      firstName: staged.firstName,
      appUrl: getAppUrl(),
      token: staged.resetToken,
    }));

    return { kind: 'accepted' };
  }

  async function resetPassword(input: unknown): Promise<ResetPasswordResult> {
    const body = asRecord(input);
    const token = readString(body, 'token');
    const password = readString(body, 'password');
    if (!token || !password) {
      return { kind: 'invalid-input', error: 'Token and password are required' };
    }
    const passwordError = validateMinPassword(password);
    if (passwordError) {
      return { kind: 'invalid-input', error: passwordError };
    }

    const db = resolveDb();
    const record = db.prepare(
      `SELECT id, user_id FROM password_reset_tokens WHERE token = ? AND used = 0 AND ${UNEXPIRED_SQL}`
    ).get(token, now().toISOString()) as { id: number; user_id: number } | undefined;

    if (!record) {
      return { kind: 'invalid-token' };
    }

    const hash = await bcrypt.hash(password, bcryptRounds);

    return db.transaction((): ResetPasswordResult => {
      const claim = db.prepare(
        `UPDATE password_reset_tokens SET used = 1 WHERE id = ? AND used = 0 AND ${UNEXPIRED_SQL}`
      ).run(record.id, now().toISOString());

      if (claim.changes !== 1) {
        return { kind: 'invalid-token' };
      }

      const updated = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, record.user_id);
      if (updated.changes !== 1) {
        throw new Error('User not found');
      }
      return { kind: 'reset' };
    }).immediate();
  }

  return {
    register,
    login,
    changePassword,
    verifyEmail,
    resendVerification,
    forgotPassword,
    resetPassword,
  };
}

import { Router, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import {
  createAccountAuth,
  type SendMail,
} from '../account-auth.js';
import { getDb } from '../db.js';
import {
  clearTokenCookie,
  requireAuth,
  setTokenCookie,
  signToken,
} from '../middleware/auth.js';
import { readProfile, updateProfile } from '../profile.js';

export interface AuthRouterDeps {
  db?: Database.Database | (() => Database.Database);
  sendMail?: SendMail;
}

function createLazyMailSender(): SendMail {
  let transport: nodemailer.Transporter | undefined;
  return async (message) => {
    if (!transport) {
      transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'localhost',
        port: parseInt(process.env.SMTP_PORT || '25'),
        secure: process.env.SMTP_SECURE === 'true',
        ...(process.env.SMTP_USER
          ? {
              auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS || '',
              },
            }
          : {}),
      });
    }
    return transport.sendMail(message);
  };
}

function assertNever(value: never): never {
  throw new Error(`Unexpected auth outcome: ${JSON.stringify(value)}`);
}

/**
 * Builds the Express authentication router with optional database and mail ports.
 */
export function createAuthRouter(deps: AuthRouterDeps = {}): Router {
  const router = Router();
  const resolveDb = typeof deps.db === 'function'
    ? deps.db
    : deps.db
      ? () => deps.db as Database.Database
      : () => getDb();

  const accountAuth = createAccountAuth({
    db: resolveDb,
    sendMail: deps.sendMail ?? createLazyMailSender(),
    signToken,
  });

  // Register
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const result = await accountAuth.register(req.body, req.get('user-agent'));
      switch (result.kind) {
        case 'invalid-input':
          res.status(400).json({ error: result.error });
          return;
        case 'email-taken':
          res.status(409).json({ error: 'An account with this email already exists' });
          return;
        case 'registered':
          setTokenCookie(res, result.token);
          res.json({ user: result.user, token: result.token });
          return;
        default:
          assertNever(result);
      }
    } catch (e) {
      console.error('Register error:', e);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // Login
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const result = await accountAuth.login(req.body);
      switch (result.kind) {
        case 'invalid-input':
          res.status(400).json({ error: result.error });
          return;
        case 'invalid-credentials':
          res.status(401).json({ error: 'Invalid email or password' });
          return;
        case 'logged-in':
          setTokenCookie(res, result.token);
          res.json({ user: result.user, token: result.token });
          return;
        default:
          assertNever(result);
      }
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Get current user
  router.get('/me', requireAuth, (req: Request, res: Response) => {
    const user = readProfile(resolveDb(), req.user!.userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  });

  // Update profile
  router.put('/me', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = updateProfile(resolveDb(), req.user!.userId, req.body);
      switch (result.kind) {
        case 'invalid-waist':
          res.status(400).json({ error: 'Waist ceiling must be a number between 20 and 60 inches' });
          return;
        case 'missing':
          res.status(500).json({ error: 'Update failed' });
          return;
        case 'updated':
          res.json({ user: result.profile });
          return;
        default:
          assertNever(result);
      }
    } catch (e) {
      console.error('Update profile error:', e);
      res.status(500).json({ error: 'Update failed' });
    }
  });

  // Change password
  router.post('/change-password', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await accountAuth.changePassword(req.user!.userId, req.body);
      switch (result.kind) {
        case 'invalid-input':
          res.status(400).json({ error: result.error });
          return;
        case 'user-not-found':
          res.status(404).json({ error: 'User not found' });
          return;
        case 'incorrect-password':
          res.status(401).json({ error: 'Current password is incorrect' });
          return;
        case 'changed':
          res.json({ success: true });
          return;
        default:
          assertNever(result);
      }
    } catch (e) {
      console.error('Change password error:', e);
      res.status(500).json({ error: 'Password change failed' });
    }
  });

  // Logout
  router.post('/logout', (_req: Request, res: Response) => {
    clearTokenCookie(res);
    res.json({ success: true });
  });

  // Verify email
  router.post('/verify-email', (req: Request, res: Response) => {
    try {
      const result = accountAuth.verifyEmail(req.body);
      switch (result.kind) {
        case 'invalid-input':
          res.status(400).json({ error: result.error });
          return;
        case 'invalid-token':
          res.status(400).json({ error: 'Invalid or expired token' });
          return;
        case 'verified':
          res.json({ success: true });
          return;
        default:
          assertNever(result);
      }
    } catch (e) {
      console.error('Verify email error:', e);
      res.status(500).json({ error: 'Email verification failed' });
    }
  });

  // Resend verification email
  router.post('/resend-verification', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await accountAuth.resendVerification(req.user!.userId);
      switch (result.kind) {
        case 'user-not-found':
          res.status(404).json({ error: 'User not found' });
          return;
        case 'already-verified':
          res.json({ success: true, message: 'Already verified' });
          return;
        case 'sent':
          res.json({ success: true });
          return;
        default:
          assertNever(result);
      }
    } catch (e) {
      console.error('Resend verification error:', e);
      res.status(500).json({ error: 'Failed to resend' });
    }
  });

  // Forgot password
  router.post('/forgot-password', async (req: Request, res: Response) => {
    try {
      const result = await accountAuth.forgotPassword(req.body);
      switch (result.kind) {
        case 'invalid-input':
          res.status(400).json({ error: result.error });
          return;
        case 'accepted':
          res.json({ success: true });
          return;
        default:
          assertNever(result);
      }
    } catch (e) {
      console.error('Forgot password error:', e);
      res.status(500).json({ error: 'Request failed' });
    }
  });

  // Reset password
  router.post('/reset-password', async (req: Request, res: Response) => {
    try {
      const result = await accountAuth.resetPassword(req.body);
      switch (result.kind) {
        case 'invalid-input':
          res.status(400).json({ error: result.error });
          return;
        case 'invalid-token':
          res.status(400).json({ error: 'Invalid or expired reset token' });
          return;
        case 'reset':
          res.json({ success: true });
          return;
        default:
          assertNever(result);
      }
    } catch (e) {
      console.error('Reset password error:', e);
      res.status(500).json({ error: 'Password reset failed' });
    }
  });

  return router;
}

export default createAuthRouter();

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { getDb } from '../db.js';
import { signToken, setTokenCookie, requireAuth } from '../middleware/auth.js';
import { isWaistInches } from '../waist.js';

const router = Router();

function getMailTransport() {
  return nodemailer.createTransport({
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

const SMTP_FROM = process.env.SMTP_FROM || 'noreply@fareloch.app';
const APP_URL = process.env.APP_URL || 'https://fareloch.app';

// Register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, firstName } = req.body;
    if (!email || !password || !firstName) {
      res.status(400).json({ error: 'Email, password, and first name are required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      'INSERT INTO users (email, password_hash, first_name, height_inches, current_weight_lbs) VALUES (?, ?, ?, ?, ?)'
    ).run(email.toLowerCase().trim(), passwordHash, firstName.trim(), 71, 155);

    const userId = result.lastInsertRowid as number;

    // Send verification email
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(
      userId, verifyToken, expiresAt
    );

    try {
      const transport = getMailTransport();
      await transport.sendMail({
        from: SMTP_FROM,
        to: email,
        subject: 'Verify your Fareloch account',
        html: `<p>Hi ${firstName},</p><p>Click the link below to verify your email:</p><p><a href="${APP_URL}/#/verify-email?token=${verifyToken}">Verify Email</a></p><p>This link expires in 24 hours.</p>`,
      });
    } catch (e) {
      console.error('Failed to send verification email:', e);
    }

    try {
      const transport = getMailTransport();
      const ua = (req.headers['user-agent'] || '').toString().slice(0, 1024) || 'unknown';
      await transport.sendMail({
        from: SMTP_FROM,
        to: 'jacob@stephens.page',
        subject: 'Fareloch — New Account Created',
        text: `A new account was created on Fareloch.\n\nName: ${firstName.trim()}\nEmail: ${email.toLowerCase().trim()}\nDate: ${new Date().toISOString()}\nDevice: ${ua}`,
      });
    } catch (e) {
      console.error('Failed to send admin notification:', e);
    }

    const token = signToken({ userId, email: email.toLowerCase().trim(), firstName: firstName.trim() });
    setTokenCookie(res, token);
    res.json({ user: { id: userId, email, firstName, emailVerified: false, targetWaistInches: null }, token });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim()) as any;
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = signToken({ userId: user.id, email: user.email, firstName: user.first_name });
    setTokenCookie(res, token);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        emailVerified: !!user.email_verified,
        heightInches: user.height_inches,
        currentWeightLbs: user.current_weight_lbs,
        targetWaistInches: user.target_waist_inches,
        targetCalories: user.target_calories,
        targetCarbsG: user.target_carbs_g,
        targetProteinG: user.target_protein_g,
        targetFatG: user.target_fat_g,
        workoutTargetCalories: user.workout_target_calories,
        workoutTargetCarbsG: user.workout_target_carbs_g,
        workoutTargetProteinG: user.workout_target_protein_g,
        workoutTargetFatG: user.workout_target_fat_g,
      },
      token,
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user
router.get('/me', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as any;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      emailVerified: !!user.email_verified,
      heightInches: user.height_inches,
      currentWeightLbs: user.current_weight_lbs,
      targetWaistInches: user.target_waist_inches,
      targetCalories: user.target_calories,
      targetCarbsG: user.target_carbs_g,
      targetProteinG: user.target_protein_g,
      targetFatG: user.target_fat_g,
    },
  });
});

// Update profile
router.put('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const {
      firstName, heightInches, currentWeightLbs, targetWaistInches,
      targetCalories, targetCarbsG, targetProteinG, targetFatG,
      workoutTargetCalories, workoutTargetCarbsG, workoutTargetProteinG, workoutTargetFatG,
    } = req.body;
    if (targetWaistInches != null && !isWaistInches(targetWaistInches)) {
      res.status(400).json({ error: 'Waist ceiling must be a number between 20 and 60 inches' });
      return;
    }
    db.prepare(`
      UPDATE users SET
        first_name = COALESCE(?, first_name),
        height_inches = COALESCE(?, height_inches),
        current_weight_lbs = COALESCE(?, current_weight_lbs),
        target_waist_inches = CASE WHEN ? THEN ? ELSE target_waist_inches END,
        target_calories = COALESCE(?, target_calories),
        target_carbs_g = COALESCE(?, target_carbs_g),
        target_protein_g = COALESCE(?, target_protein_g),
        target_fat_g = COALESCE(?, target_fat_g),
        workout_target_calories = COALESCE(?, workout_target_calories),
        workout_target_carbs_g = COALESCE(?, workout_target_carbs_g),
        workout_target_protein_g = COALESCE(?, workout_target_protein_g),
        workout_target_fat_g = COALESCE(?, workout_target_fat_g)
      WHERE id = ?
    `).run(
      firstName, heightInches, currentWeightLbs,
      targetWaistInches !== undefined ? 1 : 0, targetWaistInches ?? null,
      targetCalories, targetCarbsG, targetProteinG, targetFatG,
      workoutTargetCalories, workoutTargetCarbsG, workoutTargetProteinG, workoutTargetFatG,
      req.user!.userId
    );

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as any;
    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        emailVerified: !!user.email_verified,
        heightInches: user.height_inches,
        currentWeightLbs: user.current_weight_lbs,
        targetWaistInches: user.target_waist_inches,
        targetCalories: user.target_calories,
        targetCarbsG: user.target_carbs_g,
        targetProteinG: user.target_protein_g,
        targetFatG: user.target_fat_g,
        workoutTargetCalories: user.workout_target_calories,
        workoutTargetCarbsG: user.workout_target_carbs_g,
        workoutTargetProteinG: user.workout_target_protein_g,
        workoutTargetFatG: user.workout_target_fat_g,
      },
    });
  } catch (e) {
    console.error('Update profile error:', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// Change password
router.post('/change-password', requireAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current and new password are required' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const db = getDb();
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.userId) as any;
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user!.userId);
    res.json({ success: true });
  } catch (e) {
    console.error('Change password error:', e);
    res.status(500).json({ error: 'Password change failed' });
  }
});

// Logout
router.post('/logout', (_req: Request, res: Response) => {
  res.cookie('token', '', { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 0, path: '/' });
  res.json({ success: true });
});

// Verify email
router.post('/verify-email', (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: 'Token is required' });
    return;
  }

  const db = getDb();
  const record = db.prepare(
    "SELECT * FROM email_verification_tokens WHERE token = ? AND expires_at > datetime('now')"
  ).get(token) as any;

  if (!record) {
    res.status(400).json({ error: 'Invalid or expired token' });
    return;
  }

  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(record.user_id);
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(record.user_id);
  res.json({ success: true });
});

// Resend verification email
router.post('/resend-verification', requireAuth, async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as any;
    if (user.email_verified) {
      res.json({ success: true, message: 'Already verified' });
      return;
    }

    db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(user.id);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(
      user.id, verifyToken, expiresAt
    );

    const transport = getMailTransport();
    await transport.sendMail({
      from: SMTP_FROM,
      to: user.email,
      subject: 'Verify your Fareloch account',
      html: `<p>Hi ${user.first_name},</p><p>Click the link below to verify your email:</p><p><a href="${APP_URL}/#/verify-email?token=${verifyToken}">Verify Email</a></p><p>This link expires in 24 hours.</p>`,
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Resend verification error:', e);
    res.status(500).json({ error: 'Failed to resend' });
  }
});

// Forgot password
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim()) as any;

    // Always return success to prevent email enumeration
    if (!user) {
      res.json({ success: true });
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(
      user.id, resetToken, expiresAt
    );

    const transport = getMailTransport();
    await transport.sendMail({
      from: SMTP_FROM,
      to: user.email,
      subject: 'Reset your Fareloch password',
      html: `<p>Hi ${user.first_name},</p><p>Click the link below to reset your password:</p><p><a href="${APP_URL}/#/reset-password?token=${resetToken}">Reset Password</a></p><p>This link expires in 1 hour.</p>`,
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ error: 'Request failed' });
  }
});

// Reset password
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ error: 'Token and password are required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const db = getDb();
    const record = db.prepare(
      "SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')"
    ).get(token) as any;

    if (!record) {
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    const hash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, record.user_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);

    res.json({ success: true });
  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

export default router;

import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { isWaistInches } from '../waist.js';
import { saveWeight } from '../weight-mutations.js';

const router = Router();

// Get weight logs
router.get('/', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const limit = parseInt(req.query.limit as string) || 90;
  const logs = db.prepare(`
    SELECT * FROM weight_logs
    WHERE user_id = ?
    ORDER BY date DESC, time DESC
    LIMIT ?
  `).all(req.user!.userId, limit);
  res.json({ logs });
});

// Log weight
router.post('/', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { date, weightLbs, notes, time, waistInches } = req.body;
    if (!date || !weightLbs) {
      res.status(400).json({ error: 'Date and weight are required' });
      return;
    }
    if (waistInches != null && !isWaistInches(waistInches)) {
      res.status(400).json({ error: 'Waist must be a number between 20 and 60 inches' });
      return;
    }

    const log = saveWeight(db, req.user!.userId, { date, weightLbs, notes, time, waistInches });
    res.json({ log });
  } catch (e) {
    console.error('Log weight error:', e);
    res.status(500).json({ error: 'Failed to log weight' });
  }
});

// Delete weight log
router.delete('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM weight_logs WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.userId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Weight log not found' });
    return;
  }
  res.json({ success: true });
});

// Export weight as CSV
router.get('/export/csv', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const logs = db.prepare('SELECT date, time, weight_lbs, waist_inches, notes FROM weight_logs WHERE user_id = ? ORDER BY date DESC, time DESC').all(req.user!.userId) as any[];

  const header = 'Date,Time,Weight(lbs),Waist(in),Notes';
  const rows = logs.map((l: any) => {
    const esc = (s: string | null) => s ? `"${s.replace(/"/g, '""')}"` : '';
    return `${l.date},${l.time || ''},${l.weight_lbs},${l.waist_inches ?? ''},${esc(l.notes)}`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=fareloch-weight.csv');
  res.send([header, ...rows].join('\n'));
});

export default router;

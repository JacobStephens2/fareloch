import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { dailyCheckValidationError } from '../daily-checks.js';

const router = Router();
router.use(requireAuth);

function readChecks(userId: number, date: string) {
  const rows = getDb().prepare(
    'SELECT check_key FROM daily_checks WHERE user_id = ? AND date = ? ORDER BY check_key'
  ).all(userId, date) as { check_key: string }[];
  return { checks: rows.map(row => row.check_key) };
}

router.get('/:date', (req: Request, res: Response) => {
  res.json(readChecks(req.user!.userId, req.params.date as string));
});

router.put('/:date', (req: Request, res: Response) => {
  const { key, checked } = req.body ?? {};
  const error = dailyCheckValidationError(key, checked);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const userId = req.user!.userId;
  const date = req.params.date as string;
  if (checked) {
    getDb().prepare('INSERT OR IGNORE INTO daily_checks (user_id, date, check_key) VALUES (?, ?, ?)')
      .run(userId, date, key);
  } else {
    getDb().prepare('DELETE FROM daily_checks WHERE user_id = ? AND date = ? AND check_key = ?')
      .run(userId, date, key);
  }
  res.json(readChecks(userId, date));
});

export default router;

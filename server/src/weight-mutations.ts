import type Database from 'better-sqlite3';

interface WeightInput {
  date: string;
  weightLbs: number;
  time?: string | null;
  waistInches?: number | null;
  notes?: string | null;
}

interface WeightReading {
  id: number;
  user_id: number;
  date: string;
  time: string;
  weight_lbs: number;
  waist_inches: number | null;
  notes: string | null;
  created_at: string;
}

export function saveWeight(db: Database.Database, userId: number, input: WeightInput): WeightReading {
  return db.transaction(() => {
    const time = input.time || '';
    const waist = input.waistInches ?? null;
    const notes = input.notes || null;
    const existing = db.prepare(`
      SELECT id FROM weight_logs WHERE user_id = ? AND date = ? AND time = ?
    `).get(userId, input.date, time) as { id: number } | undefined;

    let id: number | bigint;
    if (existing) {
      id = existing.id;
      db.prepare(`
        UPDATE weight_logs SET weight_lbs = ?, waist_inches = ?, notes = ?
        WHERE id = ? AND user_id = ?
      `).run(input.weightLbs, waist, notes, id, userId);
    } else {
      id = db.prepare(`
        INSERT INTO weight_logs (user_id, date, time, weight_lbs, waist_inches, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, input.date, time, input.weightLbs, waist, notes).lastInsertRowid;
    }

    db.prepare('UPDATE users SET current_weight_lbs = ? WHERE id = ?').run(input.weightLbs, userId);
    return db.prepare('SELECT * FROM weight_logs WHERE id = ? AND user_id = ?').get(id, userId) as WeightReading;
  })();
}

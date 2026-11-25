// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

it.each([false, true])('migrates legacy weight logs (time column: %s) and can reopen without losing measurements', async (hasTime) => {
  const directory = mkdtempSync(join(tmpdir(), 'fareloch-waist-migration-'));
  const file = join(directory, 'test.db');
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    INSERT INTO users (id) VALUES (1);
    CREATE TABLE weight_logs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      ${hasTime ? "time TEXT NOT NULL DEFAULT ''," : ''}
      weight_lbs REAL NOT NULL,
      notes TEXT,
      created_at TEXT,
      UNIQUE(user_id, date${hasTime ? ', time' : ''})
    );
    INSERT INTO weight_logs (id, user_id, date, weight_lbs, notes, created_at)
      VALUES (1, 1, '2026-11-03', 164, 'Legacy entry', '2026-11-03 07:00:00');
  `);
  legacy.close();
  let db: Database.Database | undefined;
  try {
    vi.resetModules();
    db = (await import('./db.js')).initDb(file);
    expect(db.prepare('SELECT * FROM weight_logs').get()).toEqual({
      id: 1, user_id: 1, date: '2026-11-03', time: '', weight_lbs: 164,
      waist_inches: null, notes: 'Legacy entry', created_at: '2026-11-03 07:00:00',
    });
    expect(db.prepare('SELECT target_waist_inches FROM users').get()).toEqual({ target_waist_inches: null });
    db.prepare('UPDATE weight_logs SET waist_inches = 30.8 WHERE id = 1').run();
    db.prepare('UPDATE users SET target_waist_inches = 31.25 WHERE id = 1').run();
    db.close();
    vi.resetModules();
    db = (await import('./db.js')).initDb(file);
    expect(db.prepare('SELECT waist_inches FROM weight_logs WHERE id = 1').get()).toEqual({ waist_inches: 30.8 });
    expect(db.prepare('SELECT target_waist_inches FROM users WHERE id = 1').get()).toEqual({ target_waist_inches: 31.25 });
  } finally {
    if (db?.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

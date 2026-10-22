import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'macros.db');

let db: Database.Database;

// The first call opens the file; later calls return that connection.
export function getDb(file = DB_PATH): Database.Database {
  if (!db) {
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL,
      email_verified INTEGER DEFAULT 0,
      height_inches REAL,
      current_weight_lbs REAL,
      target_calories INTEGER DEFAULT 2590,
      target_carbs_g INTEGER DEFAULT 340,
      target_protein_g INTEGER DEFAULT 150,
      target_fat_g INTEGER DEFAULT 70,
      workout_target_calories INTEGER DEFAULT 2890,
      workout_target_carbs_g INTEGER DEFAULT 380,
      workout_target_protein_g INTEGER DEFAULT 170,
      workout_target_fat_g INTEGER DEFAULT 80,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workout_days (
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      PRIMARY KEY (user_id, date)
    );

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS foods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      brand TEXT,
      barcode TEXT,
      serving_size REAL NOT NULL DEFAULT 1,
      serving_unit TEXT NOT NULL DEFAULT 'serving',
      calories REAL NOT NULL DEFAULT 0,
      carbs_g REAL NOT NULL DEFAULT 0,
      protein_g REAL NOT NULL DEFAULT 0,
      fat_g REAL NOT NULL DEFAULT 0,
      fiber_g REAL NOT NULL DEFAULT 0,
      sugar_g REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      measures TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      total_servings REAL NOT NULL DEFAULT 1,
      serving_unit TEXT NOT NULL DEFAULT 'serving',
      manual_calories REAL,
      manual_carbs_g REAL,
      manual_protein_g REAL,
      manual_fat_g REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      food_id INTEGER NOT NULL REFERENCES foods(id),
      servings REAL NOT NULL DEFAULT 1,
      qty REAL,
      unit_label TEXT
    );

    CREATE TABLE IF NOT EXISTS meal_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast','lunch','dinner','snack')),
      food_id INTEGER REFERENCES foods(id),
      recipe_id INTEGER REFERENCES recipes(id),
      servings REAL NOT NULL DEFAULT 1,
      calories REAL NOT NULL DEFAULT 0,
      carbs_g REAL NOT NULL DEFAULT 0,
      protein_g REAL NOT NULL DEFAULT 0,
      fat_g REAL NOT NULL DEFAULT 0,
      note TEXT,
      unit_label TEXT,
      unit_scale REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weight_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      time TEXT NOT NULL DEFAULT '',
      weight_lbs REAL NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, date, time)
    );

    CREATE INDEX IF NOT EXISTS idx_meal_logs_user_date ON meal_logs(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_weight_logs_user_date ON weight_logs(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_foods_user ON foods(user_id);
    CREATE INDEX IF NOT EXISTS idx_foods_barcode ON foods(barcode);
    CREATE INDEX IF NOT EXISTS idx_foods_source ON foods(source, source_id);
  `);

  // Migrations for existing databases
  const foodCols = db.prepare("PRAGMA table_info(foods)").all() as any[];
  const foodColNames = foodCols.map((c: any) => c.name);
  if (!foodColNames.includes('measures')) {
    db.exec("ALTER TABLE foods ADD COLUMN measures TEXT");
  }

  const riCols = db.prepare("PRAGMA table_info(recipe_ingredients)").all() as any[];
  const riColNames = riCols.map((c: any) => c.name);
  if (!riColNames.includes('unit_label')) {
    db.exec(`
      ALTER TABLE recipe_ingredients ADD COLUMN qty REAL;
      ALTER TABLE recipe_ingredients ADD COLUMN unit_label TEXT;
    `);
  }

  // Migration: add time column to weight_logs and update unique constraint
  const weightCols = db.prepare("PRAGMA table_info(weight_logs)").all() as any[];
  const weightColNames = weightCols.map((c: any) => c.name);
  if (!weightColNames.includes('time')) {
    db.exec(`
      CREATE TABLE weight_logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        date TEXT NOT NULL,
        time TEXT NOT NULL DEFAULT '',
        weight_lbs REAL NOT NULL,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, date, time)
      );
      INSERT INTO weight_logs_new (id, user_id, date, time, weight_lbs, notes, created_at)
        SELECT id, user_id, date, '', weight_lbs, notes, created_at FROM weight_logs;
      DROP TABLE weight_logs;
      ALTER TABLE weight_logs_new RENAME TO weight_logs;
      CREATE INDEX IF NOT EXISTS idx_weight_logs_user_date ON weight_logs(user_id, date);
    `);
  }

  // Migration: workout-day targets and workout_days table
  const userCols = db.prepare("PRAGMA table_info(users)").all() as any[];
  const userColNames = userCols.map((c: any) => c.name);
  if (!userColNames.includes('workout_target_calories')) {
    db.exec(`
      ALTER TABLE users ADD COLUMN workout_target_calories INTEGER DEFAULT 2890;
      ALTER TABLE users ADD COLUMN workout_target_carbs_g INTEGER DEFAULT 380;
      ALTER TABLE users ADD COLUMN workout_target_protein_g INTEGER DEFAULT 170;
      ALTER TABLE users ADD COLUMN workout_target_fat_g INTEGER DEFAULT 80;
    `);
  }

  const mealCols = db.prepare("PRAGMA table_info(meal_logs)").all() as any[];
  const mealColNames = mealCols.map((c: any) => c.name);
  if (!mealColNames.includes('unit_label')) {
    db.exec("ALTER TABLE meal_logs ADD COLUMN unit_label TEXT");
  }
  if (!mealColNames.includes('unit_scale')) {
    db.exec("ALTER TABLE meal_logs ADD COLUMN unit_scale REAL");
  }

  const cols = db.prepare("PRAGMA table_info(recipes)").all() as any[];
  const colNames = cols.map((c: any) => c.name);
  if (!colNames.includes('serving_unit') && colNames.includes('name')) {
    db.exec(`
      ALTER TABLE recipes ADD COLUMN serving_unit TEXT NOT NULL DEFAULT 'serving';
      ALTER TABLE recipes ADD COLUMN manual_calories REAL;
      ALTER TABLE recipes ADD COLUMN manual_carbs_g REAL;
      ALTER TABLE recipes ADD COLUMN manual_protein_g REAL;
      ALTER TABLE recipes ADD COLUMN manual_fat_g REAL;
    `);
  }
}

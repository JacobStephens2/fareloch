import type Database from 'better-sqlite3';

// The local food-search owner rule: a foods row is visible when it belongs to
// the signed-in caller or has no owner. One bound parameter, the caller id.
// `alias` is a fixed identifier, never request data.
export function foodVisibleToCaller(alias: 'f' | '' = ''): string {
  const column = alias ? `${alias}.user_id` : 'user_id';
  return `(${column} = ? OR ${column} IS NULL)`;
}

// The food id a meal or recipe may store. Another caller's food is not linkable,
// so this returns null. A missing id is returned as given; the foreign key still
// rejects it. An unowned food stays linkable.
export function acceptedFoodId(
  db: Database.Database,
  foodId: unknown,
  userId: number,
): number | null {
  if (foodId == null || foodId === '') return null;
  const id = Number(foodId);
  const visible = db.prepare(
    `SELECT id FROM foods WHERE id = ? AND ${foodVisibleToCaller()}`
  ).get(id, userId);
  if (visible) return id;
  const exists = db.prepare('SELECT id FROM foods WHERE id = ?').get(id);
  return exists ? null : id;
}

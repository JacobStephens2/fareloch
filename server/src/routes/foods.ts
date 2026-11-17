import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { createExternalFoodLookup } from '../external-food-lookup.js';

const router = Router();

// Forward to runtime fetch so the route transport adapter remains replaceable.
const externalFoodLookup = createExternalFoodLookup((input, init) => fetch(input, init));

// Search foods (local DB first, then APIs)
router.get('/search', optionalAuth, async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string || '').trim();
    if (!query) {
      res.json({ foods: [], external: [] });
      return;
    }

    const db = getDb();
    // Search local foods (user's custom + cached) — only if authenticated
    let local: any[] = [];
    if (req.user) {
      local = db.prepare(`
        SELECT * FROM foods
        WHERE (user_id = ? OR user_id IS NULL)
          AND (name LIKE ? OR brand LIKE ?)
        ORDER BY
          CASE WHEN user_id = ? THEN 0 ELSE 1 END,
          name
        LIMIT 20
      `).all(req.user.userId, `%${query}%`, `%${query}%`, req.user.userId) as any[];
    }

    // Let saved matches reach the caller without waiting for external services.
    if (req.query.savedOnly === 'true') {
      res.json({ foods: local, external: [] });
      return;
    }

    const external = await externalFoodLookup.search(query);

    res.json({ foods: local, external });
  } catch (e) {
    console.error('Food search error:', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Barcode lookup
router.get('/barcode/:code', optionalAuth, async (req: Request, res: Response) => {
  try {
    const code = req.params.code as string;
    const db = getDb();

    // Check this caller's cache first. An unsigned caller only sees an unowned row.
    const cached = db.prepare(
      'SELECT * FROM foods WHERE barcode = ? AND user_id IS ?'
    ).get(code, req.user?.userId ?? null) as any;
    if (cached) {
      res.json({ food: cached });
      return;
    }

    const food = await externalFoodLookup.barcode(code);

    if (!food) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    // Cache it under the signed-in caller. An unsigned caller leaves the row unowned.
    const result = db.prepare(`
      INSERT INTO foods (user_id, name, brand, barcode, serving_size, serving_unit, calories, carbs_g, protein_g, fat_g, fiber_g, sugar_g, source, source_id, measures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user?.userId ?? null, food.name, food.brand, food.barcode, food.serving_size, food.serving_unit,
           food.calories, food.carbs_g, food.protein_g, food.fat_g, food.fiber_g, food.sugar_g,
           food.source, food.source_id, food.measures ? JSON.stringify(food.measures) : null);

    res.json({ food: { id: result.lastInsertRowid, ...food } });
  } catch (e) {
    console.error('Barcode lookup error:', e);
    res.status(500).json({ error: 'Barcode lookup failed' });
  }
});

// Get user's custom foods
router.get('/custom', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const foods = db.prepare("SELECT * FROM foods WHERE user_id = ? AND source = 'manual' ORDER BY name").all(req.user!.userId);
  res.json({ foods });
});

// Get recent foods (foods the user has logged recently)
router.get('/recent', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const foods = db.prepare(`
    SELECT DISTINCT f.* FROM foods f
    JOIN meal_logs m ON (m.food_id = f.id)
    WHERE m.user_id = ?
    ORDER BY m.created_at DESC
    LIMIT 20
  `).all(req.user!.userId);
  res.json({ foods });
});

// Create custom food
router.post('/', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name, brand, barcode, servingSize, servingUnit, calories, carbsG, proteinG, fatG, fiberG, sugarG } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const result = db.prepare(`
      INSERT INTO foods (user_id, name, brand, barcode, serving_size, serving_unit, calories, carbs_g, protein_g, fat_g, fiber_g, sugar_g, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `).run(req.user!.userId, name, brand || null, barcode || null,
           servingSize || 1, servingUnit || 'serving',
           calories || 0, carbsG || 0, proteinG || 0, fatG || 0, fiberG || 0, sugarG || 0);

    const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid);
    res.json({ food });
  } catch (e) {
    console.error('Create food error:', e);
    res.status(500).json({ error: 'Failed to create food' });
  }
});

// Update custom food
router.put('/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const food = db.prepare('SELECT * FROM foods WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId) as any;
    if (!food) {
      res.status(404).json({ error: 'Food not found' });
      return;
    }

    const { name, brand, barcode, servingSize, servingUnit, calories, carbsG, proteinG, fatG, fiberG, sugarG } = req.body;
    db.prepare(`
      UPDATE foods SET
        name = COALESCE(?, name), brand = COALESCE(?, brand), barcode = COALESCE(?, barcode),
        serving_size = COALESCE(?, serving_size), serving_unit = COALESCE(?, serving_unit),
        calories = COALESCE(?, calories), carbs_g = COALESCE(?, carbs_g),
        protein_g = COALESCE(?, protein_g), fat_g = COALESCE(?, fat_g),
        fiber_g = COALESCE(?, fiber_g), sugar_g = COALESCE(?, sugar_g)
      WHERE id = ?
    `).run(name, brand, barcode, servingSize, servingUnit, calories, carbsG, proteinG, fatG, fiberG, sugarG, req.params.id);

    const updated = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
    res.json({ food: updated });
  } catch (e) {
    console.error('Update food error:', e);
    res.status(500).json({ error: 'Failed to update food' });
  }
});

// Delete custom food
router.delete('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM foods WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.userId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Food not found' });
    return;
  }
  res.json({ success: true });
});

// Save an external food result to local DB for logging
router.post('/save-external', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name, brand, barcode, servingSize, servingUnit, calories, carbsG, proteinG, fatG, fiberG, sugarG, source, sourceId, measures } = req.body;

    // Check if this caller already saved this source record
    if (sourceId) {
      const existing = db.prepare(
        'SELECT * FROM foods WHERE source = ? AND source_id = ? AND user_id = ?'
      ).get(source, sourceId, req.user!.userId) as any;
      if (existing) {
        res.json({ food: existing });
        return;
      }
    }

    const measuresJson = measures && measures.length > 0 ? JSON.stringify(measures) : null;

    const result = db.prepare(`
      INSERT INTO foods (user_id, name, brand, barcode, serving_size, serving_unit, calories, carbs_g, protein_g, fat_g, fiber_g, sugar_g, source, source_id, measures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user!.userId, name, brand || null, barcode || null, servingSize || 1, servingUnit || 'serving',
           calories || 0, carbsG || 0, proteinG || 0, fatG || 0, fiberG || 0, sugarG || 0,
           source || 'manual', sourceId || null, measuresJson);

    const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid);
    res.json({ food });
  } catch (e) {
    console.error('Save external food error:', e);
    res.status(500).json({ error: 'Failed to save food' });
  }
});

export default router;

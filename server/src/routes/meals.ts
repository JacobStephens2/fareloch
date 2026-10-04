import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { Macros, macrosOf, scaleMacros, recipePerServing, roundMacros } from '../nutrition.js';

const router = Router();

// Get meals for a date
router.get('/:date', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const meals = db.prepare(`
    SELECT m.*, f.name as food_name, f.brand as food_brand, f.serving_size, f.serving_unit,
           r.name as recipe_name
    FROM meal_logs m
    LEFT JOIN foods f ON m.food_id = f.id
    LEFT JOIN recipes r ON m.recipe_id = r.id
    WHERE m.user_id = ? AND m.date = ?
    ORDER BY
      CASE m.meal_type
        WHEN 'breakfast' THEN 1
        WHEN 'lunch' THEN 2
        WHEN 'dinner' THEN 3
        WHEN 'snack' THEN 4
      END,
      m.created_at
  `).all(req.user!.userId, req.params.date);
  res.json({ meals });
});

// Get daily totals for a date range
router.get('/totals/:startDate/:endDate', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const totals = db.prepare(`
    SELECT date,
      SUM(calories) as total_calories,
      SUM(carbs_g) as total_carbs,
      SUM(protein_g) as total_protein,
      SUM(fat_g) as total_fat
    FROM meal_logs
    WHERE user_id = ? AND date BETWEEN ? AND ?
    GROUP BY date
    ORDER BY date
  `).all(req.user!.userId, req.params.startDate, req.params.endDate);
  res.json({ totals });
});

// Log a meal
router.post('/', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { date, mealType, foodId, recipeId, servings, calories, carbsG, proteinG, fatG, note, unitLabel, unitScale } = req.body;

    if (!date || !mealType) {
      res.status(400).json({ error: 'Date and meal type are required' });
      return;
    }
    if (!foodId && !recipeId && calories === undefined) {
      res.status(400).json({ error: 'A food, recipe, or manual macros are required' });
      return;
    }

    const finalServings = servings || 1;
    let finalMacros: Macros = { calories: calories || 0, carbsG: carbsG || 0, proteinG: proteinG || 0, fatG: fatG || 0 };

    // Calculate from food
    if (foodId) {
      const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(foodId) as any;
      if (food) {
        finalMacros = scaleMacros(macrosOf(food), finalServings);
      }
    }

    // Calculate from recipe
    if (recipeId) {
      const recipe = db.prepare('SELECT * FROM recipes WHERE id = ? AND user_id = ?').get(recipeId, req.user!.userId) as any;
      if (recipe) {
        const ingredients = recipe.manual_calories != null ? [] : db.prepare(`
          SELECT ri.servings, f.calories, f.carbs_g, f.protein_g, f.fat_g
          FROM recipe_ingredients ri
          JOIN foods f ON ri.food_id = f.id
          WHERE ri.recipe_id = ?
        `).all(recipeId) as any[];
        const perServing = recipePerServing(recipe, ingredients.map((ing) => ({ food: ing, servings: ing.servings })));
        finalMacros = scaleMacros(perServing, finalServings);
      }
    }

    const stored = roundMacros(finalMacros, 'stored');
    const result = db.prepare(`
      INSERT INTO meal_logs (user_id, date, meal_type, food_id, recipe_id, servings, calories, carbs_g, protein_g, fat_g, note, unit_label, unit_scale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user!.userId, date, mealType, foodId || null, recipeId || null,
           finalServings,
           stored.calories,
           stored.carbsG,
           stored.proteinG,
           stored.fatG,
           note || null,
           unitLabel || null,
           unitScale || null);

    const meal = db.prepare(`
      SELECT m.*, f.name as food_name, f.brand as food_brand, f.serving_size, f.serving_unit,
             r.name as recipe_name
      FROM meal_logs m
      LEFT JOIN foods f ON m.food_id = f.id
      LEFT JOIN recipes r ON m.recipe_id = r.id
      WHERE m.id = ?
    `).get(result.lastInsertRowid);

    res.json({ meal });
  } catch (e) {
    console.error('Log meal error:', e);
    res.status(500).json({ error: 'Failed to log meal' });
  }
});

// Update a meal log
router.put('/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM meal_logs WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId);
    if (!existing) {
      res.status(404).json({ error: 'Meal log not found' });
      return;
    }

    const { servings, mealType, calories, carbsG, proteinG, fatG, note } = req.body;
    db.prepare(`
      UPDATE meal_logs SET
        servings = COALESCE(?, servings),
        meal_type = COALESCE(?, meal_type),
        calories = COALESCE(?, calories),
        carbs_g = COALESCE(?, carbs_g),
        protein_g = COALESCE(?, protein_g),
        fat_g = COALESCE(?, fat_g),
        note = COALESCE(?, note)
      WHERE id = ?
    `).run(servings, mealType, calories, carbsG, proteinG, fatG, note, req.params.id);

    const meal = db.prepare(`
      SELECT m.*, f.name as food_name, f.brand as food_brand, f.serving_size, f.serving_unit,
             r.name as recipe_name
      FROM meal_logs m
      LEFT JOIN foods f ON m.food_id = f.id
      LEFT JOIN recipes r ON m.recipe_id = r.id
      WHERE m.id = ?
    `).get(req.params.id);

    res.json({ meal });
  } catch (e) {
    console.error('Update meal error:', e);
    res.status(500).json({ error: 'Failed to update meal' });
  }
});

// Delete a meal log
router.delete('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM meal_logs WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.userId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Meal log not found' });
    return;
  }
  res.json({ success: true });
});

// Quick log (manual entry without food reference)
router.post('/quick', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { date, mealType, name, calories, carbsG, proteinG, fatG } = req.body;
    if (!date || !mealType) {
      res.status(400).json({ error: 'Date and meal type are required' });
      return;
    }

    const result = db.prepare(`
      INSERT INTO meal_logs (user_id, date, meal_type, servings, calories, carbs_g, protein_g, fat_g, note)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(req.user!.userId, date, mealType, calories || 0, carbsG || 0, proteinG || 0, fatG || 0, name || null);

    const meal = db.prepare('SELECT * FROM meal_logs WHERE id = ?').get(result.lastInsertRowid);
    res.json({ meal });
  } catch (e) {
    console.error('Quick log error:', e);
    res.status(500).json({ error: 'Failed to log meal' });
  }
});

// Export meals as CSV
router.get('/export/csv', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const meals = db.prepare(`
    SELECT m.date, m.meal_type, m.servings, m.calories, m.carbs_g, m.protein_g, m.fat_g, m.note,
           f.name as food_name, f.brand as food_brand, r.name as recipe_name
    FROM meal_logs m
    LEFT JOIN foods f ON m.food_id = f.id
    LEFT JOIN recipes r ON m.recipe_id = r.id
    WHERE m.user_id = ?
    ORDER BY m.date DESC, m.meal_type
  `).all(req.user!.userId) as any[];

  const header = 'Date,Meal,Food,Brand,Servings,Calories,Carbs(g),Protein(g),Fat(g),Note';
  const rows = meals.map((m: any) => {
    const name = m.food_name || m.recipe_name || m.note || 'Quick entry';
    const esc = (s: string | null) => s ? `"${s.replace(/"/g, '""')}"` : '';
    return `${m.date},${m.meal_type},${esc(name)},${esc(m.food_brand)},${m.servings},${m.calories},${m.carbs_g},${m.protein_g},${m.fat_g},${esc(m.note)}`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=fareloch-meals.csv');
  res.send([header, ...rows].join('\n'));
});

// Copy all meals from one date to another
router.post('/copy', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { fromDate, toDate } = req.body;
    if (!fromDate || !toDate) {
      res.status(400).json({ error: 'fromDate and toDate are required' });
      return;
    }

    const sourceMeals = db.prepare(
      'SELECT meal_type, food_id, recipe_id, servings, calories, carbs_g, protein_g, fat_g, note FROM meal_logs WHERE user_id = ? AND date = ?'
    ).all(req.user!.userId, fromDate) as any[];

    if (sourceMeals.length === 0) {
      res.status(404).json({ error: 'No meals found on that date' });
      return;
    }

    const insert = db.prepare(
      'INSERT INTO meal_logs (user_id, date, meal_type, food_id, recipe_id, servings, calories, carbs_g, protein_g, fat_g, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    const tx = db.transaction(() => {
      for (const m of sourceMeals) {
        insert.run(req.user!.userId, toDate, m.meal_type, m.food_id, m.recipe_id, m.servings, m.calories, m.carbs_g, m.protein_g, m.fat_g, m.note);
      }
    });
    tx();

    res.json({ copied: sourceMeals.length });
  } catch (e) {
    console.error('Copy meals error:', e);
    res.status(500).json({ error: 'Failed to copy meals' });
  }
});

export default router;

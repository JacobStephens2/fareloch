import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { copyMeals, editMeal, logMeal, mealCsvRows, mealsForDate, mealTotals, quickAddMeal, removeMeal } from '../meal-log.js';

const router = Router();

// Get meals for a date
router.get<{ date: string }>('/:date', requireAuth, (req, res) => {
  const meals = mealsForDate(getDb(), req.user!.userId, req.params.date);
  res.json({ meals });
});

// Get daily totals for a date range
router.get<{ startDate: string; endDate: string }>('/totals/:startDate/:endDate', requireAuth, (req, res) => {
  const totals = mealTotals(getDb(), req.user!.userId, req.params.startDate, req.params.endDate);
  res.json({ totals });
});

// Log a meal
router.post('/', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { date, mealType, foodId, recipeId, calories } = req.body;

    if (!date || !mealType) {
      res.status(400).json({ error: 'Date and meal type are required' });
      return;
    }
    if (!foodId && !recipeId && calories === undefined) {
      res.status(400).json({ error: 'A food, recipe, or manual macros are required' });
      return;
    }

    const meal = logMeal(db, req.user!.userId, req.body);
    res.json({ meal });
  } catch (e) {
    console.error('Log meal error:', e);
    res.status(500).json({ error: 'Failed to log meal' });
  }
});

// Update a meal log
router.put<{ id: string }>('/:id', requireAuth, (req, res) => {
  try {
    const meal = editMeal(getDb(), req.user!.userId, req.params.id, req.body);
    if (meal === null) {
      res.status(404).json({ error: 'Meal log not found' });
      return;
    }
    res.json({ meal });
  } catch (e) {
    console.error('Update meal error:', e);
    res.status(500).json({ error: 'Failed to update meal' });
  }
});

// Delete a meal log
router.delete<{ id: string }>('/:id', requireAuth, (req, res) => {
  if (!removeMeal(getDb(), req.user!.userId, req.params.id)) {
    res.status(404).json({ error: 'Meal log not found' });
    return;
  }
  res.json({ success: true });
});

// Quick log (manual entry without food reference)
router.post('/quick', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { date, mealType } = req.body;
    if (!date || !mealType) {
      res.status(400).json({ error: 'Date and meal type are required' });
      return;
    }

    const meal = quickAddMeal(db, req.user!.userId, req.body);
    res.json({ meal });
  } catch (e) {
    console.error('Quick log error:', e);
    res.status(500).json({ error: 'Failed to log meal' });
  }
});

// Export meals as CSV
router.get('/export/csv', requireAuth, (req: Request, res: Response) => {
  const meals = mealCsvRows(getDb(), req.user!.userId);

  const header = 'Date,Meal,Food,Brand,Servings,Calories,Carbs(g),Protein(g),Fat(g),Note';
  const rows = meals.map(m => {
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

    const copied = copyMeals(db, req.user!.userId, fromDate, toDate);
    if (copied === null) {
      res.status(404).json({ error: 'No meals found on that date' });
      return;
    }

    res.json({ copied });
  } catch (e) {
    console.error('Copy meals error:', e);
    res.status(500).json({ error: 'Failed to copy meals' });
  }
});

export default router;

import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { recipePerServing, roundMacros } from '../nutrition.js';
import { recipeIngredientRows } from '../recipe-ingredients.js';

const router = Router();

// Get all recipes for user
router.get('/', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const recipes = db.prepare('SELECT * FROM recipes WHERE user_id = ? ORDER BY name').all(req.user!.userId) as any[];

  // Attach computed nutrition for each recipe
  const withNutrition = recipes.map((r) => {
    const ingredients = recipeIngredientRows(db, r);

    return {
      ...r,
      ingredientCount: ingredients.length,
      perServing: roundMacros(
        recipePerServing(r, ingredients),
        'display',
      ),
    };
  });

  res.json({ recipes: withNutrition });
});

// Get single recipe with ingredients
router.get('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId) as any;
  if (!recipe) {
    res.status(404).json({ error: 'Recipe not found' });
    return;
  }

  const ingredients = db.prepare(`
    SELECT ri.id, ri.servings, ri.food_id, ri.qty, ri.unit_label,
           f.name, f.brand, f.serving_size, f.serving_unit,
           f.calories, f.carbs_g, f.protein_g, f.fat_g, f.measures
    FROM recipe_ingredients ri
    JOIN foods f ON ri.food_id = f.id
    WHERE ri.recipe_id = ?
  `).all(recipe.id);

  res.json({ recipe, ingredients });
});

// Create recipe
router.post('/', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name, totalServings, servingUnit, ingredients, manualCalories, manualCarbsG, manualProteinG, manualFatG } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const result = db.prepare(
      'INSERT INTO recipes (user_id, name, total_servings, serving_unit, manual_calories, manual_carbs_g, manual_protein_g, manual_fat_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      req.user!.userId, name, totalServings || 1, servingUnit || 'serving',
      manualCalories ?? null, manualCarbsG ?? null, manualProteinG ?? null, manualFatG ?? null
    );
    const recipeId = result.lastInsertRowid;

    if (ingredients && Array.isArray(ingredients)) {
      const insert = db.prepare('INSERT INTO recipe_ingredients (recipe_id, food_id, servings, qty, unit_label) VALUES (?, ?, ?, ?, ?)');
      for (const ing of ingredients) {
        insert.run(recipeId, ing.foodId, ing.servings || 1, ing.qty ?? null, ing.unitLabel ?? null);
      }
    }

    res.json({ recipe: { id: recipeId, name, totalServings: totalServings || 1 } });
  } catch (e) {
    console.error('Create recipe error:', e);
    res.status(500).json({ error: 'Failed to create recipe' });
  }
});

// Update recipe
router.put('/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const recipe = db.prepare('SELECT * FROM recipes WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId);
    if (!recipe) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    const { name, totalServings, servingUnit, ingredients, manualCalories, manualCarbsG, manualProteinG, manualFatG } = req.body;
    db.prepare(`
      UPDATE recipes SET
        name = COALESCE(?, name),
        total_servings = COALESCE(?, total_servings),
        serving_unit = COALESCE(?, serving_unit),
        manual_calories = ?,
        manual_carbs_g = ?,
        manual_protein_g = ?,
        manual_fat_g = ?
      WHERE id = ?
    `).run(name, totalServings, servingUnit,
           manualCalories ?? null, manualCarbsG ?? null, manualProteinG ?? null, manualFatG ?? null,
           req.params.id);

    // Replace ingredients if provided
    if (ingredients && Array.isArray(ingredients)) {
      db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(req.params.id);
      const insert = db.prepare('INSERT INTO recipe_ingredients (recipe_id, food_id, servings, qty, unit_label) VALUES (?, ?, ?, ?, ?)');
      for (const ing of ingredients) {
        insert.run(req.params.id, ing.foodId, ing.servings || 1, ing.qty ?? null, ing.unitLabel ?? null);
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Update recipe error:', e);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

// Copy recipe
router.post('/:id/copy', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const recipe = db.prepare('SELECT * FROM recipes WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId) as any;
    if (!recipe) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    const result = db.prepare(
      'INSERT INTO recipes (user_id, name, total_servings, serving_unit, manual_calories, manual_carbs_g, manual_protein_g, manual_fat_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      req.user!.userId, recipe.name + ' (Copy)', recipe.total_servings, recipe.serving_unit,
      recipe.manual_calories, recipe.manual_carbs_g, recipe.manual_protein_g, recipe.manual_fat_g
    );
    const newId = result.lastInsertRowid;

    const ingredients = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(recipe.id) as any[];
    const insert = db.prepare('INSERT INTO recipe_ingredients (recipe_id, food_id, servings, qty, unit_label) VALUES (?, ?, ?, ?, ?)');
    for (const ing of ingredients) {
      insert.run(newId, ing.food_id, ing.servings, ing.qty, ing.unit_label);
    }

    res.json({ recipe: { id: newId } });
  } catch (e) {
    console.error('Copy recipe error:', e);
    res.status(500).json({ error: 'Failed to copy recipe' });
  }
});

// Delete recipe
router.delete('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM recipes WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.userId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Recipe not found' });
    return;
  }
  res.json({ success: true });
});

export default router;

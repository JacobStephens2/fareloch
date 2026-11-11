import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { recipePerServing, roundMacros } from '../nutrition.js';
import { recipeIngredientRows } from '../recipe-ingredients.js';
import { createRecipe, updateRecipe, copyRecipe } from '../recipe-mutations.js';

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
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const recipe = createRecipe(db, req.user!.userId, req.body);
    res.json({ recipe });
  } catch (e) {
    console.error('Create recipe error:', e);
    res.status(500).json({ error: 'Failed to create recipe' });
  }
});

// Update recipe
router.put('/:id', requireAuth, (req: Request<{ id: string }>, res: Response) => {
  try {
    const db = getDb();
    const result = updateRecipe(db, req.user!.userId, req.params.id, req.body);
    if (!result.saved) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Update recipe error:', e);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

// Copy recipe
router.post('/:id/copy', requireAuth, (req: Request<{ id: string }>, res: Response) => {
  try {
    const db = getDb();
    const recipe = copyRecipe(db, req.user!.userId, req.params.id);
    if (!recipe) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    res.json({ recipe });
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

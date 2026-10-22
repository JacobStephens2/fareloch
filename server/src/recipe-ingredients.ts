import type Database from 'better-sqlite3';
import type { IngredientRow } from './nutrition.js';

// The ingredient rows recipePerServing totals. A manual-macro recipe reports none,
// since its manual macros override the ingredient sum.
export function recipeIngredientRows(
  db: Database.Database,
  recipe: { id: number; manual_calories: number | null },
): IngredientRow[] {
  if (recipe.manual_calories != null) return [];
  const rows = db.prepare(`
    SELECT ri.servings, f.calories, f.carbs_g, f.protein_g, f.fat_g
    FROM recipe_ingredients ri
    JOIN foods f ON ri.food_id = f.id
    WHERE ri.recipe_id = ?
  `).all(recipe.id) as any[];
  return rows.map(({ servings, ...food }) => ({ food, servings }));
}

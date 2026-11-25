import type Database from 'better-sqlite3';
import { foodVisibleToCaller } from './food-owner.js';
import type { IngredientRow } from './nutrition.js';

// The ingredient rows recipePerServing totals. A manual-macro recipe reports none,
// since its manual macros override the ingredient sum. A joined food counts only
// when the signed-in caller owns it or it has no owner.
export function recipeIngredientRows(
  db: Database.Database,
  recipe: { id: number; manual_calories: number | null },
  userId: number,
): IngredientRow[] {
  if (recipe.manual_calories != null) return [];
  const rows = db.prepare(`
    SELECT ri.servings, f.calories, f.carbs_g, f.protein_g, f.fat_g
    FROM recipe_ingredients ri
    JOIN foods f ON ri.food_id = f.id AND ${foodVisibleToCaller('f')}
    WHERE ri.recipe_id = ?
  `).all(userId, recipe.id) as any[];
  return rows.map(({ servings, ...food }) => ({ food, servings }));
}

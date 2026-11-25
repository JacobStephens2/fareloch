import type Database from 'better-sqlite3';
import { acceptedFoodId } from './food-owner.js';

interface RecipeInput {
  name?: string | null;
  totalServings?: number | null;
  servingUnit?: string | null;
  manualCalories?: number | null;
  manualCarbsG?: number | null;
  manualProteinG?: number | null;
  manualFatG?: number | null;
  ingredients?: unknown;
}

interface RecipeValues {
  user_id: number;
  name: string;
  total_servings: number;
  serving_unit: string;
  manual_calories: number | null;
  manual_carbs_g: number | null;
  manual_protein_g: number | null;
  manual_fat_g: number | null;
}

interface IngredientValues {
  food_id: number;
  servings: number;
  qty: number | null;
  unit_label: string | null;
}

function insertRecipe(db: Database.Database, recipe: RecipeValues) {
  return db.prepare(`
    INSERT INTO recipes (user_id, name, total_servings, serving_unit,
                         manual_calories, manual_carbs_g, manual_protein_g, manual_fat_g)
    VALUES (@user_id, @name, @total_servings, @serving_unit,
            @manual_calories, @manual_carbs_g, @manual_protein_g, @manual_fat_g)
  `).run(recipe).lastInsertRowid;
}

function ingredientValues(db: Database.Database, userId: number, ingredients: unknown): IngredientValues[] {
  if (!Array.isArray(ingredients)) return [];
  const values: IngredientValues[] = [];
  for (const ingredient of ingredients) {
    // Another caller's food is not linkable; a missing id still reaches the foreign key.
    const foodId = acceptedFoodId(db, ingredient.foodId, userId);
    if (foodId == null) continue;
    values.push({
      food_id: foodId,
      servings: ingredient.servings || 1,
      qty: ingredient.qty ?? null,
      unit_label: ingredient.unitLabel ?? null,
    });
  }
  return values;
}

function insertIngredients(db: Database.Database, recipeId: number | bigint, ingredients: IngredientValues[]) {
  const insert = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, food_id, servings, qty, unit_label)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const ingredient of ingredients) {
    insert.run(recipeId, ingredient.food_id, ingredient.servings, ingredient.qty, ingredient.unit_label);
  }
}

export function createRecipe(db: Database.Database, userId: number, input: RecipeInput & { name: string }) {
  return db.transaction(() => {
    const totalServings = input.totalServings || 1;
    const id = insertRecipe(db, {
      user_id: userId,
      name: input.name,
      total_servings: totalServings,
      serving_unit: input.servingUnit || 'serving',
      manual_calories: input.manualCalories ?? null,
      manual_carbs_g: input.manualCarbsG ?? null,
      manual_protein_g: input.manualProteinG ?? null,
      manual_fat_g: input.manualFatG ?? null,
    });
    insertIngredients(db, id, ingredientValues(db, userId, input.ingredients));
    return { id, name: input.name, totalServings };
  })();
}

export function updateRecipe(db: Database.Database, userId: number, recipeId: string | number | bigint, input: RecipeInput) {
  return db.transaction(() => {
    const recipe = db.prepare('SELECT id FROM recipes WHERE id = ? AND user_id = ?').get(recipeId, userId) as { id: number } | undefined;
    if (!recipe) return { saved: false };

    db.prepare(`
      UPDATE recipes SET
        name = COALESCE(?, name),
        total_servings = COALESCE(?, total_servings),
        serving_unit = COALESCE(?, serving_unit),
        manual_calories = ?, manual_carbs_g = ?, manual_protein_g = ?, manual_fat_g = ?
      WHERE id = ?
    `).run(
      input.name, input.totalServings, input.servingUnit,
      input.manualCalories ?? null, input.manualCarbsG ?? null,
      input.manualProteinG ?? null, input.manualFatG ?? null, recipeId,
    );

    if (Array.isArray(input.ingredients)) {
      db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
      insertIngredients(db, recipe.id, ingredientValues(db, userId, input.ingredients));
    }
    return { saved: true };
  })();
}

export function copyRecipe(db: Database.Database, userId: number, recipeId: string | number | bigint) {
  return db.transaction(() => {
    const recipe = db.prepare('SELECT * FROM recipes WHERE id = ? AND user_id = ?').get(recipeId, userId) as (RecipeValues & { id: number }) | undefined;
    if (!recipe) return null;

    const id = insertRecipe(db, { ...recipe, name: recipe.name + ' (Copy)' });
    const ingredients = (db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(recipe.id) as IngredientValues[])
      .filter(ingredient => acceptedFoodId(db, ingredient.food_id, userId) != null);
    // Stored values bypass create/update defaults, including legacy zero servings.
    // A copied recipe does not keep a link to another caller's food.
    insertIngredients(db, id, ingredients);
    return { id };
  })();
}

import type Database from 'better-sqlite3';
import { macrosOf, recipePerServing, roundMacros, scaleMacros, type MacroRow, type Macros, type RecipeRow } from './nutrition.js';
import { recipeIngredientRows } from './recipe-ingredients.js';

type MealMacrosInput = { [Field in keyof Macros]?: Macros[Field] | null };

interface MealEntryInput extends MealMacrosInput {
  date: string;
  mealType: string;
}

interface MealLogInput extends MealEntryInput {
  foodId?: number | null;
  recipeId?: number | null;
  servings?: number | null;
  note?: string | null;
  unitLabel?: string | null;
  unitScale?: number | null;
}

interface QuickMealInput extends MealEntryInput {
  name?: string | null;
}

interface MealEditInput extends MealMacrosInput {
  servings?: number | null;
  mealType?: string | null;
  note?: string | null;
}

interface StoredMeal {
  id: number;
  user_id: number;
  date: string;
  meal_type: string;
  food_id: number | null;
  recipe_id: number | null;
  servings: number;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  note: string | null;
  unit_label: string | null;
  unit_scale: number | null;
  created_at: string | null;
}

interface JoinedMeal extends StoredMeal {
  food_name: string | null;
  food_brand: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  recipe_name: string | null;
}

interface MealTotals {
  date: string;
  total_calories: number;
  total_carbs: number;
  total_protein: number;
  total_fat: number;
}

type MealCsvRow = Pick<JoinedMeal,
  'date' | 'meal_type' | 'servings' | 'calories' | 'carbs_g' | 'protein_g' | 'fat_g' | 'note'
  | 'food_name' | 'food_brand' | 'recipe_name'
>;

type CopySource = Pick<StoredMeal,
  'meal_type' | 'food_id' | 'recipe_id' | 'servings' | 'calories' | 'carbs_g' | 'protein_g' | 'fat_g' | 'note'
>;

type MealId = string | number | bigint;

const mealJoins = `
  FROM meal_logs m
  LEFT JOIN foods f ON m.food_id = f.id
  LEFT JOIN recipes r ON m.recipe_id = r.id
`;

const joinedMeals = `
  SELECT m.*, f.name as food_name, f.brand as food_brand, f.serving_size, f.serving_unit,
         r.name as recipe_name
  ${mealJoins}
`;

function requireMeal<Meal extends StoredMeal>(meal: Meal | undefined): Meal {
  if (!meal) throw new Error('Saved meal could not be read back');
  return meal;
}

function readSavedMeal(db: Database.Database, userId: number, id: MealId): JoinedMeal {
  return requireMeal(db.prepare<[number, MealId], JoinedMeal>(`
    ${joinedMeals}
    WHERE m.user_id = ? AND m.id = ?
  `).get(userId, id));
}

function manualMacros({ calories, carbsG, proteinG, fatG }: MealMacrosInput): Macros {
  return { calories: calories || 0, carbsG: carbsG || 0, proteinG: proteinG || 0, fatG: fatG || 0 };
}

export function mealsForDate(db: Database.Database, userId: number, date: string): JoinedMeal[] {
  return db.prepare<[number, string], JoinedMeal>(`
    ${joinedMeals}
    WHERE m.user_id = ? AND m.date = ?
    ORDER BY
      CASE m.meal_type
        WHEN 'breakfast' THEN 1
        WHEN 'lunch' THEN 2
        WHEN 'dinner' THEN 3
        WHEN 'snack' THEN 4
      END,
      m.created_at
  `).all(userId, date);
}

export function mealTotals(db: Database.Database, userId: number, startDate: string, endDate: string): MealTotals[] {
  return db.prepare<[number, string, string], MealTotals>(`
    SELECT date,
      SUM(calories) as total_calories,
      SUM(carbs_g) as total_carbs,
      SUM(protein_g) as total_protein,
      SUM(fat_g) as total_fat
    FROM meal_logs
    WHERE user_id = ? AND date BETWEEN ? AND ?
    GROUP BY date
    ORDER BY date
  `).all(userId, startDate, endDate);
}

export function logMeal(db: Database.Database, userId: number, input: MealLogInput): JoinedMeal {
  return db.transaction(() => {
    const { date, mealType, foodId, recipeId, servings, note, unitLabel, unitScale } = input;
    const finalServings = servings || 1;
    let macros = manualMacros(input);

    if (foodId) {
      const food = db.prepare<[number], MacroRow>('SELECT * FROM foods WHERE id = ?').get(foodId);
      if (food) macros = scaleMacros(macrosOf(food), finalServings);
    }
    if (recipeId) {
      const recipe = db.prepare<[number, number], RecipeRow & { id: number }>(
        'SELECT * FROM recipes WHERE id = ? AND user_id = ?',
      ).get(recipeId, userId);
      if (recipe) macros = scaleMacros(recipePerServing(recipe, recipeIngredientRows(db, recipe)), finalServings);
    }

    const stored = roundMacros(macros, 'stored');
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO meal_logs (user_id, date, meal_type, food_id, recipe_id, servings, calories, carbs_g, protein_g, fat_g, note, unit_label, unit_scale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, date, mealType, foodId || null, recipeId || null, finalServings,
      stored.calories, stored.carbsG, stored.proteinG, stored.fatG, note || null, unitLabel || null, unitScale || null);
    return readSavedMeal(db, userId, lastInsertRowid);
  })();
}

export function quickAddMeal(db: Database.Database, userId: number, input: QuickMealInput): StoredMeal {
  return db.transaction(() => {
    const { date, mealType, name } = input;
    const { calories, carbsG, proteinG, fatG } = manualMacros(input);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO meal_logs (user_id, date, meal_type, servings, calories, carbs_g, protein_g, fat_g, note)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(userId, date, mealType, calories, carbsG, proteinG, fatG, name || null);
    return requireMeal(db.prepare<[number, number | bigint], StoredMeal>(`
      SELECT * FROM meal_logs WHERE user_id = ? AND id = ?
    `).get(userId, lastInsertRowid));
  })();
}

export function editMeal(db: Database.Database, userId: number, id: string, input: MealEditInput): JoinedMeal | null {
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM meal_logs WHERE id = ? AND user_id = ?').get(id, userId);
    if (!existing) return null;

    const { servings, mealType, calories, carbsG, proteinG, fatG, note } = input;
    db.prepare(`
      UPDATE meal_logs SET
        servings = COALESCE(?, servings),
        meal_type = COALESCE(?, meal_type),
        calories = COALESCE(?, calories),
        carbs_g = COALESCE(?, carbs_g),
        protein_g = COALESCE(?, protein_g),
        fat_g = COALESCE(?, fat_g),
        note = COALESCE(?, note)
      WHERE id = ? AND user_id = ?
    `).run(servings, mealType, calories, carbsG, proteinG, fatG, note, id, userId);

    return readSavedMeal(db, userId, id);
  })();
}

export function removeMeal(db: Database.Database, userId: number, id: string): boolean {
  return db.prepare('DELETE FROM meal_logs WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function copyMeals(db: Database.Database, userId: number, fromDate: string, toDate: string): number | null {
  return db.transaction(() => {
    const source = db.prepare<[number, string], CopySource>(`
      SELECT meal_type, food_id, recipe_id, servings, calories, carbs_g, protein_g, fat_g, note
      FROM meal_logs WHERE user_id = ? AND date = ?
    `).all(userId, fromDate);
    if (source.length === 0) return null;

    const insert = db.prepare<CopySource & { user_id: number; date: string }>(`
      INSERT INTO meal_logs (user_id, date, meal_type, food_id, recipe_id, servings, calories, carbs_g, protein_g, fat_g, note)
      VALUES (@user_id, @date, @meal_type, @food_id, @recipe_id, @servings, @calories, @carbs_g, @protein_g, @fat_g, @note)
    `);
    for (const meal of source) {
      insert.run({ ...meal, user_id: userId, date: toDate });
    }

    return source.length;
  })();
}

export function mealCsvRows(db: Database.Database, userId: number): MealCsvRow[] {
  return db.prepare<[number], MealCsvRow>(`
    SELECT m.date, m.meal_type, m.servings, m.calories, m.carbs_g, m.protein_g, m.fat_g, m.note,
           f.name as food_name, f.brand as food_brand, r.name as recipe_name
    ${mealJoins}
    WHERE m.user_id = ?
    ORDER BY m.date DESC, m.meal_type
  `).all(userId);
}

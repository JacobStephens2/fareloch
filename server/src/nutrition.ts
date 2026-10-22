// Nutrition: every nutrition calculation shared by the server, guest mode and
// the views. Pure and import-free so the client can import it across the repo
// (see docs/adr/0001-shared-nutrition-module-in-server-src.md).

export interface Macros {
  calories: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
}

// A row with snake_case macro columns: food, ingredient join, meal log.
export interface MacroRow {
  calories?: number | null;
  carbs_g?: number | null;
  protein_g?: number | null;
  fat_g?: number | null;
}

export interface RecipeRow {
  total_servings: number | null;
  manual_calories: number | null;
  manual_carbs_g: number | null;
  manual_protein_g: number | null;
  manual_fat_g: number | null;
}

export interface IngredientRow {
  food: MacroRow;
  servings: number;
}

export type RoundingPolicy = 'stored' | 'display';

// Null or missing columns count as 0.
export function macrosOf(row: MacroRow): Macros {
  return {
    calories: row.calories ?? 0,
    carbsG: row.carbs_g ?? 0,
    proteinG: row.protein_g ?? 0,
    fatG: row.fat_g ?? 0,
  };
}

// Unrounded.
export function scaleMacros(m: Macros, factor: number): Macros {
  return {
    calories: m.calories * factor,
    carbsG: m.carbsG * factor,
    proteinG: m.proteinG * factor,
    fatG: m.fatG * factor,
  };
}

// Manual macros win when manual_calories is set (blank grams count as 0);
// otherwise each ingredient row's macros times its own servings, summed.
// A falsy total_servings counts as 1. Unrounded.
export function recipePerServing(recipe: RecipeRow, ingredients: IngredientRow[]): Macros {
  const totalServings = recipe.total_servings || 1;
  const total = recipe.manual_calories != null
    ? {
        calories: recipe.manual_calories,
        carbsG: recipe.manual_carbs_g ?? 0,
        proteinG: recipe.manual_protein_g ?? 0,
        fatG: recipe.manual_fat_g ?? 0,
      }
    : ingredients.reduce(
        (sum, ing) => addMacros(sum, scaleMacros(macrosOf(ing.food), ing.servings)),
        { calories: 0, carbsG: 0, proteinG: 0, fatG: 0 },
      );
  return {
    calories: total.calories / totalServings,
    carbsG: total.carbsG / totalServings,
    proteinG: total.proteinG / totalServings,
    fatG: total.fatG / totalServings,
  };
}

function addMacros(a: Macros, b: Macros): Macros {
  return {
    calories: a.calories + b.calories,
    carbsG: a.carbsG + b.carbsG,
    proteinG: a.proteinG + b.proteinG,
    fatG: a.fatG + b.fatG,
  };
}

const toTenth = (n: number) => Math.round(n * 10) / 10;

// 'stored': every field to 0.1 (meal_logs). 'display': whole kcal, grams to 0.1.
export function roundMacros(m: Macros, policy: RoundingPolicy): Macros {
  return {
    calories: policy === 'display' ? Math.round(m.calories) : toTenth(m.calories),
    carbsG: toTenth(m.carbsG),
    proteinG: toTenth(m.proteinG),
    fatG: toTenth(m.fatG),
  };
}

// How many default servings one household measure is. A falsy serving size counts as 1.
export function unitScale(gramWeight: number, servingSize: number): number {
  return gramWeight / (servingSize || 1);
}

export function caloriesFromMacros(carbsG: number, proteinG: number, fatG: number): number {
  return Math.round(carbsG * 4 + proteinG * 4 + fatG * 9);
}

// Nutrition: every nutrition calculation shared by the server, guest mode and
// the views. Pure and import-free so the client can import it across the repo
// (see docs/adr/0001-shared-nutrition-module-in-server-src.md).

export interface Macros {
  calories: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
}

export function mealPulseStatus(mealMacros: Macros, targetMealMacros: Macros): 'on-track' | 'partial' | 'low' | '' {
  if (mealMacros.calories === 0 && mealMacros.carbsG === 0 && mealMacros.proteinG === 0 && mealMacros.fatG === 0) return '';
  if (mealMacros.calories >= 0.85 * targetMealMacros.calories && mealMacros.proteinG >= 0.85 * targetMealMacros.proteinG) {
    return 'on-track';
  }
  if (mealMacros.calories >= 0.5 * targetMealMacros.calories || mealMacros.proteinG >= 0.5 * targetMealMacros.proteinG) {
    return 'partial';
  }
  return 'low';
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

export type NutritionPhase = 'lean-gain' | 'maintenance' | 'mini-cut';

export function phaseTargetPresets(weightLbs: number, phase: NutritionPhase): { rest: Macros; workout: Macros } {
  const weight = Number.isFinite(weightLbs) && weightLbs > 0 ? weightLbs : 160;
  const formula = {
    'lean-gain': { caloriesPerLb: 16.25, proteinPerLb: 1, fatPerLb: 0.5, workoutCalories: 300 },
    maintenance: { caloriesPerLb: 15, proteinPerLb: 0.97, fatPerLb: 0.48, workoutCalories: 300 },
    'mini-cut': { caloriesPerLb: 13.1, proteinPerLb: 1.06, fatPerLb: 0.42, workoutCalories: 250 },
  }[phase];
  const proteinG = Math.round(weight * formula.proteinPerLb);
  const fatG = Math.round(weight * formula.fatPerLb);
  const restCalories = weight * formula.caloriesPerLb;
  const targets = (calories: number): Macros => {
    // Round grams first, then derive kcal so the saved fields agree exactly.
    const carbsG = Math.round((calories - proteinG * 4 - fatG * 9) / 4);
    return { calories: caloriesFromMacros(carbsG, proteinG, fatG), carbsG, proteinG, fatG };
  };
  return { rest: targets(restCalories), workout: targets(restCalories + formula.workoutCalories) };
}

export interface User {
  id: number;
  email: string;
  firstName: string;
  emailVerified: boolean;
  heightInches: number;
  currentWeightLbs: number;
  targetWaistInches: number | null;
  targetCalories: number;
  targetCarbsG: number;
  targetProteinG: number;
  targetFatG: number;
  workoutTargetCalories: number;
  workoutTargetCarbsG: number;
  workoutTargetProteinG: number;
  workoutTargetFatG: number;
}

export interface FoodMeasure {
  label: string;
  gramWeight: number;
}

export interface Food {
  id: number;
  user_id: number | null;
  name: string;
  brand: string | null;
  barcode: string | null;
  serving_size: number;
  serving_unit: string;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  source: string;
  source_id: string | null;
  measures: string | null;
}

export interface ExternalFood {
  name: string;
  brand: string | null;
  barcode: string | null;
  servingSize: number;
  servingUnit: string;
  calories: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  source: string;
  sourceId: string | null;
  measures?: FoodMeasure[];
}

export interface MealLog {
  id: number;
  user_id: number;
  date: string;
  meal_type: MealType;
  food_id: number | null;
  recipe_id: number | null;
  servings: number;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  note: string | null;
  food_name: string | null;
  food_brand: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  unit_label: string | null;
  unit_scale: number | null;
  created_at: string | null;
  recipe_name: string | null;
}

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface Recipe {
  id: number;
  user_id: number;
  name: string;
  total_servings: number;
  serving_unit: string;
  manual_calories: number | null;
  manual_carbs_g: number | null;
  manual_protein_g: number | null;
  manual_fat_g: number | null;
  ingredientCount: number;
  perServing: {
    calories: number;
    carbsG: number;
    proteinG: number;
    fatG: number;
  };
}

export interface RecipeIngredient {
  id: number;
  food_id: number;
  servings: number;
  qty: number | null;
  unit_label: string | null;
  name: string;
  brand: string | null;
  serving_size: number;
  serving_unit: string;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  measures: string | null;
}

export interface WeightLog {
  id: number;
  date: string;
  time: string;
  weight_lbs: number;
  waist_inches: number | null;
  notes: string | null;
}

import type { User, Food, ExternalFood, MealLog, Recipe, RecipeIngredient, WeightLog } from './types';
import { type IngredientRow, type Macros, macrosOf, scaleMacros, recipePerServing, roundMacros } from '../server/src/nutrition';

const GUEST_KEY = 'guest_mode';
const SAMPLE_KEY = 'guest_sample_active';

export function isGuestMode(): boolean {
  return localStorage.getItem(GUEST_KEY) === 'true';
}

export function setGuestMode(enabled: boolean) {
  if (enabled) localStorage.setItem(GUEST_KEY, 'true');
  else localStorage.removeItem(GUEST_KEY);
}

export function clearGuestData() {
  localStorage.removeItem(GUEST_KEY);
  localStorage.removeItem('guest_user');
  localStorage.removeItem('guest_foods');
  localStorage.removeItem('guest_meals');
  localStorage.removeItem('guest_recipes');
  localStorage.removeItem('guest_recipe_ingredients');
  localStorage.removeItem('guest_weight');
  localStorage.removeItem('guest_workout_days');
  localStorage.removeItem('guest_next_id');
  localStorage.removeItem(SAMPLE_KEY);
}

export function hasSampleData(): boolean {
  return localStorage.getItem(SAMPLE_KEY) === 'true';
}

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Seed a fresh guest with a day's worth of realistic foods, meals, and a
// weight log so the dashboard isn't empty on first visit. Items are tagged
// with a `_sample` marker so dismissSampleData() can remove just them.
export function seedSampleData() {
  if (hasSampleData()) return;
  localStorage.setItem(SAMPLE_KEY, 'true');

  const date = todayDateStr();
  const nowIso = new Date().toISOString();

  const buildFood = (data: Partial<Food> & { name: string; calories: number; carbs_g: number; protein_g: number; fat_g: number }): Food & { _sample: true } => ({
    id: nextId(),
    user_id: 0,
    name: data.name,
    brand: data.brand ?? null,
    barcode: null,
    serving_size: data.serving_size ?? 1,
    serving_unit: data.serving_unit ?? 'serving',
    calories: data.calories,
    carbs_g: data.carbs_g,
    protein_g: data.protein_g,
    fat_g: data.fat_g,
    fiber_g: 0,
    sugar_g: 0,
    source: 'sample',
    source_id: null,
    measures: null,
    _sample: true,
  });

  const yogurt   = buildFood({ name: 'Greek Yogurt (plain, nonfat)', serving_unit: 'cup', calories: 130, carbs_g: 9,  protein_g: 22, fat_g: 0  });
  const banana   = buildFood({ name: 'Banana', serving_unit: 'medium banana', calories: 105, carbs_g: 27, protein_g: 1,  fat_g: 0  });
  const chicken  = buildFood({ name: 'Grilled Chicken Breast', serving_size: 4, serving_unit: 'oz', calories: 187, carbs_g: 0,  protein_g: 35, fat_g: 4  });
  const rice     = buildFood({ name: 'Brown Rice, cooked', serving_unit: 'cup', calories: 215, carbs_g: 45, protein_g: 5,  fat_g: 2  });
  const oliveOil = buildFood({ name: 'Olive Oil', serving_unit: 'tbsp', calories: 119, carbs_g: 0,  protein_g: 0,  fat_g: 14 });
  const almonds  = buildFood({ name: 'Almonds', serving_size: 1, serving_unit: 'oz', calories: 164, carbs_g: 6,  protein_g: 6,  fat_g: 14 });

  const sampleFoods: Food[] = [yogurt, banana, chicken, rice, oliveOil, almonds];
  const existingFoods = getStore<Food[]>('guest_foods', []);
  setStore('guest_foods', [...existingFoods, ...sampleFoods]);

  const buildMeal = (mealType: MealLog['meal_type'], food: Food, servings: number): MealLog & { _sample: true } => ({
    id: nextId(),
    user_id: 0,
    date,
    meal_type: mealType,
    food_id: food.id,
    recipe_id: null,
    servings,
    ...storedMealMacros(scaleMacros(macrosOf(food), servings)),
    note: null,
    food_name: food.name,
    food_brand: null,
    serving_size: food.serving_size,
    serving_unit: food.serving_unit,
    unit_label: null,
    unit_scale: null,
    created_at: nowIso,
    recipe_name: null,
    _sample: true,
  });

  const sampleMeals: MealLog[] = [
    buildMeal('breakfast', yogurt, 1),
    buildMeal('breakfast', banana, 1),
    buildMeal('lunch', chicken, 1),
    buildMeal('lunch', rice, 1),
    buildMeal('lunch', oliveOil, 1),
    buildMeal('snack', almonds, 1),
  ];
  const existingMeals = getStore<MealLog[]>('guest_meals', []);
  setStore('guest_meals', [...existingMeals, ...sampleMeals]);

  const existingWeight = getStore<WeightLog[]>('guest_weight', []);
  const sampleWeight: WeightLog & { _sample: true } = {
    id: nextId(),
    date,
    time: '07:00',
    weight_lbs: 165,
    notes: null,
    _sample: true,
  };
  setStore('guest_weight', [...existingWeight, sampleWeight]);
}

export function dismissSampleData() {
  localStorage.removeItem(SAMPLE_KEY);
  const filter = <T extends { _sample?: boolean }>(key: string) => {
    const items = getStore<T[]>(key, []).filter((item) => !item._sample);
    setStore(key, items);
  };
  filter<Food & { _sample?: boolean }>('guest_foods');
  filter<MealLog & { _sample?: boolean }>('guest_meals');
  filter<WeightLog & { _sample?: boolean }>('guest_weight');
}

function getStore<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function setStore<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

function nextId(): number {
  const id = getStore('guest_next_id', 1);
  setStore('guest_next_id', id + 1);
  return id;
}

// The meal_logs macro columns for a logged quantity, in stored rounding, as the server stores them.
function storedMealMacros(m: Macros): Pick<MealLog, 'calories' | 'carbs_g' | 'protein_g' | 'fat_g'> {
  const stored = roundMacros(m, 'stored');
  return { calories: stored.calories, carbs_g: stored.carbsG, protein_g: stored.proteinG, fat_g: stored.fatG };
}

// What guest_recipes holds. perServing and ingredientCount are computed on read, like the
// server's recipes list; recipes saved before that may still carry stale copies of both.
type StoredRecipe = Omit<Recipe, 'perServing' | 'ingredientCount'>;

function recipeIngredients(id: number): RecipeIngredient[] {
  return getStore<Record<string, RecipeIngredient[]>>('guest_recipe_ingredients', {})[id] || [];
}

// The ingredient rows recipePerServing totals. A manual-macro recipe reports none,
// since its manual macros override the ingredient sum (as server/src/recipe-ingredients.ts).
function recipeIngredientRows(recipe: StoredRecipe): IngredientRow[] {
  if (recipe.manual_calories != null) return [];
  return recipeIngredients(recipe.id).map((ing) => ({ food: ing, servings: ing.servings }));
}

function withNutrition(recipe: StoredRecipe): Recipe {
  const ingredients = recipeIngredientRows(recipe);
  return {
    ...recipe,
    ingredientCount: ingredients.length,
    perServing: roundMacros(recipePerServing(recipe, ingredients), 'display'),
  };
}

function toIngredientRows(
  ingredients: { foodId: number; servings: number; qty?: number; unitLabel?: string }[],
): RecipeIngredient[] {
  const foods = getStore<Food[]>('guest_foods', []);
  return ingredients.map((ing) => {
    const food = foods.find((f) => f.id === ing.foodId);
    return {
      id: nextId(),
      food_id: ing.foodId,
      servings: ing.servings || 1,
      qty: ing.qty || null,
      unit_label: ing.unitLabel || null,
      name: food?.name || '',
      brand: food?.brand || null,
      serving_size: food?.serving_size || 1,
      serving_unit: food?.serving_unit || 'serving',
      calories: food?.calories || 0,
      carbs_g: food?.carbs_g || 0,
      protein_g: food?.protein_g || 0,
      fat_g: food?.fat_g || 0,
      measures: food?.measures || null,
    };
  });
}

const DEFAULT_GUEST_USER: User = {
  id: 0,
  email: '',
  firstName: 'Guest',
  emailVerified: false,
  heightInches: 0,
  currentWeightLbs: 0,
  targetCalories: 2000,
  targetCarbsG: 250,
  targetProteinG: 150,
  targetFatG: 65,
  workoutTargetCalories: 2300,
  workoutTargetCarbsG: 290,
  workoutTargetProteinG: 170,
  workoutTargetFatG: 75,
};

export function getGuestUser(): User {
  return { ...DEFAULT_GUEST_USER, ...getStore('guest_user', DEFAULT_GUEST_USER) };
}

// Auth
export const localAuth = {
  me: async (): Promise<{ user: User }> => {
    return { user: getGuestUser() };
  },

  updateProfile: async (data: Partial<User>): Promise<{ user: User }> => {
    const user = getGuestUser();
    Object.assign(user, data);
    setStore('guest_user', user);
    return { user };
  },

  logout: async (): Promise<{ success: boolean }> => {
    setGuestMode(false);
    return { success: true };
  },
};

// Foods
export const localFoods = {
  search: async (q: string): Promise<{ foods: Food[]; external: ExternalFood[] }> => {
    const all = getStore<Food[]>('guest_foods', []);
    const query = q.toLowerCase();
    const foods = all.filter(
      (f) => f.name.toLowerCase().includes(query) || (f.brand && f.brand.toLowerCase().includes(query))
    );
    return { foods, external: [] };
  },

  barcode: async (_code: string): Promise<{ food: Food }> => {
    throw new Error('Barcode lookup requires an account');
  },

  recent: async (): Promise<{ foods: Food[] }> => {
    const foods = getStore<Food[]>('guest_foods', []);
    return { foods: [...foods].reverse().slice(0, 20) };
  },

  custom: async (): Promise<{ foods: Food[] }> => {
    return { foods: getStore<Food[]>('guest_foods', []) };
  },

  create: async (data: Partial<Food>): Promise<{ food: Food }> => {
    const foods = getStore<Food[]>('guest_foods', []);
    const food: Food = {
      id: nextId(),
      user_id: 0,
      name: data.name || '',
      brand: data.brand || null,
      barcode: data.barcode || null,
      serving_size: data.serving_size || 1,
      serving_unit: data.serving_unit || 'serving',
      calories: data.calories || 0,
      carbs_g: data.carbs_g || 0,
      protein_g: data.protein_g || 0,
      fat_g: data.fat_g || 0,
      fiber_g: data.fiber_g || 0,
      sugar_g: data.sugar_g || 0,
      source: 'manual',
      source_id: null,
      measures: data.measures || null,
    };
    foods.push(food);
    setStore('guest_foods', foods);
    return { food };
  },

  saveExternal: async (_data: ExternalFood): Promise<{ food: Food }> => {
    throw new Error('External food database requires an account');
  },

  saveExternalToLocal: async (data: ExternalFood): Promise<{ food: Food }> => {
    const foods = getStore<Food[]>('guest_foods', []);
    const food: Food = {
      id: nextId(),
      user_id: 0,
      name: data.name,
      brand: data.brand || null,
      barcode: data.barcode || null,
      serving_size: data.servingSize || 1,
      serving_unit: data.servingUnit || 'serving',
      calories: data.calories || 0,
      carbs_g: data.carbsG || 0,
      protein_g: data.proteinG || 0,
      fat_g: data.fatG || 0,
      fiber_g: data.fiberG || 0,
      sugar_g: data.sugarG || 0,
      source: data.source || 'manual',
      source_id: data.sourceId || null,
      measures: data.measures ? JSON.stringify(data.measures) : null,
    };
    foods.push(food);
    setStore('guest_foods', foods);
    return { food };
  },

  delete: async (id: number): Promise<{ success: boolean }> => {
    const foods = getStore<Food[]>('guest_foods', []).filter((f) => f.id !== id);
    setStore('guest_foods', foods);
    return { success: true };
  },
};

// Meals
export const localMeals = {
  getByDate: async (date: string): Promise<{ meals: MealLog[] }> => {
    const all = getStore<MealLog[]>('guest_meals', []);
    return { meals: all.filter((m) => m.date === date) };
  },

  getTotals: async (
    startDate: string,
    endDate: string
  ): Promise<{
    totals: { date: string; total_calories: number; total_carbs: number; total_protein: number; total_fat: number }[];
  }> => {
    const all = getStore<MealLog[]>('guest_meals', []);
    const byDate: Record<string, { total_calories: number; total_carbs: number; total_protein: number; total_fat: number }> = {};
    for (const m of all) {
      if (m.date >= startDate && m.date <= endDate) {
        if (!byDate[m.date]) byDate[m.date] = { total_calories: 0, total_carbs: 0, total_protein: 0, total_fat: 0 };
        byDate[m.date].total_calories += m.calories;
        byDate[m.date].total_carbs += m.carbs_g;
        byDate[m.date].total_protein += m.protein_g;
        byDate[m.date].total_fat += m.fat_g;
      }
    }
    return { totals: Object.entries(byDate).map(([date, t]) => ({ date, ...t })) };
  },

  log: async (data: {
    date: string;
    mealType: string;
    foodId?: number;
    recipeId?: number;
    servings?: number;
    calories?: number;
    carbsG?: number;
    proteinG?: number;
    fatG?: number;
    note?: string;
    unitLabel?: string;
    unitScale?: number;
  }): Promise<{ meal: MealLog }> => {
    const meals = getStore<MealLog[]>('guest_meals', []);
    const servings = data.servings || 1;
    let macros: Macros = {
      calories: data.calories || 0,
      carbsG: data.carbsG || 0,
      proteinG: data.proteinG || 0,
      fatG: data.fatG || 0,
    };
    let food_name: string | null = null;
    let food_brand: string | null = null;
    let serving_size: number | null = null;
    let serving_unit: string | null = null;
    let recipe_name: string | null = null;

    if (data.foodId) {
      const foods = getStore<Food[]>('guest_foods', []);
      const food = foods.find((f) => f.id === data.foodId);
      if (food) {
        macros = scaleMacros(macrosOf(food), servings);
        food_name = food.name;
        food_brand = food.brand;
        serving_size = food.serving_size;
        serving_unit = food.serving_unit;
      }
    }

    if (data.recipeId) {
      const recipes = getStore<StoredRecipe[]>('guest_recipes', []);
      const recipe = recipes.find((r) => r.id === data.recipeId);
      if (recipe) {
        macros = scaleMacros(recipePerServing(recipe, recipeIngredientRows(recipe)), servings);
        recipe_name = recipe.name;
      }
    }

    const meal: MealLog = {
      id: nextId(),
      user_id: 0,
      date: data.date,
      meal_type: data.mealType as MealLog['meal_type'],
      food_id: data.foodId || null,
      recipe_id: data.recipeId || null,
      servings,
      ...storedMealMacros(macros),
      note: data.note || null,
      food_name,
      food_brand,
      serving_size,
      serving_unit,
      unit_label: data.unitLabel || null,
      unit_scale: data.unitScale || null,
      created_at: new Date().toISOString(),
      recipe_name,
    };
    meals.push(meal);
    setStore('guest_meals', meals);
    return { meal };
  },

  quickLog: async (data: {
    date: string;
    mealType: string;
    name?: string;
    calories?: number;
    carbsG?: number;
    proteinG?: number;
    fatG?: number;
  }): Promise<{ meal: MealLog }> => {
    const meals = getStore<MealLog[]>('guest_meals', []);
    const meal: MealLog = {
      id: nextId(),
      user_id: 0,
      date: data.date,
      meal_type: data.mealType as MealLog['meal_type'],
      food_id: null,
      recipe_id: null,
      servings: 1,
      calories: data.calories || 0,
      carbs_g: data.carbsG || 0,
      protein_g: data.proteinG || 0,
      fat_g: data.fatG || 0,
      note: data.name || null,
      food_name: null,
      food_brand: null,
      serving_size: null,
      serving_unit: null,
      unit_label: null,
      unit_scale: null,
      created_at: new Date().toISOString(),
      recipe_name: null,
    };
    meals.push(meal);
    setStore('guest_meals', meals);
    return { meal };
  },

  update: async (
    id: number,
    data: { servings?: number; mealType?: string; calories?: number; carbsG?: number; proteinG?: number; fatG?: number }
  ): Promise<{ meal: MealLog }> => {
    const meals = getStore<MealLog[]>('guest_meals', []);
    const meal = meals.find((m) => m.id === id);
    if (!meal) throw new Error('Meal not found');
    if (data.servings !== undefined) meal.servings = data.servings;
    if (data.mealType !== undefined) meal.meal_type = data.mealType as MealLog['meal_type'];
    if (data.calories !== undefined) meal.calories = data.calories;
    if (data.carbsG !== undefined) meal.carbs_g = data.carbsG;
    if (data.proteinG !== undefined) meal.protein_g = data.proteinG;
    if (data.fatG !== undefined) meal.fat_g = data.fatG;
    setStore('guest_meals', meals);
    return { meal };
  },

  delete: async (id: number): Promise<{ success: boolean }> => {
    const meals = getStore<MealLog[]>('guest_meals', []).filter((m) => m.id !== id);
    setStore('guest_meals', meals);
    return { success: true };
  },

  copy: async (fromDate: string, toDate: string): Promise<{ copied: number }> => {
    const meals = getStore<MealLog[]>('guest_meals', []);
    const toCopy = meals.filter((m) => m.date === fromDate);
    if (toCopy.length === 0) throw new Error('No meals to copy');
    for (const m of toCopy) {
      meals.push({ ...m, id: nextId(), date: toDate });
    }
    setStore('guest_meals', meals);
    return { copied: toCopy.length };
  },
};

// Recipes
export const localRecipes = {
  list: async (): Promise<{ recipes: Recipe[] }> => {
    return { recipes: getStore<StoredRecipe[]>('guest_recipes', []).map(withNutrition) };
  },

  get: async (id: number): Promise<{ recipe: Recipe; ingredients: RecipeIngredient[] }> => {
    const recipes = getStore<StoredRecipe[]>('guest_recipes', []);
    const recipe = recipes.find((r) => r.id === id);
    if (!recipe) throw new Error('Recipe not found');
    return { recipe: withNutrition(recipe), ingredients: recipeIngredients(id) };
  },

  create: async (data: {
    name: string;
    totalServings: number;
    servingUnit?: string;
    ingredients: { foodId: number; servings: number; qty?: number; unitLabel?: string }[];
    manualCalories?: number | null;
    manualCarbsG?: number | null;
    manualProteinG?: number | null;
    manualFatG?: number | null;
  }): Promise<{ recipe: { id: number } }> => {
    const recipes = getStore<StoredRecipe[]>('guest_recipes', []);
    const id = nextId();
    const ingredients = toIngredientRows(data.ingredients);

    const recipe: StoredRecipe = {
      id,
      user_id: 0,
      name: data.name,
      total_servings: data.totalServings || 1,
      serving_unit: data.servingUnit || 'serving',
      manual_calories: data.manualCalories ?? null,
      manual_carbs_g: data.manualCarbsG ?? null,
      manual_protein_g: data.manualProteinG ?? null,
      manual_fat_g: data.manualFatG ?? null,
    };

    recipes.push(recipe);
    setStore('guest_recipes', recipes);
    const allIngredients = getStore<Record<string, RecipeIngredient[]>>('guest_recipe_ingredients', {});
    allIngredients[id] = ingredients;
    setStore('guest_recipe_ingredients', allIngredients);

    return { recipe: { id } };
  },

  update: async (
    id: number,
    data: {
      name?: string;
      totalServings?: number;
      servingUnit?: string;
      ingredients?: { foodId: number; servings: number; qty?: number; unitLabel?: string }[];
      manualCalories?: number | null;
      manualCarbsG?: number | null;
      manualProteinG?: number | null;
      manualFatG?: number | null;
    }
  ): Promise<{ success: boolean }> => {
    const recipes = getStore<StoredRecipe[]>('guest_recipes', []);
    const idx = recipes.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error('Recipe not found');
    const recipe = recipes[idx];

    if (data.name !== undefined) recipe.name = data.name;
    if (data.totalServings !== undefined) recipe.total_servings = data.totalServings;
    if (data.servingUnit !== undefined) recipe.serving_unit = data.servingUnit;
    if (data.manualCalories !== undefined) recipe.manual_calories = data.manualCalories;
    if (data.manualCarbsG !== undefined) recipe.manual_carbs_g = data.manualCarbsG;
    if (data.manualProteinG !== undefined) recipe.manual_protein_g = data.manualProteinG;
    if (data.manualFatG !== undefined) recipe.manual_fat_g = data.manualFatG;

    if (data.ingredients !== undefined) {
      const allIngredients = getStore<Record<string, RecipeIngredient[]>>('guest_recipe_ingredients', {});
      allIngredients[id] = toIngredientRows(data.ingredients);
      setStore('guest_recipe_ingredients', allIngredients);
    }

    recipes[idx] = recipe;
    setStore('guest_recipes', recipes);
    return { success: true };
  },

  delete: async (id: number): Promise<{ success: boolean }> => {
    const recipes = getStore<StoredRecipe[]>('guest_recipes', []).filter((r) => r.id !== id);
    setStore('guest_recipes', recipes);
    const allIngredients = getStore<Record<string, RecipeIngredient[]>>('guest_recipe_ingredients', {});
    delete allIngredients[id];
    setStore('guest_recipe_ingredients', allIngredients);
    return { success: true };
  },

  copy: async (id: number): Promise<{ recipe: { id: number } }> => {
    const recipes = getStore<StoredRecipe[]>('guest_recipes', []);
    const original = recipes.find((r) => r.id === id);
    if (!original) throw new Error('Recipe not found');
    const allIngredients = getStore<Record<string, RecipeIngredient[]>>('guest_recipe_ingredients', {});
    const origIngs = allIngredients[id] || [];

    const newId = nextId();
    const newRecipe: StoredRecipe = {
      ...original,
      id: newId,
      name: original.name + ' (Copy)',
    };

    const newIngs = origIngs.map((ing) => ({ ...ing, id: nextId() }));

    recipes.push(newRecipe);
    setStore('guest_recipes', recipes);
    allIngredients[newId] = newIngs;
    setStore('guest_recipe_ingredients', allIngredients);

    return { recipe: { id: newId } };
  },
};

// Weight
export const localWeight = {
  list: async (limit?: number): Promise<{ logs: WeightLog[] }> => {
    let logs = getStore<WeightLog[]>('guest_weight', []);
    logs.sort((a, b) => {
      const cmp = b.date.localeCompare(a.date);
      if (cmp !== 0) return cmp;
      return (b.time || '').localeCompare(a.time || '');
    });
    if (limit) logs = logs.slice(0, limit);
    return { logs };
  },

  log: async (date: string, weightLbs: number, time?: string, notes?: string): Promise<{ log: WeightLog }> => {
    const logs = getStore<WeightLog[]>('guest_weight', []);
    const timeVal = time || '';
    const existing = logs.findIndex((l) => l.date === date && (l.time || '') === timeVal);
    const log: WeightLog = {
      id: existing >= 0 ? logs[existing].id : nextId(),
      date,
      time: timeVal,
      weight_lbs: weightLbs,
      notes: notes || null,
    };
    if (existing >= 0) logs[existing] = log;
    else logs.push(log);
    setStore('guest_weight', logs);
    return { log };
  },

  delete: async (id: number): Promise<{ success: boolean }> => {
    const logs = getStore<WeightLog[]>('guest_weight', []).filter((l) => l.id !== id);
    setStore('guest_weight', logs);
    return { success: true };
  },
};

// Workout days
export const localWorkoutDays = {
  get: async (date: string): Promise<{ isWorkoutDay: boolean }> => {
    const days = getStore<Record<string, boolean>>('guest_workout_days', {});
    return { isWorkoutDay: !!days[date] };
  },

  set: async (date: string, isWorkoutDay: boolean): Promise<{ isWorkoutDay: boolean }> => {
    const days = getStore<Record<string, boolean>>('guest_workout_days', {});
    if (isWorkoutDay) days[date] = true;
    else delete days[date];
    setStore('guest_workout_days', days);
    return { isWorkoutDay };
  },
};

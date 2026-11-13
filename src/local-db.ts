import type { User, Food, ExternalFood, MealLog, Recipe, RecipeIngredient, WeightLog, WeightLogInput } from './types';
import { type IngredientRow, type Macros, macrosOf, scaleMacros, recipePerServing, roundMacros } from '../server/src/nutrition';
import { isWaistInches } from '../server/src/waist';
import { dailyCheckValidationError, type DailyCheckKey } from '../server/src/daily-checks';

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
  localStorage.removeItem('guest_recipe_state');
  localStorage.removeItem('guest_recipes');
  localStorage.removeItem('guest_recipe_ingredients');
  localStorage.removeItem('guest_weight');
  localStorage.removeItem('guest_workout_days');
  localStorage.removeItem('guest_daily_checks');
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
    waist_inches: null,
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

// Persisted metadata. perServing and ingredientCount are computed on read, like the
// server's recipes list; recipes saved before that may still carry stale copies of both.
type StoredRecipe = Omit<Recipe, 'perServing' | 'ingredientCount'>;

const RECIPE_STATE_KEY = 'guest_recipe_state';

interface GuestRecipeState {
  version: 1;
  recipes: StoredRecipe[];
  ingredients: Record<string, RecipeIngredient[]>;
  nextId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function invalidRecipeState(): never {
  throw new Error('Invalid guest Recipe storage');
}

// Validate structure and allocation without normalizing legacy values (including zero).
function recipeCollections(recipes: unknown, ingredients: unknown) {
  if (!Array.isArray(recipes) || !isRecord(ingredients)) invalidRecipeState();
  let greatestId = 0;
  const identities = new Set<number>();
  const retainIdentity = (value: unknown) => {
    if (!isIdentity(value) || identities.has(value)) invalidRecipeState();
    identities.add(value);
    greatestId = Math.max(greatestId, value);
  };
  const numericFields = (row: Record<string, unknown>, fields: string[]) => {
    for (const field of fields) {
      const value = row[field];
      if (value != null && (typeof value !== 'number' || !Number.isFinite(value))) invalidRecipeState();
    }
  };
  const stringFields = (row: Record<string, unknown>, fields: string[]) => {
    for (const field of fields) {
      if (row[field] != null && typeof row[field] !== 'string') invalidRecipeState();
    }
  };
  for (const recipe of recipes) {
    if (!isRecord(recipe) || typeof recipe.name !== 'string') invalidRecipeState();
    retainIdentity(recipe.id);
    numericFields(recipe, ['user_id', 'total_servings', 'manual_calories', 'manual_carbs_g', 'manual_protein_g', 'manual_fat_g']);
    stringFields(recipe, ['serving_unit']);
  }
  for (const [key, occurrences] of Object.entries(ingredients)) {
    const recipeId = Number(key);
    if (!isIdentity(recipeId) || String(recipeId) !== key || !Array.isArray(occurrences)) invalidRecipeState();
    greatestId = Math.max(greatestId, recipeId);
    for (const occurrence of occurrences) {
      if (!isRecord(occurrence) || !isIdentity(occurrence.food_id) || typeof occurrence.name !== 'string') invalidRecipeState();
      retainIdentity(occurrence.id);
      numericFields(occurrence, ['servings', 'qty', 'serving_size', 'calories', 'carbs_g', 'protein_g', 'fat_g']);
      stringFields(occurrence, ['unit_label', 'brand', 'serving_unit', 'measures']);
    }
  }
  return {
    recipes: recipes as StoredRecipe[],
    ingredients: ingredients as Record<string, RecipeIngredient[]>,
    greatestId,
  };
}

function readRecipeValue(key: string, fallback: unknown): unknown {
  const value = localStorage.getItem(key);
  return value === null ? fallback : JSON.parse(value);
}

// Every operation loads a detached state; reads never migrate or cache it.
function loadRecipeState(): GuestRecipeState {
  const canonical = localStorage.getItem(RECIPE_STATE_KEY);
  if (canonical !== null) {
    const state: unknown = JSON.parse(canonical);
    if (!isRecord(state) || state.version !== 1 || !isIdentity(state.nextId)) invalidRecipeState();
    const { recipes, ingredients, greatestId } = recipeCollections(state.recipes, state.ingredients);
    if (state.nextId <= greatestId) invalidRecipeState();
    return { version: 1, recipes, ingredients, nextId: state.nextId };
  }

  const { recipes, ingredients, greatestId } = recipeCollections(
    readRecipeValue('guest_recipes', []), readRecipeValue('guest_recipe_ingredients', {}),
  );
  const legacyNextId = readRecipeValue('guest_next_id', 1);
  if (!isIdentity(legacyNextId) || greatestId >= Number.MAX_SAFE_INTEGER) invalidRecipeState();
  return { version: 1, recipes, ingredients, nextId: Math.max(legacyNextId, greatestId + 1) };
}

function allocateRecipeIdentity(state: GuestRecipeState): number {
  if (state.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('Guest Recipe identities exhausted');
  return state.nextId++;
}

function commitRecipeState(state: GuestRecipeState) {
  setStore(RECIPE_STATE_KEY, state);
  // Cleanup cannot undo a committed operation or turn it into a rejection.
  for (const key of ['guest_recipes', 'guest_recipe_ingredients']) {
    try { localStorage.removeItem(key); } catch { /* The canonical record is authoritative. */ }
  }
}

// The ingredient rows recipePerServing totals. A manual-macro recipe reports none,
// since its manual macros override the ingredient sum (as server/src/recipe-ingredients.ts).
function recipeIngredientRows(state: GuestRecipeState, recipe: StoredRecipe): IngredientRow[] {
  if (recipe.manual_calories != null) return [];
  // A missing servings field is a legacy row. Zero is a real count and must reach recipePerServing, as the server read does.
  return (state.ingredients[recipe.id] || []).map((ing) => ({ food: ing, servings: ing.servings ?? 1 }));
}

function withNutrition(state: GuestRecipeState, recipe: StoredRecipe): Recipe {
  const ingredients = recipeIngredientRows(state, recipe);
  return {
    ...recipe,
    ingredientCount: ingredients.length,
    perServing: roundMacros(recipePerServing(recipe, ingredients), 'display'),
  };
}

// Synchronous so Meal logging keeps its existing read-modify-write sequence.
function recipeForMeal(id: number, servings: number): { name: string; macros: Macros } | undefined {
  const state = loadRecipeState();
  const recipe = state.recipes.find(recipe => recipe.id === id);
  if (!recipe) return undefined;
  return { name: recipe.name, macros: scaleMacros(recipePerServing(recipe, recipeIngredientRows(state, recipe)), servings) };
}

// One ingredient as the recipe editor sends it.
type IngredientInput = { foodId: number; servings: number; qty?: number; unitLabel?: string };

function buildRecipeIngredients(state: GuestRecipeState, ingredients: IngredientInput[]): RecipeIngredient[] {
  const foods = getStore<Food[]>('guest_foods', []);
  return ingredients.map((ing) => {
    const food = foods.find((f) => f.id === ing.foodId);
    return {
      id: allocateRecipeIdentity(state),
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
  targetWaistInches: null,
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
    if (data.targetWaistInches != null && !isWaistInches(data.targetWaistInches)) {
      throw new Error('Waist ceiling must be a number between 20 and 60 inches');
    }
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
      const recipe = recipeForMeal(data.recipeId, servings);
      if (recipe) {
        macros = recipe.macros;
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
    const state = loadRecipeState();
    return { recipes: state.recipes.map(recipe => withNutrition(state, recipe)) };
  },

  get: async (id: number): Promise<{ recipe: Recipe; ingredients: RecipeIngredient[] }> => {
    const state = loadRecipeState();
    const recipe = state.recipes.find((r) => r.id === id);
    if (!recipe) throw new Error('Recipe not found');
    return { recipe: withNutrition(state, recipe), ingredients: state.ingredients[id] || [] };
  },

  create: async (data: {
    name: string;
    totalServings: number;
    servingUnit?: string;
    ingredients: IngredientInput[];
    manualCalories?: number | null;
    manualCarbsG?: number | null;
    manualProteinG?: number | null;
    manualFatG?: number | null;
  }): Promise<{ recipe: { id: number } }> => {
    const state = loadRecipeState();
    const id = allocateRecipeIdentity(state);
    const ingredients = buildRecipeIngredients(state, data.ingredients);

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

    state.recipes.push(recipe);
    state.ingredients[id] = ingredients;
    commitRecipeState(state);

    return { recipe: { id } };
  },

  update: async (
    id: number,
    data: {
      name?: string;
      totalServings?: number;
      servingUnit?: string;
      ingredients?: IngredientInput[];
      manualCalories?: number | null;
      manualCarbsG?: number | null;
      manualProteinG?: number | null;
      manualFatG?: number | null;
    }
  ): Promise<{ success: boolean }> => {
    const state = loadRecipeState();
    const idx = state.recipes.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error('Recipe not found');
    const recipe = state.recipes[idx];

    if (data.name !== undefined) recipe.name = data.name;
    if (data.totalServings !== undefined) recipe.total_servings = data.totalServings;
    if (data.servingUnit !== undefined) recipe.serving_unit = data.servingUnit;
    if (data.manualCalories !== undefined) recipe.manual_calories = data.manualCalories;
    if (data.manualCarbsG !== undefined) recipe.manual_carbs_g = data.manualCarbsG;
    if (data.manualProteinG !== undefined) recipe.manual_protein_g = data.manualProteinG;
    if (data.manualFatG !== undefined) recipe.manual_fat_g = data.manualFatG;

    if (data.ingredients !== undefined) {
      state.ingredients[id] = buildRecipeIngredients(state, data.ingredients);
    }

    commitRecipeState(state);
    return { success: true };
  },

  delete: async (id: number): Promise<{ success: boolean }> => {
    const state = loadRecipeState();
    state.recipes = state.recipes.filter((r) => r.id !== id);
    delete state.ingredients[id];
    commitRecipeState(state);
    return { success: true };
  },

  copy: async (id: number): Promise<{ recipe: { id: number } }> => {
    const state = loadRecipeState();
    const original = state.recipes.find((r) => r.id === id);
    if (!original) throw new Error('Recipe not found');
    // Drop the stale perServing and ingredientCount a recipe saved before they moved to read time may carry.
    const { perServing: _perServing, ingredientCount: _ingredientCount, ...stored } = original as Partial<Recipe> & StoredRecipe;

    const newId = allocateRecipeIdentity(state);
    const newRecipe: StoredRecipe = {
      ...stored,
      id: newId,
      name: original.name + ' (Copy)',
    };

    const newIngs = (state.ingredients[id] || []).map((ing) => ({ ...ing, id: allocateRecipeIdentity(state) }));

    state.recipes.push(newRecipe);
    state.ingredients[newId] = newIngs;
    commitRecipeState(state);

    return { recipe: { id: newId } };
  },
};

// Weight
export const localWeight = {
  list: async (limit?: number): Promise<{ logs: WeightLog[] }> => {
    let logs = getStore<WeightLog[]>('guest_weight', []).map((log) => ({
      ...log, waist_inches: log.waist_inches ?? null,
    }));
    logs.sort((a, b) => {
      const cmp = b.date.localeCompare(a.date);
      if (cmp !== 0) return cmp;
      return (b.time || '').localeCompare(a.time || '');
    });
    if (limit) logs = logs.slice(0, limit);
    return { logs };
  },

  log: async ({ date, weightLbs, time, notes, waistInches }: WeightLogInput): Promise<{ log: WeightLog }> => {
    if (waistInches != null && !isWaistInches(waistInches)) {
      throw new Error('Waist must be a number between 20 and 60 inches');
    }
    const logs = getStore<WeightLog[]>('guest_weight', []);
    const timeVal = time || '';
    const existing = logs.findIndex((l) => l.date === date && (l.time || '') === timeVal);
    const log: WeightLog = {
      id: existing >= 0 ? logs[existing].id : nextId(),
      date,
      time: timeVal,
      weight_lbs: weightLbs,
      waist_inches: waistInches ?? null,
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

// Daily checks
export const localDailyChecks = {
  get: async (date: string): Promise<{ checks: string[] }> => {
    const days = getStore<Record<string, string[]>>('guest_daily_checks', {});
    return { checks: days[date] ?? [] };
  },

  set: async (date: string, key: DailyCheckKey, checked: boolean): Promise<{ checks: string[] }> => {
    const error = dailyCheckValidationError(key, checked);
    if (error) throw new Error(error);
    const days = getStore<Record<string, string[]>>('guest_daily_checks', {});
    const checks = new Set(days[date] ?? []);
    if (checked) checks.add(key);
    else checks.delete(key);
    days[date] = [...checks].sort();
    setStore('guest_daily_checks', days);
    return { checks: days[date] };
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

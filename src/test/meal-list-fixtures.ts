import type { MealLog } from '../types';

export function meal(overrides: Partial<MealLog> = {}): MealLog {
  return {
    id: 1,
    user_id: 1,
    date: '2026-04-01',
    meal_type: 'breakfast',
    food_id: 1,
    recipe_id: null,
    servings: 2,
    calories: 200,
    carbs_g: 20,
    protein_g: 10,
    fat_g: 8,
    note: null,
    food_name: 'Apple',
    food_brand: null,
    serving_size: 100,
    serving_unit: 'g',
    unit_label: null,
    unit_scale: 1,
    created_at: null,
    recipe_name: null,
    ...overrides,
  };
}

export function swipe(item = document.querySelector<HTMLElement>('.meal-item')!) {
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 50, clientY: 10 }));
}

export async function settleMealPersistence() {
  // Drain the HTTP response decoding and the mounted completion.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

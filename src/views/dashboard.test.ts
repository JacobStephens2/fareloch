import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { meals, workoutDays } from '../api';
import { route, startRouter } from '../router';
import type { MealLog } from '../types';
import { dashboardView } from './dashboard';

vi.mock('../api', () => ({
  meals: { getByDate: vi.fn(), update: vi.fn(), delete: vi.fn(), copy: vi.fn() },
  workoutDays: { get: vi.fn(), set: vi.fn() },
}));

function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

function meal(overrides: Partial<MealLog> = {}): MealLog {
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

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/', dashboardView);
  route('/other', () => ({ html: '<p>Other view</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(workoutDays.get).mockResolvedValue({ isWorkoutDay: false });
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [] });
  go('/other');
});

afterEach(() => {
  go('/other');
});

it('edit meal modal shows a saved measure label as text on the per-unit line and the quantity label', async () => {
  const label = 'cup<img alt="measure">';
  vi.mocked(meals.getByDate).mockResolvedValue({
    meals: [meal({ unit_label: label })],
  });

  go('/');
  await vi.waitFor(() => {
    expect(document.querySelector('.meal-item')).toBeTruthy();
  });

  const item = document.querySelector<HTMLElement>('.meal-item')!;
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 10, clientY: 10 }));

  const modal = document.querySelector('#edit-meal-modal')!;
  expect(modal.classList.contains('hidden')).toBe(false);
  expect(modal.querySelector('img')).toBeNull();
  expect(modal.querySelector('p.text-muted')!.textContent).toBe(`Per ${label}`);
  expect(modal.querySelector('label[for="edit-servings"]')!.textContent).toBe(label);
});

it('edit meal modal shows a saved food brand as text', async () => {
  const brand = 'Acme<img alt="brand">';
  vi.mocked(meals.getByDate).mockResolvedValue({
    meals: [meal({ food_brand: brand })],
  });

  go('/');
  await vi.waitFor(() => {
    expect(document.querySelector('.meal-item')).toBeTruthy();
  });

  const item = document.querySelector<HTMLElement>('.meal-item')!;
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 10, clientY: 10 }));

  const modal = document.querySelector('#edit-meal-modal')!;
  expect(modal.classList.contains('hidden')).toBe(false);
  expect(modal.querySelector('img')).toBeNull();
  expect(modal.querySelector('.food-brand')!.textContent).toBe(brand);
});

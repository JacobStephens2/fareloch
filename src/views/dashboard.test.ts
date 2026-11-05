import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { meals, workoutDays } from '../api';
import { route, startRouter } from '../router';
import { state } from '../state';
import type { MealLog } from '../types';
import { dashboardView } from './dashboard';

vi.mock('../api', () => ({
  meals: { getByDate: vi.fn(), update: vi.fn(), delete: vi.fn(), copy: vi.fn() },
  workoutDays: { get: vi.fn(), set: vi.fn() },
  dailyChecks: { get: async () => ({ checks: [] }), set: vi.fn() },
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
  state.user = null;
  state.selectedDate = '2026-04-01';
  vi.mocked(workoutDays.get).mockResolvedValue({ isWorkoutDay: false });
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [] });
  go('/other');
});

afterEach(() => {
  go('/other');
});

async function showMealItem(entry: MealLog): Promise<HTMLElement> {
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [entry] });
  go('/');
  await vi.waitFor(() => {
    expect(document.querySelector('.meal-item')).toBeTruthy();
  });
  return document.querySelector<HTMLElement>('.meal-item')!;
}

async function openEditMealModal(entry: MealLog): Promise<Element> {
  const item = await showMealItem(entry);
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 10, clientY: 10 }));

  const modal = document.querySelector('#edit-meal-modal')!;
  expect(modal.classList.contains('hidden')).toBe(false);
  return modal;
}

it('edit meal modal shows a saved measure label as text on the per-unit line and the quantity label', async () => {
  const label = 'cup<img alt="measure">';
  const modal = await openEditMealModal(meal({ unit_label: label }));
  expect(modal.querySelector('img')).toBeNull();
  expect(modal.querySelector('p.text-muted')!.textContent).toBe(`Per ${label}`);
  expect(modal.querySelector('label[for="edit-servings"]')!.textContent).toBe(label);
});

it('edit meal modal shows a saved food brand as text', async () => {
  const brand = 'Acme<img alt="brand">';
  const modal = await openEditMealModal(meal({ food_brand: brand }));
  expect(modal.querySelector('img')).toBeNull();
  expect(modal.querySelector('.food-brand')!.textContent).toBe(brand);
});

it('dashboard meal list shows a logged meal name as text', async () => {
  const name = 'Apple<img alt="name">';
  const item = await showMealItem(meal({ food_name: name, servings: 1 }));
  expect(item.querySelector('img')).toBeNull();
  expect(item.querySelector('.meal-item-name')!.textContent).toBe(name);
});

it('dashboard meal list shows a logged meal brand as text', async () => {
  const brand = 'Acme<img alt="brand">';
  const item = await showMealItem(meal({ food_brand: brand, servings: 1 }));
  expect(item.querySelector('img')).toBeNull();
  expect(item.querySelector('.food-brand')!.textContent).toBe(brand);
});

it('dashboard keeps a high-calorie, low-protein meal partial', async () => {
  const item = await showMealItem(meal({ calories: 650, protein_g: 6 }));
  const section = item.closest('.meal-section')!;
  expect(section.classList.contains('partial')).toBe(true);
  expect(section.querySelector('.meal-macro-chips .chip-protein-hit')).toBeNull();
});

it('dashboard highlights a lean protein-pulse snack while its meal remains partial', async () => {
  const item = await showMealItem(meal({ meal_type: 'snack', calories: 200, protein_g: 31.9 }));
  const section = item.closest('.meal-section')!;
  expect(section.classList.contains('partial')).toBe(true);
  expect(section.querySelector('.meal-macro-chips .chip-protein')!.classList.contains('chip-protein-hit')).toBe(true);
  expect(item.querySelector('.chip-protein-hit')).toBeNull();
});

it.each([
  ['both targets at 85%', 550.4, 31.9, 'on-track', true],
  ['calories just below 85%', 550.3, 31.9, 'partial', true],
  ['protein just below 85%', 650, 31.8, 'partial', false],
  ['both targets below 50%', 100, 5, 'low', false],
  ['all-zero logged macros', 0, 0, '', false],
])('dashboard renders %s against unrounded daily / 4 targets', async (_label, calories, protein, status, proteinHit) => {
  const item = await showMealItem(meal({ calories, protein_g: protein, carbs_g: 0, fat_g: 0 }));
  const section = item.closest('.meal-section')!;
  expect(section.className.trim()).toBe(`meal-section ${status}`.trim());
  expect(section.querySelector('.meal-macro-chips .chip-protein')!.classList.contains('chip-protein-hit')).toBe(proteinHit);
});

it('dashboard leaves empty meals without a status or macro chips', async () => {
  go('/');
  await vi.waitFor(() => expect(document.querySelectorAll('.meal-empty')).toHaveLength(4));
  expect([...document.querySelectorAll('.meal-section')].every(section => section.className.trim() === 'meal-section')).toBe(true);
  expect(document.querySelector('.meal-macro-chips')).toBeNull();
});

it('dashboard sums logged foods before assessing the meal protein pulse', async () => {
  vi.mocked(meals.getByDate).mockResolvedValue({ meals: [
    meal({ calories: 300, protein_g: 20 }),
    meal({ id: 2, calories: 300, protein_g: 20 }),
  ] });
  go('/');
  await vi.waitFor(() => expect(document.querySelectorAll('.meal-item')).toHaveLength(2));
  const section = document.querySelector('.meal-section')!;
  expect(section.classList.contains('on-track')).toBe(true);
  expect(section.querySelector('.meal-macro-chips .chip-protein-hit')!.textContent).toBe('40/38p');
});

it('dashboard legend explains the calorie and protein thresholds and the protein highlight', () => {
  const legend = document.createElement('div');
  legend.innerHTML = dashboardView().html;
  const descriptions = [...legend.querySelectorAll('.dashboard-legend p')].map(p => p.textContent);
  expect(descriptions).toEqual([
    ' On track - both calories and protein reach 85%+ of per-meal targets (daily / 4)',
    ' Partial - either calories or protein reaches 50%+, but not both reach 85%',
    ' Low - both calories and protein are under 50% of per-meal targets',
    'Outlined protein chip - protein reaches 85%+ of its per-meal target',
  ]);
});

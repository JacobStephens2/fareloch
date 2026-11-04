import { describe, it, expect } from 'vitest';
import {
  macrosOf,
  scaleMacros,
  recipePerServing,
  roundMacros,
  unitScale,
  caloriesFromMacros,
  mealPulseStatus,
} from './nutrition';

const oats = { calories: 150, carbs_g: 27, protein_g: 5, fat_g: 2.5 };
const milk = { calories: 103, carbs_g: 12.2, protein_g: 8.1, fat_g: 2.4 };

const noManual = {
  manual_calories: null,
  manual_carbs_g: null,
  manual_protein_g: null,
  manual_fat_g: null,
};

describe('mealPulseStatus', () => {
  const target = { calories: 600, carbsG: 75, proteinG: 40, fatG: 20 };

  it('leaves an all-zero meal without a status', () => {
    expect(mealPulseStatus({ calories: 0, carbsG: 0, proteinG: 0, fatG: 0 }, target)).toBe('');
  });

  it('is on track when calories and protein both reach 85% of their targets', () => {
    expect(mealPulseStatus({ calories: 510, carbsG: 60, proteinG: 34, fatG: 16 }, target)).toBe('on-track');
  });

  it.each([
    ['high-calorie, low-protein pastry', { calories: 650, carbsG: 100, proteinG: 6, fatG: 25 }],
    ['lean protein-pulse snack', { calories: 200, carbsG: 12, proteinG: 34, fatG: 2 }],
    ['50% of calories only', { calories: 300, carbsG: 60, proteinG: 0, fatG: 6 }],
    ['50% of protein only', { calories: 80, carbsG: 0, proteinG: 20, fatG: 0 }],
    ['calories just below 85%', { calories: 509.9, carbsG: 60, proteinG: 40, fatG: 16 }],
    ['protein just below 85%', { calories: 600, carbsG: 75, proteinG: 33.9, fatG: 20 }],
  ])('is partial for %s', (_label, logged) => {
    expect(mealPulseStatus(logged, target)).toBe('partial');
  });

  it.each([
    ['both calories and protein just below 50%', { calories: 299.9, carbsG: 30, proteinG: 19.9, fatG: 10 }],
    ['only carbs logged', { calories: 0, carbsG: 10, proteinG: 0, fatG: 0 }],
    ['only fat logged', { calories: 0, carbsG: 0, proteinG: 0, fatG: 10 }],
  ])('is low for %s', (_label, logged) => {
    expect(mealPulseStatus(logged, target)).toBe('low');
  });
});

describe('food x servings', () => {
  it('scales a food and stores it rounded to 0.1', () => {
    const logged = roundMacros(scaleMacros(macrosOf(milk), 1.37), 'stored');
    expect(logged).toEqual({ calories: 141.1, carbsG: 16.7, proteinG: 11.1, fatG: 3.3 });
  });
});

describe('recipePerServing', () => {
  it('sums ingredients and divides by total servings, unrounded', () => {
    const perServing = recipePerServing(
      { total_servings: 3, ...noManual },
      [
        { food: oats, servings: 2 },
        { food: milk, servings: 1 },
      ],
    );
    expect(perServing.calories).toBeCloseTo(403 / 3, 10);
    expect(perServing.carbsG).toBeCloseTo(66.2 / 3, 10);
    expect(perServing.proteinG).toBeCloseTo(18.1 / 3, 10);
    expect(perServing.fatG).toBeCloseTo(7.4 / 3, 10);
  });

  it('totals the same food used twice row by row with its own servings', () => {
    const perServing = recipePerServing(
      { total_servings: 1, ...noManual },
      [
        { food: oats, servings: 1 },
        { food: oats, servings: 0.5 },
      ],
    );
    expect(perServing).toEqual({ calories: 225, carbsG: 40.5, proteinG: 7.5, fatG: 3.75 });
  });

  it('uses manual macros over ingredients, counting blank manual grams as 0', () => {
    const perServing = recipePerServing(
      {
        total_servings: 4,
        manual_calories: 800,
        manual_carbs_g: 100,
        manual_protein_g: null,
        manual_fat_g: null,
      },
      [{ food: oats, servings: 10 }],
    );
    expect(perServing).toEqual({ calories: 200, carbsG: 25, proteinG: 0, fatG: 0 });
  });

  it('keeps manual macros when calories are 0', () => {
    const perServing = recipePerServing(
      {
        total_servings: 1,
        manual_calories: 0,
        manual_carbs_g: null,
        manual_protein_g: null,
        manual_fat_g: null,
      },
      [{ food: oats, servings: 1 }],
    );
    expect(perServing).toEqual({ calories: 0, carbsG: 0, proteinG: 0, fatG: 0 });
  });

  it('counts a zero-servings row as zero, not as one serving', () => {
    const perServing = recipePerServing(
      { total_servings: 1, ...noManual },
      [
        { food: oats, servings: 0 },
        { food: oats, servings: 2 },
      ],
    );
    expect(perServing).toEqual({ calories: 300, carbsG: 54, proteinG: 10, fatG: 5 });
  });

  it('treats total servings of 0 or null as 1', () => {
    const ingredients = [{ food: oats, servings: 2 }];
    const expected = { calories: 300, carbsG: 54, proteinG: 10, fatG: 5 };
    expect(recipePerServing({ total_servings: 0, ...noManual }, ingredients)).toEqual(expected);
    expect(recipePerServing({ total_servings: null, ...noManual }, ingredients)).toEqual(expected);
  });

  it('counts null food macros as 0', () => {
    const perServing = recipePerServing(
      { total_servings: 1, ...noManual },
      [
        { food: { calories: 50, carbs_g: null, protein_g: null, fat_g: null }, servings: 2 },
        { food: oats, servings: 1 },
      ],
    );
    expect(perServing).toEqual({ calories: 250, carbsG: 27, proteinG: 5, fatG: 2.5 });
  });
});

describe('macrosOf', () => {
  it('reads snake_case columns and counts null or missing as 0', () => {
    expect(macrosOf(milk)).toEqual({ calories: 103, carbsG: 12.2, proteinG: 8.1, fatG: 2.4 });
    expect(macrosOf({ calories: null, carbs_g: 4 })).toEqual({ calories: 0, carbsG: 4, proteinG: 0, fatG: 0 });
  });
});

describe('roundMacros', () => {
  const m = { calories: 134.3333, carbsG: 22.0666, proteinG: 6.0333, fatG: 2.4666 };

  it('display rounding gives whole kcal and 0.1 g', () => {
    expect(roundMacros(m, 'display')).toEqual({ calories: 134, carbsG: 22.1, proteinG: 6, fatG: 2.5 });
  });

  it('stored rounding gives 0.1 for every field', () => {
    expect(roundMacros(m, 'stored')).toEqual({ calories: 134.3, carbsG: 22.1, proteinG: 6, fatG: 2.5 });
  });
});

describe('unitScale', () => {
  it('is the measure gram weight over the food serving size', () => {
    expect(unitScale(240, 100)).toBe(2.4);
  });

  it('treats a zero serving size as 1', () => {
    expect(unitScale(30, 0)).toBe(30);
  });
});

describe('caloriesFromMacros', () => {
  it('is c*4 + p*4 + f*9 rounded to a whole number', () => {
    expect(caloriesFromMacros(20, 10, 5)).toBe(165);
    expect(caloriesFromMacros(10.3, 2.2, 1.1)).toBe(60);
  });
});

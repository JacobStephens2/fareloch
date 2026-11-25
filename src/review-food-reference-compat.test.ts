import { afterEach, beforeEach, expect, it } from 'vitest';
import { foods, recipes } from './api';
import { setGuestMode } from './local-db';

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
});

afterEach(() => {
  localStorage.clear();
});

it.each(['create', 'update'] as const)(
  '%s retains the existing missing-Food fallback without poisoning Recipe storage',
  async action => {
    const { food } = await foods.create({
      name: 'Oats',
      calories: 100,
    });
    const { recipe: existing } = await recipes.create({
      name: 'Existing',
      totalServings: 1,
      ingredients: [{ foodId: food.id, servings: 1 }],
    });

    const input = {
      name: 'Unknown Food',
      totalServings: 1,
      ingredients: [{ foodId: 0, servings: 1 }],
    };

    let targetId = existing.id;
    if (action === 'create') {
      targetId = (await recipes.create(input)).recipe.id;
    } else {
      await expect(recipes.update(existing.id, input))
        .resolves.toEqual({ success: true });
    }

    await expect(recipes.get(targetId)).resolves.toMatchObject({
      recipe: { name: 'Unknown Food' },
      ingredients: [{
        food_id: 0,
        name: '',
        servings: 1,
        calories: 0,
        carbs_g: 0,
        protein_g: 0,
        fat_g: 0,
      }],
    });
    await expect(recipes.list()).resolves.toHaveProperty('recipes');
  },
);

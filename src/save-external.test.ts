import { afterEach, expect, it, vi } from 'vitest';
import { foods } from './api';
import { clearGuestData, setGuestMode } from './local-db';

afterEach(() => {
  vi.restoreAllMocks();
  clearGuestData();
});

it('stores an external food on this device in guest mode', async () => {
  clearGuestData();
  setGuestMode(true);
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  const saved = await foods.saveExternal({
    name: 'Rolled oats',
    brand: "Bob's Red Mill",
    barcode: null,
    servingSize: 40,
    servingUnit: 'g',
    calories: 150,
    carbsG: 27,
    proteinG: 5,
    fatG: 2.5,
    fiberG: 4,
    sugarG: 1,
    source: 'usda',
    sourceId: '168878',
  });

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(saved.food).toMatchObject({
    name: 'Rolled oats',
    calories: 150,
    source: 'usda',
    source_id: '168878',
  });

  const listed = await foods.custom();
  expect(listed.foods.map((food) => food.name)).toContain('Rolled oats');
});

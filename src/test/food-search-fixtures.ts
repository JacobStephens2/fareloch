import type { Food } from '../types';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function food(name: string): Food {
  return {
    id: 1, user_id: null, name, brand: null, barcode: null,
    serving_size: 100, serving_unit: 'g', calories: 100,
    carbs_g: 10, protein_g: 5, fat_g: 4, fiber_g: 0, sugar_g: 0,
    source: 'custom', source_id: null,
    measures: '[{"label":"cup","gramWeight":200}]',
  };
}

export function result(name: string) {
  return { foods: [food(name)], external: [] };
}

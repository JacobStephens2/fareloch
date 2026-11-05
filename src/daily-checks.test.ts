import { beforeEach, expect, it, vi } from 'vitest';
import { dailyChecks, meals } from './api';
import { clearGuestData, setGuestMode } from './local-db';

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
});

it('persists independent guest daily checks across reloads without changing meal logs', async () => {
  await meals.quickLog({ date: '2026-11-04', mealType: 'breakfast', name: 'Breakfast', calories: 300, proteinG: 20 });
  const before = await meals.getByDate('2026-11-04');
  expect(await dailyChecks.get('2026-11-04')).toEqual({ checks: [] });
  await dailyChecks.set('2026-11-04', 'creatine', true);
  await dailyChecks.set('2026-11-04', 'creatine', true);
  await dailyChecks.set('2026-11-03', 'carotenoids', true);
  vi.resetModules();
  const reloaded = (await import('./api')).dailyChecks;
  expect(await reloaded.get('2026-11-04')).toEqual({ checks: ['creatine'] });
  expect(await reloaded.get('2026-11-03')).toEqual({ checks: ['carotenoids'] });
  await reloaded.set('2026-11-04', 'carotenoids', true);
  await reloaded.set('2026-11-04', 'creatine', false);
  await reloaded.set('2026-11-04', 'creatine', false);
  expect(await reloaded.get('2026-11-04')).toEqual({ checks: ['carotenoids'] });
  expect(await reloaded.get('2026-11-03')).toEqual({ checks: ['carotenoids'] });
  expect(await meals.getByDate('2026-11-04')).toEqual(before);
  clearGuestData();
  setGuestMode(true);
  expect(await reloaded.get('2026-11-04')).toEqual({ checks: [] });
  expect(await reloaded.get('2026-11-03')).toEqual({ checks: [] });
});

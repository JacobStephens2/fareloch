import { beforeEach, expect, it } from 'vitest';
import { auth, weight } from './api';
import { setGuestMode } from './local-db';

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
});

it('stores and updates optional waist measurements in guest mode', async () => {
  const { log } = await weight.log({ date: '2026-11-04', weightLbs: 165, time: '07:30', waistInches: 30.8 });
  expect(log).toMatchObject({ weight_lbs: 165, waist_inches: 30.8 });
  await weight.log({ date: '2026-11-04', weightLbs: 166, time: '07:30', waistInches: 31.2 });
  expect((await weight.list()).logs).toEqual([
    expect.objectContaining({ id: log.id, weight_lbs: 166, waist_inches: 31.2 }),
  ]);
  await weight.log({ date: '2026-11-04', weightLbs: 166, time: '07:30' });
  expect((await weight.list()).logs[0].waist_inches).toBeNull();
});

it('reads guest weight records saved before waist measurements existed', async () => {
  localStorage.setItem('guest_weight', JSON.stringify([
    { id: 1, date: '2026-11-03', time: '', weight_lbs: 164, notes: null },
  ]));
  expect((await weight.list()).logs).toEqual([
    { id: 1, date: '2026-11-03', time: '', weight_lbs: 164, notes: null, waist_inches: null },
  ]);
});

it.each([NaN, Infinity, 19.9, 60.1])('rejects invalid guest waist measurements: %s', async (waistInches) => {
  await expect(weight.log({ date: '2026-11-04', weightLbs: 165, waistInches })).rejects.toThrow('Waist');
  expect((await weight.list()).logs).toEqual([]);
});

it('saves and clears an optional guest waist ceiling without changing macro targets', async () => {
  const { user: before } = await auth.me();
  expect(before.targetWaistInches).toBeNull();
  await auth.updateProfile({ targetWaistInches: 31.25 });
  expect((await auth.me()).user).toEqual({ ...before, targetWaistInches: 31.25 });
  await expect(auth.updateProfile({ targetWaistInches: NaN })).rejects.toThrow('Waist ceiling');
  await auth.updateProfile({ targetWaistInches: null });
  expect((await auth.me()).user).toEqual(before);
});

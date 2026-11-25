import { expect, it } from 'vitest';
import { calculateWeightTrend } from './weight-trend';

it('returns an empty trend and no summary values without logs', () => {
  expect(calculateWeightTrend([])).toEqual({
    points: [],
    currentMeanLbs: null,
    previousMeanLbs: null,
    weeklyChangeLbs: null,
  });
});

it('shows a single day as the current trend without inventing a weekly change', () => {
  expect(calculateWeightTrend([{ date: '2026-11-04', weight_lbs: 165 }])).toEqual({
    points: [{ date: '2026-11-04', weightLbs: 165 }],
    currentMeanLbs: 165,
    previousMeanLbs: null,
    weeklyChangeLbs: null,
  });
});

it('averages each date first so an extra weigh-in does not give a day extra weight', () => {
  const logs = Object.freeze([
    { date: '2026-11-03', weight_lbs: 160 },
    { date: '2026-11-04', weight_lbs: 164 },
    { date: '2026-11-04', weight_lbs: 168 },
  ]);
  expect(calculateWeightTrend(logs)).toEqual({
    points: [
      { date: '2026-11-03', weightLbs: 160 },
      { date: '2026-11-04', weightLbs: 163 },
    ],
    currentMeanLbs: 163,
    previousMeanLbs: null,
    weeklyChangeLbs: null,
  });
});

it('uses trailing calendar days across missing logs and the daylight-saving boundary', () => {
  expect(calculateWeightTrend([
    { date: '2026-10-21', weight_lbs: 100 },
    { date: '2026-10-22', weight_lbs: 150 },
    { date: '2026-10-28', weight_lbs: 154 },
    { date: '2026-10-29', weight_lbs: 160 },
    { date: '2026-11-04', weight_lbs: 164 },
  ])).toEqual({
    points: [
      { date: '2026-10-21', weightLbs: 100 },
      { date: '2026-10-22', weightLbs: 125 },
      { date: '2026-10-28', weightLbs: 152 },
      { date: '2026-10-29', weightLbs: 157 },
      { date: '2026-11-04', weightLbs: 162 },
    ],
    currentMeanLbs: 162,
    previousMeanLbs: 152,
    weeklyChangeLbs: null,
  });
});

it.each([
  [165.3, 0.3],
  [164.7, -0.3],
  [165, 0],
  [165.256, 0.26],
])('compares the latest and preceding week means for %s lbs, rounded to hundredths', (current, delta) => {
  const logs = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-11-${String(1 + index).padStart(2, '0')}`,
    weight_lbs: index < 7 ? 165 : current,
  }));
  const trend = calculateWeightTrend(logs);
  expect(trend.currentMeanLbs).toBeCloseTo(current);
  expect(trend.previousMeanLbs).toBe(165);
  expect(trend.weeklyChangeLbs).toBe(delta);
});

it('can compare sparse weeks once seven distinct logged dates exist in the two windows', () => {
  const trend = calculateWeightTrend([
    { date: '2026-10-22', weight_lbs: 150 },
    { date: '2026-10-24', weight_lbs: 152 },
    { date: '2026-10-28', weight_lbs: 154 },
    { date: '2026-10-29', weight_lbs: 160 },
    { date: '2026-10-31', weight_lbs: 162 },
    { date: '2026-11-02', weight_lbs: 164 },
    { date: '2026-11-04', weight_lbs: 166 },
  ]);
  expect(trend.currentMeanLbs).toBe(163);
  expect(trend.previousMeanLbs).toBe(152);
  expect(trend.weeklyChangeLbs).toBe(11);
});

it('does not use stale logs to qualify a weekly change or to fill a long gap', () => {
  const logs = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    weight_lbs: 150,
  }));
  logs.push({ date: '2026-10-28', weight_lbs: 160 }, { date: '2026-11-04', weight_lbs: 165 });
  const trend = calculateWeightTrend(logs);
  expect(trend.points.slice(-2)).toEqual([
    { date: '2026-10-28', weightLbs: 160 },
    { date: '2026-11-04', weightLbs: 165 },
  ]);
  expect(trend.currentMeanLbs).toBe(165);
  expect(trend.previousMeanLbs).toBe(160);
  expect(trend.weeklyChangeLbs).toBeNull();
});

it('does not compare seven consecutive logged dates with an empty previous week', () => {
  const trend = calculateWeightTrend(Array.from({ length: 7 }, (_, index) => ({
    date: `2026-11-${String(index + 1).padStart(2, '0')}`,
    weight_lbs: 165,
  })));
  expect(trend.currentMeanLbs).toBe(165);
  expect(trend.previousMeanLbs).toBeNull();
  expect(trend.weeklyChangeLbs).toBeNull();
});

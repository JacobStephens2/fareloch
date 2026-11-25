// Pure and import-free so server and client can share it (ADR 0001).
export interface WeightReading {
  date: string;
  weight_lbs: number;
}

export interface WeightTrendPoint {
  date: string;
  weightLbs: number;
}

export interface WeightTrend {
  points: WeightTrendPoint[];
  currentMeanLbs: number | null;
  previousMeanLbs: number | null;
  weeklyChangeLbs: number | null;
}

// Chronological ISO-date logs. Missing days are omitted, never filled with zero.
// Each logged date contributes once. Windows end on the latest logged date:
// current = days 0..6 ago, previous = days 7..13 ago. A rate needs data in both
// weeks and at least seven distinct logged dates across those two weeks.
export function calculateWeightTrend(logs: readonly WeightReading[]): WeightTrend {
  const byDate = new Map<string, { total: number; count: number }>();
  for (const log of logs) {
    const day = byDate.get(log.date) ?? { total: 0, count: 0 };
    day.total += log.weight_lbs;
    day.count++;
    byDate.set(log.date, day);
  }
  const dailyMeans = [...byDate].map(([date, day]) => ({ date, weightLbs: day.total / day.count }));
  const points = dailyMeans.map((day) => ({
    date: day.date,
    weightLbs: meanWeight(weekEnding(dailyMeans, Date.parse(day.date)))!,
  }));
  const latest = dailyMeans[dailyMeans.length - 1];
  const currentWeek = latest ? weekEnding(dailyMeans, Date.parse(latest.date)) : [];
  const previousWeek = latest ? weekEnding(dailyMeans, Date.parse(latest.date) - 7 * DAY_MS) : [];
  const currentMeanLbs = meanWeight(currentWeek);
  const previousMeanLbs = meanWeight(previousWeek);
  return {
    points,
    currentMeanLbs,
    previousMeanLbs,
    weeklyChangeLbs: currentMeanLbs != null && previousMeanLbs != null && currentWeek.length + previousWeek.length >= 7
      ? Math.round((currentMeanLbs - previousMeanLbs) * 100) / 100
      : null,
  };
}

const DAY_MS = 86_400_000;

function weekEnding(days: WeightTrendPoint[], endDate: number): WeightTrendPoint[] {
  return days.filter((day) => {
    const daysAgo = (endDate - Date.parse(day.date)) / DAY_MS;
    return daysAgo >= 0 && daysAgo < 7;
  });
}

function meanWeight(days: WeightTrendPoint[]): number | null {
  return days.length ? days.reduce((sum, day) => sum + day.weightLbs, 0) / days.length : null;
}

// Shared with the client; keep this module free of platform-specific imports.
export const DAILY_CHECKS = [
  { key: 'creatine', label: 'Creatine 5g' },
  { key: 'carotenoids', label: 'Carotenoids + Fat 3x' },
] as const;

export type DailyCheckKey = typeof DAILY_CHECKS[number]['key'];

export function isDailyCheckKey(key: unknown): key is DailyCheckKey {
  return DAILY_CHECKS.some(check => check.key === key);
}

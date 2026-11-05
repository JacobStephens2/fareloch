// Shared with the client; keep this module free of platform-specific imports.
export const DAILY_CHECKS = [
  { key: 'creatine', label: 'Creatine 5g' },
  { key: 'carotenoids', label: 'Carotenoids + Fat 3x' },
] as const;

export type DailyCheckKey = typeof DAILY_CHECKS[number]['key'];

export function dailyCheckValidationError(key: unknown, checked: unknown): string | null {
  if (!DAILY_CHECKS.some(check => check.key === key) || typeof checked !== 'boolean') {
    return 'A valid daily check key and boolean checked value are required';
  }
  return null;
}

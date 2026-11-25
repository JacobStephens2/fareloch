import type { User } from './types';

interface AppState {
  user: User | null;
  selectedDate: string;
  mealLogNotice?: string;
  loading: boolean;
}

const listeners: (() => void)[] = [];

export function toLocalDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const state: AppState = {
  user: null,
  selectedDate: toLocalDateStr(),
  loading: true,
};

export function setState(updates: Partial<AppState>) {
  Object.assign(state, updates);
  listeners.forEach((fn) => fn());
}

export function onStateChange(fn: () => void) {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const today = toLocalDateStr();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayString = toLocalDateStr(yesterday);

  if (dateStr === today) return 'Today';
  if (dateStr === yesterdayString) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function todayStr(): string {
  return toLocalDateStr();
}

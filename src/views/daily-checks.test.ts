import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dailyChecks, meals } from '../api';
import { setGuestMode } from '../local-db';
import { state } from '../state';
import { dashboardView } from './dashboard';

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  state.user = null;
  state.selectedDate = '2026-11-04';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function chip(key: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-check-key="${key}"]`);
  expect(button).not.toBeNull();
  return button!;
}

async function ready() {
  await vi.waitFor(() => expect(chip('creatine').disabled).toBe(false));
}

function renderDashboard() {
  const view = dashboardView();
  document.body.innerHTML = view.html;
  view.init();
}

async function showDashboard() {
  renderDashboard();
  await ready();
}

it('toggles daily pills independently and reloads each date through arrows and the date picker', async () => {
  await dailyChecks.set('2026-11-03', 'carotenoids', true);
  await meals.quickLog({ date: state.selectedDate, mealType: 'breakfast', name: 'Breakfast', calories: 300, proteinG: 20 });
  const before = await meals.getByDate(state.selectedDate);
  await showDashboard();
  expect(chip('creatine').textContent).toBe('Creatine 5g');
  expect(chip('carotenoids').textContent).toBe('Carotenoids + Fat 3x');
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  const macros = document.querySelector('#macro-summary')!.textContent;
  chip('creatine').click();
  await ready();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('true');
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('false');
  expect(await meals.getByDate(state.selectedDate)).toEqual(before);
  expect(document.querySelector('#macro-summary')!.textContent).toBe(macros);
  await showDashboard();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('true');
  document.querySelector<HTMLButtonElement>('#date-prev')!.click();
  await ready();
  expect(state.selectedDate).toBe('2026-11-03');
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('true');
  document.querySelector<HTMLButtonElement>('#date-next')!.click();
  await ready();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('true');
  chip('creatine').click();
  await ready();
  expect(await dailyChecks.get('2026-11-04')).toEqual({ checks: [] });
  document.querySelector<HTMLButtonElement>('#date-label')!.click();
  const picker = document.querySelector<HTMLInputElement>('input[type="date"]')!;
  picker.value = '2026-11-03';
  picker.dispatchEvent(new Event('change'));
  await ready();
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('true');
  chip('creatine').click();
  await ready();
  expect(await dailyChecks.get('2026-11-03')).toEqual({ checks: ['carotenoids', 'creatine'] });
  expect(await dailyChecks.get('2026-11-04')).toEqual({ checks: [] });
});

function useServerChecks(handle: (date: string, options?: RequestInit) => Promise<Response>) {
  setGuestMode(false);
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.includes('/daily-checks/')) return handle(url.split('/').pop()!, options);
    if (url.includes('/workout-days/')) return Promise.resolve(Response.json({ isWorkoutDay: false }));
    return Promise.resolve(Response.json({ meals: [] }));
  }));
}

it('ignores a delayed daily-check read after navigating to another date', async () => {
  let finishRead!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finishRead = resolve; });
  useServerChecks(date => date === '2026-11-04'
    ? pending
    : Promise.resolve(Response.json({ checks: ['carotenoids'] })));
  renderDashboard();
  expect(chip('creatine').disabled).toBe(true);
  document.querySelector<HTMLButtonElement>('#date-prev')!.click();
  await ready();
  finishRead(Response.json({ checks: ['creatine'] }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(state.selectedDate).toBe('2026-11-03');
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('true');
});

it('saves against the clicked date while navigation and a delayed write are in flight', async () => {
  let finishSave!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finishSave = resolve; });
  let savedDate = '';
  let savedBody: unknown;
  useServerChecks((date, options) => {
    if (options?.method === 'PUT') {
      savedDate = date;
      savedBody = JSON.parse(String(options.body));
      return pending;
    }
    return Promise.resolve(Response.json({ checks: date === '2026-11-03' ? ['carotenoids'] : [] }));
  });
  await showDashboard();
  chip('creatine').click();
  expect(chip('creatine').disabled).toBe(true);
  document.querySelector<HTMLButtonElement>('#date-prev')!.click();
  await ready();
  finishSave(Response.json({ checks: ['creatine'] }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(savedDate).toBe('2026-11-04');
  expect(savedBody).toEqual({ key: 'creatine', checked: true });
  expect(state.selectedDate).toBe('2026-11-03');
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('true');
});

it('shows a failed save without marking the habit complete and allows another attempt', async () => {
  useServerChecks((_date, options) => Promise.resolve(options?.method === 'PUT'
    ? Response.json({ error: 'Unable to save' }, { status: 500 })
    : Response.json({ checks: [] })));
  await showDashboard();
  chip('creatine').click();
  await ready();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelector('#daily-checks [role="status"]')!.textContent).toContain('Could not save');
  chip('carotenoids').click();
  await ready();
  expect(chip('carotenoids').getAttribute('aria-pressed')).toBe('false');
});

it('clears the previous date and disables checks when a date cannot load', async () => {
  useServerChecks(date => Promise.resolve(date === '2026-11-04'
    ? Response.json({ checks: ['creatine'] })
    : Response.json({ error: 'Unable to load' }, { status: 500 })));
  await showDashboard();
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('true');
  document.querySelector<HTMLButtonElement>('#date-prev')!.click();
  await vi.waitFor(() => expect(document.querySelector('#daily-checks [role="status"]')!.textContent).toContain('Could not load'));
  expect(chip('creatine').getAttribute('aria-pressed')).toBe('false');
  expect(chip('creatine').disabled).toBe(true);
  expect(chip('carotenoids').disabled).toBe(true);
});

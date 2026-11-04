import { Chart } from 'chart.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auth, weight } from '../api';
import { setGuestMode } from '../local-db';
import { weightView } from './weight';

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  Object.values(Chart.instances).forEach((chart) => chart.destroy());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function showWeight() {
  const view = weightView();
  document.body.innerHTML = view.html;
  view.init();
  await vi.waitFor(() => expect(document.querySelector('#weight-history .loading-spinner')).toBeNull());
}

it('logs an optional navel waist through the form and displays it alongside weight', async () => {
  await showWeight();
  const waist = document.querySelector<HTMLInputElement>('#weight-waist');
  expect(waist).not.toBeNull();
  expect(waist!.required).toBe(false);
  expect([waist!.step, waist!.min, waist!.max]).toEqual(['0.1', '20', '60']);
  waist!.value = '30.8';
  document.querySelector<HTMLInputElement>('#weight-lbs')!.value = '165';
  document.querySelector('#weight-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('.weight-entry')?.textContent).toContain('30.8"'));
  expect(document.querySelector('.weight-entry')!.textContent).toContain('165 lbs');
  expect((await weight.list()).logs[0].waist_inches).toBe(30.8);
  expect(waist!.value).toBe('');
});

it('shows the latest measured waist above the chart even when newer entries have only weight', async () => {
  await weight.log({ date: '2026-11-02', weightLbs: 164, time: '07:00', waistInches: 30.6 });
  await weight.log({ date: '2026-11-03', weightLbs: 165, time: '18:00', waistInches: 30.8 });
  await weight.log({ date: '2026-11-03', weightLbs: 165, time: '07:00', waistInches: 30.7 });
  await weight.log({ date: '2026-11-04', weightLbs: 166 });
  await showWeight();
  const summary = document.querySelector('#waist-summary');
  expect(summary?.textContent).toContain('Latest waist: 30.8"');
  expect(summary?.textContent).toContain('2026-11-03');
  expect(summary!.compareDocumentPosition(document.querySelector('#weight-chart')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it.each([
  [31.2, 'At or below ceiling'],
  [31.25, 'At or below ceiling'],
  [31.3, 'Above ceiling'],
])('compares the latest waist %s with the saved ceiling', async (waistInches, status) => {
  await auth.updateProfile({ targetWaistInches: 31.25 });
  await weight.log({ date: '2026-11-04', weightLbs: 165, waistInches });
  await showWeight();
  expect(document.querySelector('#waist-summary')?.textContent).toContain(status);
  expect(document.querySelector('#waist-summary')?.textContent).toContain('31.25"');
});

it('saves and disables the waist ceiling from the Weight view', async () => {
  await showWeight();
  const input = document.querySelector<HTMLInputElement>('#waist-ceiling');
  expect(input).not.toBeNull();
  input!.value = '31.25';
  const submit = () => document.querySelector('#waist-ceiling-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  submit();
  await vi.waitFor(async () => expect((await auth.me()).user.targetWaistInches).toBe(31.25));
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#waist-ceiling-form button')!.disabled).toBe(false));
  expect(document.querySelector('#waist-summary')?.textContent).toContain('Log a waist measurement');
  await showWeight();
  expect(document.querySelector<HTMLInputElement>('#waist-ceiling')!.value).toBe('31.25');
  document.querySelector<HTMLInputElement>('#waist-ceiling')!.value = '';
  submit();
  await vi.waitFor(async () => expect((await auth.me()).user.targetWaistInches).toBeNull());
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#waist-ceiling-form button')!.disabled).toBe(false));
  expect(document.querySelector('#waist-summary')?.textContent).toBe('');
});

it('keeps waist optional for weight-only form submissions and shows no invented measurement', async () => {
  await showWeight();
  document.querySelector<HTMLInputElement>('#weight-lbs')!.value = '165';
  document.querySelector('#weight-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('.weight-entry')?.textContent).toContain('165 lbs'));
  expect((await weight.list()).logs[0].waist_inches).toBeNull();
  expect(document.querySelector('.weight-waist')).toBeNull();
  expect(document.querySelector<HTMLElement>('#waist-summary')!.hidden).toBe(true);
});

it('shows the daily-weighted trend above the chart while retaining every raw reading', async () => {
  await weight.log({ date: '2026-11-03', weightLbs: 160 });
  await weight.log({ date: '2026-11-04', weightLbs: 164, time: '07:00' });
  await weight.log({ date: '2026-11-04', weightLbs: 168, time: '18:00' });
  await showWeight();
  const summary = document.querySelector('#weight-trend-summary');
  expect(summary?.textContent).toContain('7-Day Trend');
  expect(summary?.textContent).toContain('163.0 lbs');
  expect(summary?.textContent).toContain('Weekly Change');
  expect(summary?.textContent).toContain('Need 7+ days of logs');
  expect(summary!.compareDocumentPosition(document.querySelector('#weight-chart')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  const canvas = document.querySelector<HTMLCanvasElement>('#weight-chart')!;
  const chart = Chart.getChart(canvas)!;
  expect(chart.data.datasets).toHaveLength(2);
  expect(chart.data.datasets[0].data).toEqual([
    { x: Date.parse('2026-11-03T12:00:00Z'), y: 160 },
    { x: Date.parse('2026-11-04T07:00:00Z'), y: 164 },
    { x: Date.parse('2026-11-04T18:00:00Z'), y: 168 },
  ]);
  expect(chart.data.datasets[1].data).toEqual([
    { x: Date.parse('2026-11-03T12:00:00Z'), y: 160 },
    { x: Date.parse('2026-11-04T12:00:00Z'), y: 163 },
  ]);
  expect(chart.data.datasets[1]).toMatchObject({ label: '7-Day Trend (lbs)', pointRadius: 0, fill: false });
});

it.each([
  [165.3, '+0.30 lbs/wk'],
  [164.7, '-0.30 lbs/wk'],
  [165, '+0.00 lbs/wk'],
])('shows a signed weekly change for a current trend of %s lbs', async (current, text) => {
  for (let index = 0; index < 14; index++) {
    const date = new Date(Date.UTC(2026, 9, 22 + index)).toISOString().slice(0, 10);
    await weight.log({ date, weightLbs: index < 7 ? 165 : current });
  }
  await showWeight();
  expect(document.querySelector('#weight-trend-value')?.textContent).toBe(`${current.toFixed(1)} lbs`);
  expect(document.querySelector('#weight-weekly-change')?.textContent).toBe(text);
  expect(document.querySelector('#weight-trend-as-of')?.textContent).toBe('As of 2026-11-04');
});

it('refreshes the trend after saving and deleting a weight entry, including the empty state', async () => {
  await showWeight();
  expect(document.querySelector('#weight-trend-value')?.textContent).toBe('No logs yet');
  expect(document.querySelector('#weight-weekly-change')?.textContent).toBe('Need 7+ days of logs');
  document.querySelector<HTMLInputElement>('#weight-lbs')!.value = '165';
  document.querySelector('#weight-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('#weight-trend-value')?.textContent).toBe('165.0 lbs'));
  vi.stubGlobal('confirm', () => true);
  document.querySelector<HTMLButtonElement>('.btn-delete-weight')!.click();
  await vi.waitFor(() => expect(document.querySelector('#weight-trend-value')?.textContent).toBe('No logs yet'));
  expect(Chart.getChart(document.querySelector<HTMLCanvasElement>('#weight-chart')!)!.data.datasets[1].data).toEqual([]);
});

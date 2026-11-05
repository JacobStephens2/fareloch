import { route, startRouter } from '../router';
import type { WeightLog } from '../types';
import { weightView } from '../views/weight';

export function reading(weightLbs = 165, id = 7): WeightLog {
  return { id, date: '2026-11-04', time: '07:30', weight_lbs: weightLbs, waist_inches: 30.8, notes: null };
}

export function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

export function startWeightRoutes() {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/weight', weightView);
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
  startRouter();
}

export function input(id: string, value: string, root: ParentNode = document) {
  root.querySelector<HTMLInputElement>(`#${id}`)!.value = value;
}

export function submit(id: string, root: ParentNode = document) {
  root.querySelector(`#${id}`)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

export function submitReading() {
  input('weight-date', '2026-11-03');
  input('weight-time', '18:45');
  input('weight-lbs', '180');
  input('weight-waist', '31.2');
  submit('weight-form');
}

export type WeightOperation = 'log' | 'ceiling' | 'delete';

export function beginWeightOperation(operation: WeightOperation) {
  if (operation === 'log') submitReading();
  else if (operation === 'ceiling') {
    input('waist-ceiling', '31.25');
    submit('waist-ceiling-form');
  } else document.querySelector<HTMLButtonElement>('.btn-delete-weight')!.click();
}

export class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

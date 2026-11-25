import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { foods } from '../api';
import { setGuestMode } from '../local-db';
import { route, startRouter } from '../router';
import { deferred, externalFood, food } from '../test/food-search-fixtures';
import { change, click, go } from '../test/recipe-editor-fixtures';
import { logFoodView } from './log-food';
import { recipeEditView } from './recipes';

beforeAll(() => {
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/log', logFoodView);
  route('/recipe', () => recipeEditView({ id: 'new' }));
  route('/other', () => ({ html: '<p>Other screen</p>', init() {} }));
  startRouter();
});

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  go('/other');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { path: '/log', selector: 'food-search', modal: 'food-detail-modal', guest: true },
  { path: '/log', selector: 'food-search', modal: 'food-detail-modal', guest: false },
  { path: '/recipe', selector: 'ing-search', modal: 'ing-modal', guest: true },
  { path: '/recipe', selector: 'ing-search', modal: 'ing-modal', guest: false },
])('$path guest=$guest can select saved food before external search completes', async ({ path, selector, modal, guest }) => {
  setGuestMode(true);
  const { food: banana } = await foods.create(food('Banana'));
  setGuestMode(guest);
  const remote = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/foods/recent')) return Response.json({ foods: [banana] });
    if (url.includes('savedOnly=true')) return Response.json({ foods: [banana], external: [] });
    if (url.includes('/foods/search?')) return remote.promise;
    throw new Error(`Unexpected request: ${url}`);
  }));
  go(path);
  change(selector, 'banana');
  await vi.advanceTimersByTimeAsync(400);
  expect(document.querySelector('.food-item-name')?.textContent).toBe('Banana');
  expect(document.querySelector(`#${selector}`)!.classList.contains('searching')).toBe(true);
  click('.food-item');
  expect(document.querySelector(`#${modal}`)!.classList.contains('hidden')).toBe(false);
  remote.resolve(Response.json({ foods: [banana], external: [externalFood('Banana online')] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector(`#${modal}`)!.classList.contains('hidden')).toBe(false);
  expect(document.querySelector(`#${selector}`)!.classList.contains('searching')).toBe(false);
  expect(document.querySelector('#app')!.textContent).toContain('Banana online');
});

it.each(['/log', '/recipe'])('%s ignores late saved matches after a query change and external results after departure', async path => {
  setGuestMode(false);
  const oldSaved = deferred<Response>();
  const oldRemote = deferred<Response>();
  const currentRemote = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/foods/recent')) return Response.json({ foods: [] });
    if (url.includes('q=apple')) return url.includes('savedOnly=true') ? oldSaved.promise : oldRemote.promise;
    if (url.includes('q=pear')) return url.includes('savedOnly=true')
      ? Response.json({ foods: [food('Pear')], external: [] }) : currentRemote.promise;
    throw new Error(`Unexpected request: ${url}`);
  }));
  const selector = path === '/log' ? 'food-search' : 'ing-search';
  go(path);
  change(selector, 'apple');
  await vi.advanceTimersByTimeAsync(400);
  change(selector, 'pear');
  await vi.advanceTimersByTimeAsync(400);
  oldSaved.resolve(Response.json({ foods: [food('Old apple')], external: [] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('.food-item-name')?.textContent).toBe('Pear');
  expect(document.querySelector('#app')!.textContent).not.toContain('Old apple');
  oldRemote.resolve(Response.json({ foods: [], external: [externalFood('Old external apple')] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#app')!.textContent).not.toContain('Old external apple');
  go('/other');
  currentRemote.resolve(Response.json({ foods: [], external: [externalFood('Late pear')] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('#app')!.textContent).toBe('Other screen');
});

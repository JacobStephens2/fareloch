import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFoodSearchSession, type FoodSearchSnapshot } from './food-search-session';
import type { FoodSearchResult } from './food-search-session';
import { deferred, result } from './test/food-search-fixtures';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('starts inactive, trims without changing case, and replaces the debounce', async () => {
  const search = vi.fn(async (_query: string) => ({ foods: [], external: [] }));
  const snapshots: FoodSearchSnapshot[] = [];
  const session = createFoodSearchSession({ search, onChange: s => snapshots.push(s) });
  session.setQuery('  Ap  ');
  await vi.advanceTimersByTimeAsync(500);
  expect(search).not.toHaveBeenCalled();
  session.setActive(true);
  await vi.advanceTimersByTimeAsync(399);
  session.setQuery('  Apple  ');
  session.setActive(true);
  await vi.advanceTimersByTimeAsync(399);
  expect(search).not.toHaveBeenCalled();
  expect(snapshots[snapshots.length - 1]).toEqual({ query: 'Apple', status: 'debouncing', source: 'search', result: null });
  await vi.advanceTimersByTimeAsync(1);
  expect(search.mock.calls).toEqual([['Apple']]);
  expect(snapshots[snapshots.length - 1]?.status).toBe('ready');
});

function setup(withDefault = false) {
  const requests: ReturnType<typeof deferred<FoodSearchResult>>[] = [];
  const defaults: ReturnType<typeof deferred<FoodSearchResult>>[] = [];
  const snapshots: FoodSearchSnapshot[] = [];
  const session = createFoodSearchSession({
    search: () => { const d = deferred<FoodSearchResult>(); requests.push(d); return d.promise; },
    loadDefault: withDefault ? () => { const d = deferred<FoodSearchResult>(); defaults.push(d); return d.promise; } : undefined,
    onChange: s => snapshots.push(s),
  });
  return { session, requests, defaults, snapshots, last: () => snapshots[snapshots.length - 1] };
}

it('clears selectable results immediately and ignores reversed successes', async () => {
  const { session, requests, last } = setup();
  session.setActive(true);
  session.setQuery('old');
  await vi.advanceTimersByTimeAsync(400);
  session.setQuery('new');
  expect(last().result).toBeNull();
  await vi.advanceTimersByTimeAsync(400);
  requests[1].resolve(result('new'));
  await vi.advanceTimersByTimeAsync(0);
  requests[0].resolve(result('old'));
  await vi.advanceTimersByTimeAsync(0);
  expect(last().result).toEqual(result('new'));
  session.setQuery('next');
  expect(last().result).toBeNull();
});

it('ignores stale rejection during current loading, reports current failure and retries the same query', async () => {
  const { session, requests, last } = setup();
  session.setActive(true);
  session.setQuery('old');
  await vi.advanceTimersByTimeAsync(400);
  session.setQuery('new');
  await vi.advanceTimersByTimeAsync(400);
  requests[0].reject(new Error('old failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(last()).toEqual({ query: 'new', status: 'loading', source: 'search', result: null });
  requests[1].reject(new Error('current failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(last().status).toBe('error');
  session.setQuery('new');
  await vi.advanceTimersByTimeAsync(400);
  requests[2].resolve(result('retry'));
  await vi.advanceTimersByTimeAsync(0);
  expect(last().result).toEqual(result('retry'));
});

it('short queries reset to idle and prevent pending requests reopening results', async () => {
  const { session, requests, last } = setup();
  session.setActive(true);
  session.setQuery('apple');
  await vi.advanceTimersByTimeAsync(400);
  session.setQuery(' a ');
  expect(last()).toEqual({ query: 'a', status: 'idle', source: null, result: null });
  requests[0].resolve(result('old'));
  await vi.advanceTimersByTimeAsync(400);
  expect(last().status).toBe('idle');
});

it('guards defaults against newer searches, newer defaults and short-query resets', async () => {
  const { session, requests, defaults, last } = setup(true);
  session.setActive(true);
  expect(last().source).toBe('default');
  session.setQuery('apple');
  await vi.advanceTimersByTimeAsync(400);
  defaults[0].resolve(result('old default'));
  await vi.advanceTimersByTimeAsync(0);
  expect(last().status).toBe('loading');
  session.setQuery('');
  session.setQuery('a');
  defaults[2].resolve(result('current default'));
  await vi.advanceTimersByTimeAsync(0);
  defaults[1].resolve(result('old default'));
  requests[0].resolve(result('old search'));
  await vi.advanceTimersByTimeAsync(0);
  expect(last().result).toEqual(result('current default'));
});

it('deactivates pending work, stores inactive queries and resumes query or default', async () => {
  const { session, requests, defaults, last } = setup(true);
  session.setActive(true);
  session.setQuery('apple');
  await vi.advanceTimersByTimeAsync(400);
  session.setActive(false);
  session.setQuery('pear');
  requests[0].resolve(result('old'));
  defaults[0].reject(new Error('old default'));
  await vi.advanceTimersByTimeAsync(500);
  expect(last()).toEqual({ query: 'pear', status: 'inactive', source: null, result: null });
  expect(requests).toHaveLength(1);
  session.setActive(true);
  await vi.advanceTimersByTimeAsync(400);
  requests[1].resolve(result('pear'));
  await vi.advanceTimersByTimeAsync(0);
  expect(last().result).toEqual(result('pear'));
  session.setActive(false);
  session.setQuery('');
  session.setActive(true);
  expect(defaults).toHaveLength(2);
});

it('disposes pending timers and requests silently and makes all later operations no-ops', async () => {
  const { session, requests, defaults, snapshots } = setup(true);
  session.setActive(true);
  session.setQuery('apple');
  await vi.advanceTimersByTimeAsync(400);
  session.setQuery('pear');
  const count = snapshots.length;
  session.dispose();
  session.dispose();
  session.setQuery('later');
  session.setActive(false);
  session.setActive(true);
  defaults[0].resolve(result('default'));
  requests[0].reject(new Error('old'));
  await vi.advanceTimersByTimeAsync(500);
  expect(requests).toHaveLength(1);
  expect(snapshots).toHaveLength(count);
});

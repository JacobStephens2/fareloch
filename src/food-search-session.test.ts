import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountFoodSearch } from './food-search-session';
import { deferred, externalFood, food, result } from './test/food-search-fixtures';
import type { FoodSearchResult } from './food-search-session';

const disposals: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(kind: 'meal' | 'ingredient' = 'ingredient') {
  const root = document.createElement('section');
  root.innerHTML = kind === 'meal'
    ? '<input id="food-search"><div id="tab-content">Another tab</div>'
    : '<input id="ing-search"><div id="ing-results" class="hidden"></div>';
  document.body.append(root);
  const input = root.querySelector('input')!;
  const host = root.querySelector('div')!;
  const operations = {
    search: vi.fn(async (_query: string, _onSaved?: (foods: FoodSearchResult['foods']) => void): Promise<FoodSearchResult> => ({ foods: [], external: [] })),
    recent: vi.fn(async () => ({ foods: [] as FoodSearchResult['foods'] })),
    saveExternal: vi.fn(async () => ({ food: result('Saved external').foods[0] })),
  };
  const selected = vi.fn();
  const notified = vi.fn();
  const session = mountFoodSearch(root, { kind, foods: operations, onSelect: selected, onQueryInput: notified });
  disposals.push(session.dispose);
  function type(value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  return { root, input, host, operations, selected, notified, session, type };
}

it('starts inactive, trims transport queries without changing raw input, and replaces the debounce', async () => {
  const { input, host, operations, session, type, notified } = setup();
  session.setQuery('  Ap  ');
  await vi.advanceTimersByTimeAsync(500);
  expect(operations.search).not.toHaveBeenCalled();
  expect(notified).not.toHaveBeenCalled();
  session.setActive(true);
  await vi.advanceTimersByTimeAsync(399);
  type('  Apple  ');
  session.setActive(true);
  await vi.advanceTimersByTimeAsync(399);
  expect(operations.search).not.toHaveBeenCalled();
  expect(input.value).toBe('  Apple  ');
  expect(input.classList.contains('searching')).toBe(true);
  expect(host.classList.contains('hidden')).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(operations.search).toHaveBeenCalledWith('Apple', expect.any(Function));
  expect(notified).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe('No results');
  expect(input.classList.contains('searching')).toBe(false);
});

it('clears obsolete choices immediately and ignores reversed successes', async () => {
  const { host, operations, session, type, selected } = setup();
  const old = deferred<FoodSearchResult>();
  const current = deferred<FoodSearchResult>();
  operations.search.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  session.setActive(true);
  type('old');
  await vi.advanceTimersByTimeAsync(400);
  type('new');
  expect(host.querySelector('.food-item')).toBeNull();
  await vi.advanceTimersByTimeAsync(400);
  current.resolve(result('New pear'));
  await vi.advanceTimersByTimeAsync(0);
  old.resolve(result('Old apple'));
  await vi.advanceTimersByTimeAsync(0);
  expect(host.querySelector('.food-item-name')!.textContent).toBe('New pear');
  const row = host.querySelector<HTMLElement>('.food-item')!;
  type('next');
  expect(host.querySelector('.food-item')).toBeNull();
  row.click();
  expect(selected).not.toHaveBeenCalled();
});

it('ignores stale rejection while loading, displays current failure and retries the same query', async () => {
  const { host, input, operations, session, type } = setup();
  const old = deferred<FoodSearchResult>();
  const current = deferred<FoodSearchResult>();
  operations.search.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  session.setActive(true);
  type('old');
  await vi.advanceTimersByTimeAsync(400);
  type('new');
  await vi.advanceTimersByTimeAsync(400);
  old.reject(new Error('Old failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(host.classList.contains('hidden')).toBe(true);
  expect(input.classList.contains('searching')).toBe(true);
  current.reject(new Error('Current failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(host.querySelector('.form-error')!.textContent).toBe('Search failed');
  expect(host.classList.contains('hidden')).toBe(false);
  expect(input.classList.contains('searching')).toBe(false);
  operations.search.mockResolvedValueOnce(result('Retry pear'));
  type('new');
  await vi.advanceTimersByTimeAsync(400);
  expect(host.querySelector('.food-item-name')!.textContent).toBe('Retry pear');
});

it('short ingredient queries clear and hide results and prevent a pending response reopening them', async () => {
  const { host, input, operations, session, type } = setup();
  const pending = deferred<FoodSearchResult>();
  operations.search.mockReturnValueOnce(pending.promise);
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  session.setQuery(' a ');
  expect(input.value).toBe(' a ');
  expect(host.classList.contains('hidden')).toBe(true);
  expect(input.classList.contains('searching')).toBe(false);
  pending.resolve(result('Old apple'));
  await vi.advanceTimersByTimeAsync(400);
  expect(host.textContent).toBe('');
  expect(operations.recent).not.toHaveBeenCalled();
});

it('guards meal defaults against newer searches and defaults, keeping source-labelled Recent', async () => {
  const { host, input, operations, session, type } = setup('meal');
  const oldDefault = deferred<{ foods: ReturnType<typeof food>[] }>();
  const middleDefault = deferred<{ foods: ReturnType<typeof food>[] }>();
  const currentDefault = deferred<{ foods: ReturnType<typeof food>[] }>();
  const search = deferred<FoodSearchResult>();
  operations.recent.mockReturnValueOnce(oldDefault.promise).mockReturnValueOnce(middleDefault.promise).mockReturnValueOnce(currentDefault.promise);
  operations.search.mockReturnValueOnce(search.promise);
  session.setActive(true);
  expect(host.textContent).toBe('Loading...');
  expect(input.classList.contains('searching')).toBe(false);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  oldDefault.resolve({ foods: [food('Old recent')] });
  await vi.advanceTimersByTimeAsync(0);
  expect(host.textContent).toBe('Searching...');
  type('');
  type('a');
  currentDefault.resolve({ foods: [food('Current recent')] });
  await vi.advanceTimersByTimeAsync(0);
  middleDefault.resolve({ foods: [food('Middle recent')] });
  search.resolve(result('Old search'));
  await vi.advanceTimersByTimeAsync(0);
  expect(host.querySelector('h4')!.textContent).toBe('Recent');
  expect(host.querySelector('.food-item-name')!.textContent).toBe('Current recent');
  expect(host.querySelector('.food-source')!.textContent).toBe('custom');
});

it.each(['meal', 'ingredient'] as const)('%s deactivates reads, retains the query and resumes once on repeated activation', async kind => {
  const { host, input, operations, session, type } = setup(kind);
  const pending = deferred<FoodSearchResult>();
  operations.search.mockReturnValueOnce(pending.promise).mockResolvedValue(result('Resumed pear'));
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  session.setActive(false);
  host.textContent = kind === 'meal' ? 'Another tab' : '';
  type('  Pear  ');
  pending.resolve(result('Old apple'));
  await vi.advanceTimersByTimeAsync(500);
  expect(host.textContent).toBe(kind === 'meal' ? 'Another tab' : '');
  expect(input.classList.contains('searching')).toBe(false);
  expect(operations.search).toHaveBeenCalledTimes(1);
  session.setActive(true);
  session.setActive(true);
  await vi.advanceTimersByTimeAsync(400);
  expect(operations.search).toHaveBeenLastCalledWith('Pear', expect.any(Function));
  expect(operations.search).toHaveBeenCalledTimes(2);
  expect(input.value).toBe('  Pear  ');
  expect(host.querySelector('.food-item-name')!.textContent).toBe('Resumed pear');
  session.setActive(false);
  session.setQuery('');
  session.setActive(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(host.textContent).toBe(kind === 'meal' ? 'Type to search for foods' : '');
});

it('disposes pending timers, reads and listeners without rewriting the parent DOM or reviving reconnected controls', async () => {
  const { root, host, input, operations, session, type, notified } = setup('meal');
  const recent = deferred<{ foods: ReturnType<typeof food>[] }>();
  const search = deferred<FoodSearchResult>();
  operations.recent.mockReturnValueOnce(recent.promise);
  operations.search.mockReturnValueOnce(search.promise);
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  type('pear');
  const before = root.innerHTML;
  session.dispose();
  session.dispose();
  root.remove();
  document.body.append(root);
  input.dispatchEvent(new Event('input'));
  session.setQuery('later');
  session.setActive(false);
  session.setActive(true);
  recent.resolve({ foods: [food('Default')] });
  search.reject(new Error('Old failure'));
  await vi.advanceTimersByTimeAsync(500);
  expect(root.innerHTML).toBe(before);
  expect(host.querySelector('.food-item')).toBeNull();
  expect(input.value).toBe('pear');
  expect(operations.search).toHaveBeenCalledTimes(1);
  expect(notified).toHaveBeenCalledTimes(2);
});

it.each(['meal', 'ingredient'] as const)('%s keeps partial saved matches selectable with searching feedback until completion', async kind => {
  const { host, input, operations, session, type, selected } = setup(kind);
  const pending = deferred<FoodSearchResult>();
  operations.search.mockImplementationOnce(async (_query, onSaved) => {
    onSaved?.([food('Saved apple')]);
    return pending.promise;
  });
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  expect(host.classList.contains('hidden')).toBe(false);
  expect(input.classList.contains('searching')).toBe(true);
  expect(host.textContent).toContain('Searching external foods...');
  host.querySelector<HTMLElement>('.food-item')!.click();
  expect(selected).toHaveBeenCalledWith(food('Saved apple'));
  expect(operations.saveExternal).not.toHaveBeenCalled();
  pending.resolve({ foods: [food('Saved apple')], external: [externalFood('External apple')] });
  await vi.advanceTimersByTimeAsync(0);
  expect(host.querySelectorAll('.food-item')).toHaveLength(2);
  expect(input.classList.contains('searching')).toBe(false);
  expect(host.textContent).not.toContain('Searching external foods...');
});

it.each(['meal', 'ingredient'] as const)('%s presents literal food text, measure counts, source labels and rounded Macros', async kind => {
  const { host, operations, session, type } = setup(kind);
  const saved = {
    ...food('Apple <img>'), brand: 'Brand <b>', serving_unit: '<unit>', source: 'usda',
    calories: 123.6, carbs_g: 10.6, protein_g: 5.4, fat_g: 4.5,
  };
  operations.search.mockResolvedValue({
    foods: [saved, { ...food('Malformed measures'), measures: '{bad', source: 'constructor' }],
    external: [
      { ...externalFood('External <script>'), brand: 'Farm <i>', servingUnit: '<external-unit>', source: 'fatsecret' },
      { ...externalFood('OFF'), source: 'openfoodfacts', measures: [] },
      { ...externalFood('Unknown'), source: '<unknown>' },
    ],
  });
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  const rows = host.querySelectorAll('.food-item');
  expect(rows[0].querySelector('.food-item-name')!.textContent).toBe(kind === 'meal' ? 'Apple <img>' : 'Apple <img> (Brand <b>)');
  expect(rows[0].querySelector('.food-brand')?.textContent).toBe(kind === 'meal' ? 'Brand <b>' : undefined);
  expect(rows[0].querySelector('.food-serving')!.textContent).toBe(`100<unit> · 2 units · USDA${kind === 'ingredient' ? ' · 124 kcal' : ''}`);
  expect(Array.from(rows[0].querySelectorAll('.macro-chip'), chip => chip.textContent)).toEqual(kind === 'meal' ? ['124', '11c', '5p', '5f'] : ['11c', '5p', '5f']);
  expect(rows[0].classList.contains('food-item-sm')).toBe(kind === 'ingredient');
  expect(rows[1].querySelector('.food-serving')!.textContent).toBe(`100g · constructor${kind === 'ingredient' ? ' · 100 kcal' : ''}`);
  expect(Array.from(host.querySelectorAll('.food-source'), label => label.textContent)).toEqual(['USDA', 'constructor', 'FatSecret', 'OFF', '<unknown>']);
  expect(Array.from(host.querySelectorAll('.food-source'), label => label.className)).toEqual([
    'food-source source-usda', 'food-source', 'food-source source-fatsecret', 'food-source source-openfoodfacts', 'food-source',
  ]);
  expect(rows[2].querySelector('.food-serving')!.textContent).toContain('100<external-unit> · 2 units · FatSecret');
  expect(rows[3].querySelector('.food-serving')!.textContent).not.toContain('units');
  expect(host.querySelector('img, b, script, i, unit, external-unit, unknown')).toBeNull();
  expect(Array.from(host.querySelectorAll('h4'), heading => heading.textContent)).toEqual(kind === 'meal' ? ['Saved Foods', 'External Results'] : []);
  expect(host.querySelector('.api-attribution a')?.getAttribute('href')).toBe(kind === 'meal' ? 'https://platform.fatsecret.com' : undefined);
});

it.each(['meal', 'ingredient'] as const)('%s submits each captured external selection and completes across live query, activity and result changes', async kind => {
  const { host, operations, session, type, selected } = setup(kind);
  const first = deferred<{ food: ReturnType<typeof food> }>();
  const second = deferred<{ food: ReturnType<typeof food> }>();
  const external = externalFood('Captured apple');
  operations.search.mockResolvedValueOnce({ foods: [], external: [external] }).mockResolvedValue(result('Replacement pear'));
  operations.saveExternal.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  const row = host.querySelector<HTMLElement>('.food-item')!;
  row.click();
  row.click();
  expect(operations.saveExternal.mock.calls).toEqual([[external], [external]]);
  expect(selected).not.toHaveBeenCalled();
  type('pear');
  await vi.advanceTimersByTimeAsync(400);
  session.setActive(false);
  second.resolve({ food: food('Second saved apple') });
  await vi.advanceTimersByTimeAsync(0);
  first.resolve({ food: food('First saved apple') });
  await vi.advanceTimersByTimeAsync(0);
  expect(selected.mock.calls).toEqual([[food('Second saved apple')], [food('First saved apple')]]);
});

it.each(['meal', 'ingredient'] as const)('%s alerts for a current external save failure and allows retry', async kind => {
  const { host, operations, session, type, selected } = setup(kind);
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  operations.search.mockResolvedValueOnce({ foods: [], external: [externalFood('Retry apple')] });
  operations.saveExternal.mockRejectedValueOnce(new Error('Save failed')).mockResolvedValueOnce({ food: food('Saved apple') });
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  host.querySelector<HTMLElement>('.food-item')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(alert).toHaveBeenCalledWith('Failed to save food');
  host.querySelector<HTMLElement>('.food-item')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(selected).toHaveBeenCalledWith(food('Saved apple'));
});

it.each(['success', 'failure'] as const)('a submitted save finishes silently after disposal and reconnection: %s', async outcome => {
  const { root, host, operations, session, type, selected } = setup();
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const pending = deferred<{ food: ReturnType<typeof food> }>();
  operations.search.mockResolvedValueOnce({ foods: [], external: [externalFood('Apple')] });
  operations.saveExternal.mockReturnValueOnce(pending.promise);
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  const row = host.querySelector<HTMLElement>('.food-item')!;
  row.click();
  session.dispose();
  root.remove();
  document.body.append(root);
  row.click();
  if (outcome === 'success') pending.resolve({ food: food('Persisted apple') });
  else pending.reject(new Error('Save failed'));
  await vi.advanceTimersByTimeAsync(0);
  expect(operations.saveExternal).toHaveBeenCalledTimes(1);
  expect(selected).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
});

it.each(['success', 'failure'] as const)('departure permanently suppresses a submitted save even if the old DOM reconnects before cleanup: %s', async outcome => {
  const { root, host, operations, session, type, selected, input } = setup();
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const pending = deferred<{ food: ReturnType<typeof food> }>();
  operations.search.mockResolvedValueOnce({ foods: [], external: [externalFood('Apple')] });
  operations.saveExternal.mockReturnValueOnce(pending.promise);
  session.setActive(true);
  type('apple');
  await vi.advanceTimersByTimeAsync(400);
  const row = host.querySelector<HTMLElement>('.food-item')!;
  row.click();
  root.remove();
  document.body.append(root);
  if (outcome === 'success') pending.resolve({ food: food('Persisted apple') });
  else pending.reject(new Error('Save failed'));
  await vi.advanceTimersByTimeAsync(0);
  row.click();
  session.setQuery('later');
  input.dispatchEvent(new Event('input'));
  await vi.advanceTimersByTimeAsync(500);
  expect(selected).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  expect(operations.saveExternal).toHaveBeenCalledTimes(1);
  expect(operations.search).toHaveBeenCalledTimes(1);
});

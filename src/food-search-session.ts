import type { ExternalFood, Food } from './types';
import type { foods as foodOperations } from './api';
import { textSpan } from './views/food-search-text';

export interface FoodSearchResult {
  foods: Food[];
  external: ExternalFood[];
}

type Source = 'search' | 'default' | null;
type FoodSearchSnapshot = { query: string; source: Source } & (
  | { status: 'ready' | 'partial'; result: FoodSearchResult }
  | { status: 'inactive' | 'idle' | 'debouncing' | 'loading' | 'error'; result: null }
);

function createFoodSearchSession({ search, loadDefault, onChange }: {
  search: (query: string, onSaved: (foods: Food[]) => void) => Promise<FoodSearchResult>;
  loadDefault?: () => Promise<FoodSearchResult>;
  onChange: (snapshot: FoodSearchSnapshot) => void;
}) {
  let query = '';
  let active = false;
  let disposed = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function invalidate() {
    clearTimeout(timer);
    timer = undefined;
    revision++;
  }

  function publish(status: Exclude<FoodSearchSnapshot['status'], 'ready' | 'partial'>, source: Source) {
    onChange({ query, status, source, result: null });
  }

  async function load(source: 'search' | 'default', current: number) {
    publish('loading', source);
    try {
      const result = await (source === 'search' ? search(query, foods => {
        if (current === revision && active && !disposed) {
          onChange({ query, status: 'partial', source, result: { foods, external: [] } });
        }
      }) : loadDefault!());
      if (current === revision && active && !disposed) {
        onChange({ query, status: 'ready', source, result });
      }
    } catch {
      if (current === revision && active && !disposed) publish('error', source);
    }
  }

  function resume() {
    if (!active) {
      publish('inactive', null);
    } else if (query.length >= 2) {
      const current = revision;
      publish('debouncing', 'search');
      timer = setTimeout(() => { void load('search', current); }, 400);
    } else if (loadDefault) {
      void load('default', revision);
    } else {
      publish('idle', null);
    }
  }

  return {
    setQuery(rawQuery: string) {
      if (disposed) return;
      invalidate();
      query = rawQuery.trim();
      resume();
    },
    setActive(next: boolean) {
      if (disposed || active === next) return;
      invalidate();
      active = next;
      resume();
    },
    dispose() {
      if (disposed) return;
      invalidate();
      disposed = true;
    },
  };
}

type Presentation = 'meal' | 'ingredient';

// Query revisions own reads and selectable rows. Submitted saves belong to this mount.
export function mountFoodSearch(root: HTMLElement, { kind, foods, onSelect, onQueryInput }: {
  kind: Presentation;
  foods: Pick<typeof foodOperations, 'search' | 'recent' | 'saveExternal'>;
  onSelect: (food: Food) => void;
  onQueryInput?: () => void;
}) {
  const input = root.querySelector<HTMLInputElement>(kind === 'meal' ? '#food-search' : '#ing-search')!;
  const host = root.querySelector<HTMLElement>(kind === 'meal' ? '#tab-content' : '#ing-results')!;
  const events = new AbortController();
  let disposed = false;
  let active = false;
  let rowsRevision = 0;
  const ancestors = new Set<Node>();
  for (let node: Node | null = root; node; node = node.parentNode) ancestors.add(node);
  const departed = (records: MutationRecord[]) => records.some(record =>
    Array.from(record.removedNodes).some(node => ancestors.has(node)));
  const departure = new MutationObserver(records => {
    if (departed(records)) controls.dispose();
  });
  departure.observe(root.ownerDocument, { childList: true, subtree: true });
  const isLive = () => {
    if (disposed) return false;
    // Drain removals too: a callback can run before the observer's microtask.
    if (!root.isConnected || departed(departure.takeRecords())) {
      controls.dispose();
      return false;
    }
    return true;
  };

  function appendRows(items: (Food | ExternalFood)[]) {
    const current = rowsRevision;
    const list = kind === 'meal' ? document.createElement('div') : host;
    if (kind === 'meal') list.className = 'food-list';
    for (const food of items) {
      const row = resultRow(food, kind, true);
      row.addEventListener('click', () => {
        if (!isLive() || !active || current !== rowsRevision || !host.contains(row)) return;
        if ('serving_size' in food) onSelect(food);
        else void selectExternal(food);
      }, { signal: events.signal });
      list.append(row);
    }
    if (kind === 'meal') host.append(list);
  }

  async function selectExternal(external: ExternalFood) {
    try {
      const { food } = await foods.saveExternal(external);
      if (isLive()) onSelect(food);
    } catch {
      if (isLive()) alert('Failed to save food');
    }
  }

  function renderResults({ foods: saved, external }: FoodSearchResult) {
    if (kind === 'meal' && saved.length) host.append(textHeading('Saved Foods'));
    if (saved.length) appendRows(saved);
    if (kind === 'meal' && external.length) host.append(textHeading('External Results'));
    if (external.length) appendRows(external);
    if (kind === 'meal' && external.some(food => food.source === 'fatsecret')) {
      const attribution = document.createElement('div');
      attribution.className = 'api-attribution';
      attribution.innerHTML = '<a href="https://platform.fatsecret.com" target="_blank" rel="noopener">Powered by FatSecret Platform API</a>';
      host.append(attribution);
    }
    if (!saved.length && !external.length) {
      host.innerHTML = kind === 'meal'
        ? '<p class="text-muted">No results found</p>'
        : '<p class="text-muted" style="padding:8px">No results</p>';
    }
  }

  const query = createFoodSearchSession({
    search: (text, onSaved) => foods.search(text, onSaved),
    loadDefault: kind === 'meal' ? async () => ({ foods: (await foods.recent()).foods, external: [] }) : undefined,
    onChange: snapshot => {
      if (!isLive()) return;
      rowsRevision++;
      input.classList.toggle('searching', snapshot.status === 'debouncing' || snapshot.status === 'partial' ||
        (snapshot.status === 'loading' && snapshot.source === 'search'));
      // The parent owns the shared meal tab host while search is inactive.
      if (kind === 'meal' && snapshot.status === 'inactive') return;
      host.replaceChildren();
      if (kind === 'ingredient') {
        host.classList.toggle('hidden', snapshot.status !== 'ready' && snapshot.status !== 'partial' && snapshot.status !== 'error');
      }
      if (snapshot.status === 'ready' || snapshot.status === 'partial') {
        if (snapshot.source === 'default') {
          if (snapshot.result.foods.length) {
            host.append(textHeading('Recent'));
            appendRows(snapshot.result.foods);
          } else host.innerHTML = '<p class="text-muted">Type to search for foods</p>';
        } else {
          renderResults(snapshot.result);
          if (snapshot.status === 'partial') host.insertAdjacentHTML('beforeend', '<p class="text-muted">Searching external foods...</p>');
        }
      } else if (snapshot.status === 'error') {
        host.innerHTML = snapshot.source === 'default'
          ? '<p class="text-muted">Type to search for foods</p>'
          : kind === 'meal' ? '<p class="form-error">Search failed</p>' : '<p class="form-error" style="padding:8px">Search failed</p>';
      } else if (kind === 'meal' && (snapshot.status === 'loading' || snapshot.status === 'debouncing')) {
        host.innerHTML = `<div class="loading-spinner">${snapshot.source === 'search' ? 'Searching...' : 'Loading...'}</div>`;
      }
    },
  });

  const controls = {
    setQuery(raw: string) {
      if (!isLive()) return;
      input.value = raw;
      query.setQuery(raw);
    },
    setActive(next: boolean) {
      if (!isLive()) return;
      active = next;
      query.setActive(next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      query.dispose();
      events.abort();
      departure.disconnect();
    },
  };
  input.addEventListener('input', () => {
    if (!isLive()) return;
    controls.setQuery(input.value);
    onQueryInput?.();
  }, { signal: events.signal });
  return controls;
}

// Explicit Recent/My Foods tabs use the same saved-row presentation as search.
export function renderSavedFoodList(container: HTMLElement, foods: Food[], onSelect: (food: Food) => void) {
  const list = document.createElement('div');
  list.className = 'food-list';
  for (const food of foods) {
    const row = resultRow(food, 'meal', false);
    row.addEventListener('click', () => {
      if (row.isConnected && container.contains(row)) onSelect(food);
    });
    list.append(row);
  }
  const existing = container.querySelector('.food-list');
  if (existing) existing.replaceWith(list);
  else container.append(list);
}

function textHeading(text: string) {
  const heading = document.createElement('h4');
  heading.className = 'section-label';
  heading.textContent = text;
  return heading;
}

function resultRow(food: Food | ExternalFood, kind: Presentation, showSource: boolean) {
  const detail = 'serving_size' in food ? {
    serving: `${food.serving_size}${food.serving_unit}${savedMeasureSuffix(food.measures)}`,
    carbs: food.carbs_g, protein: food.protein_g, fat: food.fat_g,
  } : {
    serving: `${food.servingSize}${food.servingUnit}${measureCountSuffix(food.measures?.length ?? 0)}`,
    carbs: food.carbsG, protein: food.proteinG, fat: food.fatG,
  };
  const item = document.createElement('div');
  item.className = kind === 'meal' ? 'food-item' : 'food-item food-item-sm';
  const info = document.createElement('div');
  info.className = 'food-item-info';
  const serving = textSpan('food-serving', showSource ? `${detail.serving} · ` : detail.serving);
  if (showSource) serving.append(sourceLabel(food.source));
  if (kind === 'ingredient') serving.append(document.createTextNode(` · ${Math.round(food.calories)} kcal`));
  info.append(
    textSpan('food-item-name', kind === 'ingredient' && food.brand ? `${food.name} (${food.brand})` : food.name),
    ...(kind === 'meal' && food.brand ? [textSpan('food-brand', food.brand)] : []),
    serving,
  );
  item.append(info, macroChips({ ...detail, calories: kind === 'meal' ? food.calories : undefined }));
  return item;
}

function measureCountSuffix(count: number): string {
  return count ? ` · ${count + 1} units` : '';
}

function savedMeasureSuffix(measures: string | null): string {
  try {
    const parsed = measures ? JSON.parse(measures) : [];
    return parsed.length ? measureCountSuffix(parsed.length) : '';
  } catch {
    return '';
  }
}

const SOURCE_LABELS: Record<string, string> = {
  fatsecret: 'FatSecret',
  usda: 'USDA',
  openfoodfacts: 'OFF',
};

function sourceLabel(source: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'food-source';
  const text = Object.prototype.hasOwnProperty.call(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : undefined;
  if (text) label.classList.add(`source-${source}`);
  label.textContent = text ?? source;
  return label;
}

function macroChips(macros: { calories?: number; carbs: number; protein: number; fat: number }): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'food-item-macros';
  if (macros.calories !== undefined) row.append(textSpan('macro-chip chip-calories', String(Math.round(macros.calories))));
  row.append(
    textSpan('macro-chip chip-carbs', `${Math.round(macros.carbs)}c`),
    textSpan('macro-chip chip-protein', `${Math.round(macros.protein)}p`),
    textSpan('macro-chip chip-fat', `${Math.round(macros.fat)}f`),
  );
  return row;
}

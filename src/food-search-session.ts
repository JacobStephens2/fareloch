import type { ExternalFood, Food } from './types';

export interface FoodSearchResult {
  foods: Food[];
  external: ExternalFood[];
}

type Source = 'search' | 'default' | null;
export type FoodSearchSnapshot = { query: string; source: Source } & (
  | { status: 'ready'; result: FoodSearchResult }
  | { status: 'inactive' | 'idle' | 'debouncing' | 'loading' | 'error'; result: null }
);

export function createFoodSearchSession({ search, loadDefault, onChange }: {
  search: (query: string) => Promise<FoodSearchResult>;
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

  function publish(status: Exclude<FoodSearchSnapshot['status'], 'ready'>, source: Source) {
    onChange({ query, status, source, result: null });
  }

  async function load(source: 'search' | 'default', current: number) {
    publish('loading', source);
    try {
      const result = await (source === 'search' ? search(query) : loadDefault!());
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

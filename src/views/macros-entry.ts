import { caloriesFromMacros, type Macros } from '../../server/src/nutrition';

type FormKind = 'quick' | 'custom' | 'manual';
type NullableMacros = { [Field in keyof Macros]: number | null };
type MacrosEntry<Values> = {
  read(): Values | undefined;
  hydrate(values: NullableMacros): void;
  dispose(): void;
};

export function mountMacrosEntry(host: HTMLElement, kind: 'manual', onChange?: () => void): MacrosEntry<NullableMacros>;
export function mountMacrosEntry(host: HTMLElement, kind: 'quick' | 'custom', onChange?: () => void): MacrosEntry<Macros>;
export function mountMacrosEntry(host: HTMLElement, kind: FormKind, onChange?: () => void): MacrosEntry<NullableMacros>;
// Controls, parsing and sticky calorie overrides belong to this mounted entry, not its parent's writes.
export function mountMacrosEntry(host: HTMLElement, kind: FormKind, onChange?: () => void): MacrosEntry<NullableMacros> {
  const prefix = { quick: 'quick', custom: 'cf', manual: 'manual' }[kind];
  host.innerHTML = `
    <div class="form-row">
      ${[['carbs', 'Carbs'], ['protein', 'Protein'], ['fat', 'Fat']].map(([name, label]) => `
        <div class="form-group">
          <label for="${prefix}-${name}">${label} (g)</label>
          <input type="number" id="${prefix}-${name}" min="0" step="0.1" />
        </div>
      `).join('')}
    </div>
    <div class="form-group">
      <label for="${prefix}-cal">Calories <span class="form-hint" id="${prefix}-cal-hint">(auto-calculated)</span></label>
      <input type="number" id="${prefix}-cal" min="0" step="1" />
    </div>
  `;
  const field = (name: string) => host.querySelector<HTMLInputElement>(`#${prefix}-${name}`)!;
  const fields = { calories: field('cal'), carbsG: field('carbs'), proteinG: field('protein'), fatG: field('fat') };
  const controls = Object.values(fields);
  let overridden = false;
  let disposed = false;
  const events = new AbortController();
  // Remember ancestors before removal: moving a retained entry out of a removed ancestor cannot revive it.
  const ancestors = new Set<Node>();
  for (let node: Node | null = host; node; node = node.parentNode) ancestors.add(node);
  const wasRemoved = (records: MutationRecord[]) => records.some(record =>
    [...record.removedNodes].some(node => ancestors.has(node) || controls.some(control => node === control || node.contains(control))),
  );
  const observer = new MutationObserver(records => { if (wasRemoved(records)) dispose(); });
  observer.observe(host.ownerDocument, { childList: true, subtree: true });

  function dispose() {
    if (disposed) return;
    disposed = true;
    events.abort();
    observer.disconnect();
  }
  function isLive() {
    if (disposed) return false;
    // Input/read/hydrate can run before the observer's microtask after synchronous removal and reattachment.
    if (wasRemoved(observer.takeRecords()) || !host.isConnected || controls.some(control => !host.contains(control))) dispose();
    return !disposed;
  }
  function parse(raw: string): number | null {
    if (kind !== 'manual') return parseFloat(raw) || 0;
    if (raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  for (const control of controls) {
    control.addEventListener('input', () => {
      if (!isLive()) return;
      if (control === fields.calories) overridden = true;
      else if (!overridden) {
        fields.calories.value = String(caloriesFromMacros(
          parseFloat(fields.carbsG.value) || 0,
          parseFloat(fields.proteinG.value) || 0,
          parseFloat(fields.fatG.value) || 0,
        ));
      }
      onChange?.();
    }, { signal: events.signal });
  }
  return {
    read() {
      if (!isLive()) return;
      return { calories: parse(fields.calories.value), carbsG: parse(fields.carbsG.value), proteinG: parse(fields.proteinG.value), fatG: parse(fields.fatG.value) };
    },
    hydrate(values) {
      if (!isLive()) return;
      for (const key of Object.keys(fields) as (keyof Macros)[]) fields[key].value = values[key] == null ? '' : String(values[key]);
    },
    dispose,
  };
}

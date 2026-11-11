import { foods, meals } from '../api';
import { createMountedLifetime } from '../mounted-lifetime';
import type { Food, MealType } from '../types';
import { mountMacrosEntry } from './macros-entry';

type FormOptions = {
  mealType: MealType;
  isParentLive: () => boolean;
} & (
  | { kind: 'quick'; date: string; onSaved: () => void }
  | { kind: 'custom'; onCreated: (food: Food) => void; onCancel: () => void }
);

// Local controls retire together; accepted persistence keeps its original Log Food owner.
export function mountLogFoodFormSession(host: HTMLElement, options: FormOptions): () => void {
  if (!host.isConnected || !options.isParentLive()) return () => {};
  const quick = options.kind === 'quick';
  const prefix = quick ? 'quick' : 'cf';
  const meal = options.mealType.charAt(0).toUpperCase() + options.mealType.slice(1);
  host.innerHTML = `
    <form id="${quick ? 'quick-form' : 'create-food-form'}"${quick ? ' class="quick-form"' : ''}>
      <div class="form-group">
        <label for="${prefix}-name">${quick ? 'Description (optional)' : 'Name *'}</label>
        <input type="text" id="${prefix}-name" ${quick ? 'placeholder="e.g. Handful of almonds"' : 'required'} />
      </div>
      ${quick ? '' : `
        <div class="form-group">
          <label for="cf-brand">Brand</label>
          <input type="text" id="cf-brand" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="cf-serving">Serving Size</label>
            <input type="number" id="cf-serving" value="1" min="0" step="0.1" />
          </div>
          <div class="form-group">
            <label for="cf-unit">Unit</label>
            <input type="text" id="cf-unit" value="serving" />
          </div>
        </div>
      `}
      <div id="${prefix}-macros"></div>
      <button type="submit" class="btn btn-primary btn-block">${quick ? 'Add' : 'Create & Add'} to ${meal}</button>
      ${quick ? '' : '<button type="button" id="cancel-create" class="btn btn-outline btn-block">Cancel</button>'}
    </form>
  `;
  const form = host.querySelector<HTMLFormElement>('form')!;
  const field = (id: string) => form.querySelector<HTMLInputElement>(`#${id}`)!;
  const name = field(`${prefix}-name`);
  const brand = field('cf-brand');
  const serving = field('cf-serving');
  const unit = field('cf-unit');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const cancel = form.querySelector<HTMLButtonElement>('#cancel-create');
  const macrosHost = form.querySelector<HTMLElement>(`#${prefix}-macros`)!;
  let lifetime: ReturnType<typeof createMountedLifetime> | undefined;
  const entry = mountMacrosEntry(macrosHost, options.kind, undefined, isLive);
  lifetime = createMountedLifetime(host, {
    ownedNodes: [form, ...form.querySelectorAll('input, button, [id]')],
    cleanup: () => entry.dispose(),
  });
  function isLive(): boolean {
    if (!lifetime?.isLive()) return false;
    if (options.isParentLive()) return true;
    lifetime.dispose();
    return false;
  }
  if (!isLive()) return lifetime.dispose;
  let submission: 'idle' | 'pending' | 'succeeded' = 'idle';

  cancel?.addEventListener('click', () => {
    if (!isLive() || options.kind !== 'custom') return;
    lifetime!.dispose();
    options.onCancel();
  }, { signal: lifetime.signal });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!isLive() || submission !== 'idle') return;
    const values = entry.read();
    if (!values) return;
    submission = 'pending';
    submit.disabled = true;
    let created: Food | undefined;
    try {
      if (options.kind === 'quick') {
        await meals.quickLog({ date: options.date, mealType: options.mealType, name: name.value || undefined, ...values });
      } else {
        const result = await foods.create({
          name: name.value,
          brand: brand.value || null,
          serving_size: parseFloat(serving.value) || 1,
          serving_unit: unit.value || 'serving',
          calories: values.calories,
          carbs_g: values.carbsG,
          protein_g: values.proteinG,
          fat_g: values.fatG,
        });
        created = result.food;
      }
    } catch {
      if (!isLive()) return;
      submission = 'idle';
      submit.disabled = false;
      submit.textContent = 'Failed - Retry';
      return;
    }
    submission = 'succeeded';
    if (options.kind === 'quick') options.onSaved();
    else options.onCreated(created!);
  }, { signal: lifetime.signal });
  return lifetime.dispose;
}

import { macrosOf, roundMacros, scaleMacros, unitScale } from '../../server/src/nutrition';
import type { Food, FoodMeasure } from '../types';
import { createMountedLifetime } from '../mounted-lifetime';

type QuantityFood = Pick<Food, 'brand' | 'serving_size' | 'serving_unit' | 'calories' | 'carbs_g' | 'protein_g' | 'fat_g' | 'measures'>;
type QuantityContext = { kind: 'meal' } | {
  kind: 'ingredient';
  stored?: { servings: number; quantity?: number };
};

type Selection = {
  quantity: number;
  servings: number;
  unitLabel?: string;
  unitScale?: number;
};

// One open form owns its controls, Unit scale, labels and Macros previews.
export function mountFoodQuantitySelection(host: HTMLElement, food: QuantityFood, context: QuantityContext) {
  const ingredient = context.kind === 'ingredient';
  const ids = ingredient
    ? { per: 'ing-modal-per-unit', label: 'ing-modal-per-label', unit: 'ing-unit-select', quantity: 'ing-qty', minus: 'ing-qty-minus', plus: 'ing-qty-plus', total: 'ing-modal-total' }
    : { per: 'modal-per-unit', label: 'modal-per-label', unit: 'unit-select', quantity: 'servings-input', minus: 'serv-minus', plus: 'serv-plus', total: 'modal-total' };
  let measures: FoodMeasure[] = [];
  try { measures = food.measures ? JSON.parse(food.measures) : []; } catch { /* No measure choices for invalid JSON. */ }
  const stored = context.kind === 'ingredient' ? context.stored : undefined;
  let scale = stored ? stored.servings / (stored.quantity ?? stored.servings) : 1;
  host.innerHTML = `
    ${food.brand ? '<p class="food-brand"></p>' : ''}
    <div class="modal-macros" id="${ids.per}"></div>
    <p class="text-muted" id="${ids.label}"></p>
    ${measures.length > 0 ? `<div class="form-group">
      <label for="${ids.unit}">Unit</label>
      <select id="${ids.unit}"><option value="default"></option></select>
    </div>` : ''}
    <div class="form-group">
      <label for="${ids.quantity}">Quantity</label>
      <div class="servings-control">
        <button ${ingredient ? 'type="button"' : ''} id="${ids.minus}" class="btn-icon">-</button>
        <input type="number" id="${ids.quantity}" value="1" min="1" step="1" />
        <button ${ingredient ? 'type="button"' : ''} id="${ids.plus}" class="btn-icon">+</button>
      </div>
    </div>
    <div class="modal-total" id="${ids.total}"></div>
  `;
  const find = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`#${id}`)!;
  const perUnit = find(ids.per);
  const perLabel = find(ids.label);
  const total = find(ids.total);
  const quantityInput = find<HTMLInputElement>(ids.quantity);
  const unitSelect = find<HTMLSelectElement>(ids.unit);
  quantityInput.value = String(stored ? (stored.quantity ?? Math.round(stored.servings * 100) / 100) : 1);
  assignFoodDetailText(host, food, perLabel, unitSelect?.querySelector('option'));
  if (unitSelect) assignSavedMeasureOptions(unitSelect, measures);
  assignPerUnitMacros(perUnit, food);
  const quantity = () => parseFloat(quantityInput.value) || 1;
  const updateTotal = () => assignTotalMacros(total, food, scale * quantity(), 'rounded');
  if (ingredient) updateTotal();
  else assignTotalMacros(total, food);

  // Track stable controls rather than the preview text nodes we replace ourselves.
  const controls = [quantityInput, perUnit, perLabel, total, find(ids.minus), find(ids.plus), unitSelect].filter(Boolean);
  const { isLive, signal, dispose } = createMountedLifetime(host, { ownedNodes: controls });
  function on(element: HTMLElement | null, event: 'click' | 'input' | 'change', action: () => void) {
    element?.addEventListener(event, () => { if (isLive()) action(); }, { signal });
  }
  on(quantityInput, 'input', updateTotal);
  on(find(ids.minus), 'click', () => {
    quantityInput.value = String(Math.max(1, quantity() - 1));
    updateTotal();
  });
  on(find(ids.plus), 'click', () => {
    quantityInput.value = String(quantity() + 1);
    updateTotal();
  });
  on(unitSelect, 'change', () => {
    if (unitSelect.value === 'default') {
      scale = 1;
      perLabel.textContent = `Per ${food.serving_size}${food.serving_unit}`;
    } else {
      const measure = measures[parseInt(unitSelect.value)];
      scale = unitScale(measure.gramWeight, food.serving_size);
      perLabel.textContent = `Per ${measure.label} (${measure.gramWeight}g)`;
    }
    assignPerUnitMacros(perUnit, food, scale, 'rounded');
    updateTotal();
  });
  return {
    read(): Selection | undefined {
      if (!isLive()) return;
      const qty = quantity();
      const measure = unitSelect && unitSelect.value !== 'default' ? measures[parseInt(unitSelect.value)] : undefined;
      if (ingredient) {
        const label = measure ? measure.label : `${food.serving_size}${food.serving_unit}`;
        return { quantity: qty, servings: qty * scale, unitLabel: qty !== 1 ? `${qty}x ${label}` : label };
      }
      return { quantity: qty, servings: qty * scale, ...(measure ? { unitLabel: measure.label, unitScale: scale } : {}) };
    },
    dispose,
  };
}

function assignFoodDetailText(
  root: ParentNode,
  food: { brand: string | null; serving_size: number; serving_unit: string },
  perLabel: Element,
  defaultOption: Element | null,
): void {
  if (food.brand) root.querySelector('.food-brand')!.textContent = food.brand;
  perLabel.textContent = `Per ${food.serving_size}${food.serving_unit}`;
  if (defaultOption) defaultOption.textContent = `${food.serving_size}${food.serving_unit} (default)`;
}

function assignSavedMeasureOptions(
  select: Element,
  measures: { label: string; gramWeight: number }[],
): void {
  measures.forEach((measure, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${measure.label} (${measure.gramWeight}g)`;
    select.append(option);
  });
}

type SavedFoodMacros = {
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
};

type MacroRounding = 'exact' | 'rounded';
type MacroField = 'calories' | 'carbs_g' | 'protein_g' | 'fat_g';

// Non-finite saved amounts stay text. Finite 'rounded' amounts use the Nutrition module's display rounding.
function macroText(value: number, scale: number, rounding: MacroRounding, field: MacroField): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (rounding === 'exact') return String(value);
  const rounded = roundMacros(
    scaleMacros(
      macrosOf({
        calories: field === 'calories' ? numeric : 0,
        carbs_g: field === 'carbs_g' ? numeric : 0,
        protein_g: field === 'protein_g' ? numeric : 0,
        fat_g: field === 'fat_g' ? numeric : 0,
      }),
      scale,
    ),
    'display',
  );
  const amount = field === 'calories' ? rounded.calories
    : field === 'carbs_g' ? rounded.carbsG
    : field === 'protein_g' ? rounded.proteinG
    : rounded.fatG;
  return String(amount);
}

function macroFigures(food: SavedFoodMacros, scale: number, rounding: MacroRounding) {
  return {
    calories: macroText(food.calories, scale, rounding, 'calories'),
    carbs: macroText(food.carbs_g, scale, rounding, 'carbs_g'),
    protein: macroText(food.protein_g, scale, rounding, 'protein_g'),
    fat: macroText(food.fat_g, scale, rounding, 'fat_g'),
  };
}

function macroLine(strongText: string, label: string): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'modal-macro';
  const strong = document.createElement('strong');
  strong.textContent = strongText;
  line.append(strong, document.createTextNode(` ${label}`));
  return line;
}

function totalLine(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function assignPerUnitMacros(
  container: Element,
  food: SavedFoodMacros,
  scale = 1,
  rounding: MacroRounding = 'exact',
): void {
  const figures = macroFigures(food, scale, rounding);
  container.textContent = '';
  container.append(
    macroLine(figures.calories, 'kcal'),
    macroLine(`${figures.carbs}g`, 'carbs'),
    macroLine(`${figures.protein}g`, 'protein'),
    macroLine(`${figures.fat}g`, 'fat'),
  );
}

function assignTotalMacros(
  container: Element,
  food: SavedFoodMacros,
  scale = 1,
  rounding: MacroRounding = 'exact',
): void {
  const figures = macroFigures(food, scale, rounding);
  container.textContent = '';
  container.append(
    totalLine(`${figures.calories} kcal`),
    totalLine(`${figures.carbs}g C`),
    totalLine(`${figures.protein}g P`),
    totalLine(`${figures.fat}g F`),
  );
}

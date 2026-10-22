const SOURCE_LABELS: Record<string, string> = {
  fatsecret: 'FatSecret',
  usda: 'USDA',
  openfoodfacts: 'OFF',
};

export function assignFoodDetailText(
  root: ParentNode,
  food: { brand: string | null; serving_size: number; serving_unit: string },
  perLabel: Element,
  defaultOption: Element | null,
): void {
  if (food.brand) root.querySelector('.food-brand')!.textContent = food.brand;
  perLabel.textContent = `Per ${food.serving_size}${food.serving_unit}`;
  if (defaultOption) defaultOption.textContent = `${food.serving_size}${food.serving_unit} (default)`;
}

export function assignSavedMeasureOptions(
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

export function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

export function measureCountSuffix(count: number): string {
  return count ? ` · ${count + 1} units` : '';
}

export function savedMeasureSuffix(measures: string | null): string {
  try {
    const parsed = measures ? JSON.parse(measures) : [];
    return parsed.length ? measureCountSuffix(parsed.length) : '';
  } catch {
    return '';
  }
}

export function sourceLabel(source: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'food-source';
  const text = SOURCE_LABELS[source];
  if (text) label.classList.add(`source-${source}`);
  label.textContent = text ?? source;
  return label;
}

export function macroChips(macros: { calories?: number; carbs: number; protein: number; fat: number }): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'food-item-macros';
  if (macros.calories !== undefined) {
    row.append(textSpan('macro-chip chip-calories', String(Math.round(macros.calories))));
  }
  row.append(
    textSpan('macro-chip chip-carbs', `${Math.round(macros.carbs)}c`),
    textSpan('macro-chip chip-protein', `${Math.round(macros.protein)}p`),
    textSpan('macro-chip chip-fat', `${Math.round(macros.fat)}f`),
  );
  return row;
}

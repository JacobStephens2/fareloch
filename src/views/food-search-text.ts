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

type SavedFoodMacros = {
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
};

// Non-finite saved amounts stay text; only finite numbers are scaled.
function macroText(value: number, scale: number, round: 'none' | 'kcal' | 'tenth'): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (round === 'none' && scale === 1) return String(value);
  const scaled = numeric * scale;
  if (round === 'kcal') return String(Math.round(scaled));
  if (round === 'tenth') return String(Math.round(scaled * 10) / 10);
  return String(scaled);
}

function macroRounds(amounts: 'saved' | 'scaled'): { calorie: 'none' | 'kcal'; gram: 'none' | 'tenth' } {
  if (amounts === 'scaled') return { calorie: 'kcal', gram: 'tenth' };
  return { calorie: 'none', gram: 'none' };
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

export function assignPerUnitMacros(
  container: Element,
  food: SavedFoodMacros,
  scale = 1,
  amounts: 'saved' | 'scaled' = 'saved',
): void {
  const round = macroRounds(amounts);
  container.textContent = '';
  container.append(
    macroLine(macroText(food.calories, scale, round.calorie), 'kcal'),
    macroLine(`${macroText(food.carbs_g, scale, round.gram)}g`, 'carbs'),
    macroLine(`${macroText(food.protein_g, scale, round.gram)}g`, 'protein'),
    macroLine(`${macroText(food.fat_g, scale, round.gram)}g`, 'fat'),
  );
}

export function assignTotalMacros(
  container: Element,
  food: SavedFoodMacros,
  scale = 1,
  amounts: 'saved' | 'scaled' = 'saved',
): void {
  const round = macroRounds(amounts);
  container.textContent = '';
  container.append(
    totalLine(`${macroText(food.calories, scale, round.calorie)} kcal`),
    totalLine(`${macroText(food.carbs_g, scale, round.gram)}g C`),
    totalLine(`${macroText(food.protein_g, scale, round.gram)}g P`),
    totalLine(`${macroText(food.fat_g, scale, round.gram)}g F`),
  );
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

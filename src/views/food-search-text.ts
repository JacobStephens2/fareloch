import { macrosOf, roundMacros, scaleMacros } from '../../server/src/nutrition';

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

export function assignPerUnitMacros(
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

export function assignTotalMacros(
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

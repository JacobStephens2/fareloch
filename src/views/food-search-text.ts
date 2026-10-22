export function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

export function savedMeasureSuffix(measures: string | null): string {
  try {
    const parsed = measures ? JSON.parse(measures) : [];
    return parsed.length ? ` · ${parsed.length + 1} units` : '';
  } catch {
    return '';
  }
}

export function sourceLabel(source: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'food-source';
  if (source === 'fatsecret' || source === 'usda' || source === 'openfoodfacts') {
    label.classList.add(`source-${source}`);
  }
  label.textContent = source === 'fatsecret' ? 'FatSecret'
    : source === 'usda' ? 'USDA'
    : source === 'openfoodfacts' ? 'OFF'
    : source;
  return label;
}

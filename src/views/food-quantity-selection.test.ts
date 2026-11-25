import { afterEach, describe, expect, it } from 'vitest';
import { food } from '../test/food-search-fixtures';
import { mountFoodQuantitySelection } from './food-quantity-selection';

afterEach(() => { document.body.replaceChildren(); });

it('two cups preview 400 kcal and return four effective servings with meal metadata', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const selection = mountFoodQuantitySelection(host, food('Oats'), { kind: 'meal' });
  const unit = host.querySelector<HTMLSelectElement>('#unit-select')!;
  unit.value = '0';
  unit.dispatchEvent(new Event('change'));
  const quantity = host.querySelector<HTMLInputElement>('#servings-input')!;
  quantity.value = '2';
  quantity.dispatchEvent(new Event('input'));
  expect(host.querySelector('#modal-total')!.textContent).toBe('400 kcal40g C20g P16g F');
  expect(selection.read()).toEqual({ quantity: 2, servings: 4, unitLabel: 'cup', unitScale: 2 });
  selection.dispose();
});

describe.each(['meal', 'ingredient'] as const)('%s Food quantity selection', kind => {
  const ids = kind === 'meal'
    ? { quantity: 'servings-input', unit: 'unit-select', minus: 'serv-minus', plus: 'serv-plus', per: 'modal-per-unit', label: 'modal-per-label', total: 'modal-total' }
    : { quantity: 'ing-qty', unit: 'ing-unit-select', minus: 'ing-qty-minus', plus: 'ing-qty-plus', per: 'ing-modal-per-unit', label: 'ing-modal-per-label', total: 'ing-modal-total' };
  function open(item = food('Oats')) {
    const host = document.createElement('div');
    document.body.append(host);
    const selection = mountFoodQuantitySelection(host, item, { kind });
    const find = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`#${id}`)!;
    const input = find<HTMLInputElement>(ids.quantity);
    const unit = find<HTMLSelectElement>(ids.unit);
    return {
      host, selection, find, input, unit,
      quantity(value: string) { input.value = value; input.dispatchEvent(new Event('input')); },
      measure(value: string) { unit.value = value; unit.dispatchEvent(new Event('change')); },
      per: () => [...find(ids.per).querySelectorAll('strong')].map(el => el.textContent),
      total: () => [...find(ids.total).querySelectorAll('span')].map(el => el.textContent),
    };
  }

  it('starts at one default serving and formats two cups for its caller', () => {
    const form = open();
    expect(form.input.value).toBe('1');
    expect(form.unit.value).toBe('default');
    expect(form.selection.read()).toEqual(kind === 'meal'
      ? { quantity: 1, servings: 1 }
      : { quantity: 1, servings: 1, unitLabel: '100g' });
    form.quantity('2');
    form.measure('0');
    expect(form.per()).toEqual(['200', '20g', '10g', '8g']);
    expect(form.total()).toEqual(['400 kcal', '40g C', '20g P', '16g F']);
    expect(form.selection.read()).toEqual(kind === 'meal'
      ? { quantity: 2, servings: 4, unitLabel: 'cup', unitScale: 2 }
      : { quantity: 2, servings: 4, unitLabel: '2x cup' });
    form.measure('default');
    expect(form.selection.read()).toEqual(kind === 'meal'
      ? { quantity: 2, servings: 2 }
      : { quantity: 2, servings: 2, unitLabel: '2x 100g' });
    form.quantity('1');
    form.measure('0');
    expect(form.selection.read()?.unitLabel).toBe('cup');
  });

  it('preserves exact initial figures and the distinct updated Display rounding', () => {
    const form = open({ ...food('Oats'), calories: 100.25, carbs_g: 10.123, protein_g: 5.678, fat_g: 4.567 });
    expect(form.per()).toEqual(['100.25', '10.123g', '5.678g', '4.567g']);
    expect(form.total()).toEqual(kind === 'meal'
      ? ['100.25 kcal', '10.123g C', '5.678g P', '4.567g F']
      : ['100 kcal', '10.1g C', '5.7g P', '4.6g F']);
    form.quantity('2');
    expect(form.per()).toEqual(['100.25', '10.123g', '5.678g', '4.567g']);
    expect(form.total()).toEqual(['201 kcal', '20.2g C', '11.4g P', '9.1g F']);
    form.measure('0');
    expect(form.per()).toEqual(['201', '20.2g', '11.4g', '9.1g']);
    expect(form.total()).toEqual(['401 kcal', '40.5g C', '22.7g P', '18.3g F']);
    form.measure('default');
    expect(form.per()).toEqual(['100', '10.1g', '5.7g', '4.6g']);
  });

  it('uses floating quantities and falsy-to-one fallback without rewriting typed input', () => {
    const form = open();
    for (const value of ['', '0', 'nonnumeric']) {
      form.quantity(value);
      expect(form.selection.read()?.quantity).toBe(1);
      expect(form.input.value).toBe(value === 'nonnumeric' ? '' : value);
    }
    form.quantity('0.5');
    expect(form.selection.read()?.servings).toBe(0.5);
    form.find(ids.plus).click();
    expect(form.input.value).toBe('1.5');
    form.quantity('-2');
    expect(form.selection.read()?.servings).toBe(-2);
    form.find(ids.plus).click();
    expect(form.input.value).toBe('-1');
    form.find(ids.minus).click();
    expect(form.input.value).toBe('1');
  });

  it.each([null, '', '{broken', '[]'])('offers no household choices for measures %s', measures => {
    const form = open({ ...food('Oats'), measures });
    expect(form.unit).toBeNull();
    form.quantity('2');
    expect(form.selection.read()?.servings).toBe(2);
  });

  it('uses the Nutrition serving-size fallback for measures', () => {
    const form = open({ ...food('Oats'), serving_size: 0 });
    form.measure('0');
    expect(form.selection.read()?.servings).toBe(200);
  });

  it('keeps brand, serving, measure labels and weights literal', () => {
    const form = open({ ...food('Oats'), brand: 'Acme<img alt="brand">', serving_unit: 'g<img alt="unit">',
      measures: JSON.stringify([{ label: 'cup</option><img alt="measure">', gramWeight: '200<img alt="weight">' }]),
    });
    expect(form.host.querySelector('img')).toBeNull();
    expect(form.host.querySelector('.food-brand')!.textContent).toBe('Acme<img alt="brand">');
    expect(form.find(ids.label).textContent).toBe('Per 100g<img alt="unit">');
    expect(form.unit.options[0].textContent).toBe('100g<img alt="unit"> (default)');
    expect(form.unit.options[1].textContent).toBe('cup</option><img alt="measure"> (200<img alt="weight">g)');
    form.measure('0');
    expect(form.find(ids.label).textContent).toBe('Per cup</option><img alt="measure"> (200<img alt="weight">g)');
    expect(form.host.querySelector('img')).toBeNull();
  });

  it.each([
    ['11<img alt="calories">', '22<img alt="carbs">', '33<img alt="protein">', '44<img alt="fat">'],
    [Infinity, -Infinity, NaN, 'nonnumeric'],
  ])('keeps nonnumeric and nonfinite saved Macros literal through updates (%s)', (calories, carbs_g, protein_g, fat_g) => {
    const form = open(Object.assign(food('Oats'), { calories, carbs_g, protein_g, fat_g }));
    const expectLiteral = () => {
      expect(form.host.querySelector('img')).toBeNull();
      expect(form.per()).toEqual([String(calories), `${carbs_g}g`, `${protein_g}g`, `${fat_g}g`]);
      expect(form.total()).toEqual([`${calories} kcal`, `${carbs_g}g C`, `${protein_g}g P`, `${fat_g}g F`]);
    };
    expectLiteral();
    form.quantity('3');
    expectLiteral();
    form.measure('0');
    expectLiteral();
  });

  it('permanently retires after ancestor departure and host extraction before observer delivery', () => {
    const ancestor = document.createElement('section');
    document.body.append(ancestor);
    const host = document.createElement('div');
    ancestor.append(host);
    const selection = mountFoodQuantitySelection(host, food('Oats'), { kind });
    const input = host.querySelector<HTMLInputElement>(`#${ids.quantity}`)!;
    const before = host.querySelector(`#${ids.total}`)!.textContent;
    ancestor.remove();
    document.body.append(host);
    document.body.append(ancestor);
    host.querySelector<HTMLElement>(`#${ids.plus}`)!.click();
    expect(input.value).toBe('1');
    expect(host.querySelector(`#${ids.total}`)!.textContent).toBe(before);
    expect(selection.read()).toBeUndefined();
  });

  it.each(['quantity', 'unit', 'minus', 'plus', 'per', 'label', 'total'] as const)('owns the stable %s node and retires controls and reader on its departure', name => {
    const form = open();
    const owned = form.find(ids[name]);
    const before = form.total();
    owned.remove();
    form.host.append(owned);
    form.find(ids.plus).click();
    expect(form.input.value).toBe('1');
    form.quantity('3');
    form.measure('0');
    expect(form.total()).toEqual(before);
    expect(form.selection.read()).toBeUndefined();
    const current = mountFoodQuantitySelection(form.host, food('New food'), { kind });
    expect(current.read()?.servings).toBe(1);
  });
});

it.each([
  { servings: 4, quantity: 2, displayed: '2', effective: 4, total: '400 kcal' },
  { servings: 1.23456, quantity: undefined, displayed: '1.23', effective: 1.23, total: '123 kcal' },
  { servings: 0, quantity: 2, displayed: '2', effective: 0, total: '0 kcal' },
  { servings: 4, quantity: 0, displayed: '0', effective: Infinity, total: 'Infinity kcal' },
  { servings: 0, quantity: undefined, displayed: '0', effective: NaN, total: 'NaN kcal' },
])('restores ingredient quantities and scales with the existing zero behavior: $servings / $quantity', ({ servings, quantity, displayed, effective, total }) => {
  const host = document.createElement('div');
  document.body.append(host);
  const selection = mountFoodQuantitySelection(host, food('Oats'), { kind: 'ingredient', stored: { servings, quantity } });
  expect(host.querySelector<HTMLInputElement>('#ing-qty')!.value).toBe(displayed);
  expect(host.querySelector<HTMLSelectElement>('#ing-unit-select')!.value).toBe('default');
  expect(host.querySelector('#ing-modal-per-unit strong')!.textContent).toBe('100');
  expect(host.querySelector('#ing-modal-per-label')!.textContent).toBe('Per 100g');
  expect(host.querySelector('#ing-modal-total span')!.textContent).toBe(total);
  expect(selection.read()?.servings).toBe(effective);
});

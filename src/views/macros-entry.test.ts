import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountMacrosEntry } from './macros-entry';

afterEach(() => { document.body.replaceChildren(); });

describe.each(['quick', 'custom', 'manual'] as const)('%s Macros entry', kind => {
  const prefix = { quick: 'quick', custom: 'cf', manual: 'manual' }[kind];
  function open(parent: HTMLElement = document.body) {
    const host = document.createElement('div');
    parent.append(host);
    const changed = vi.fn();
    const entry = mountMacrosEntry(host, kind, changed);
    const field = (name: string) => host.querySelector<HTMLInputElement>(`#${prefix}-${name}`)!;
    return {
      host, entry, changed, field,
      input(name: string, value: string) {
        field(name).value = value;
        field(name).dispatchEvent(new Event('input'));
      },
    };
  }

  it('calculates on gram input and publishes current reads after every override and gram edit', () => {
    const form = open();
    expect(form.field('cal').value).toBe('');
    expect(form.changed).not.toHaveBeenCalled();
    const reads: unknown[] = [];
    form.changed.mockImplementation(() => reads.push(form.entry.read()));
    form.input('carbs', '10');
    expect(form.field('cal').value).toBe('40');
    form.input('protein', '5');
    form.input('fat', '4');
    expect(form.entry.read()).toEqual({ calories: 96, carbsG: 10, proteinG: 5, fatG: 4 });
    form.input('cal', '200');
    form.input('carbs', '20');
    form.input('protein', '12');
    form.input('fat', '8');
    expect(reads).toEqual([
      { calories: 40, carbsG: 10, proteinG: kind === 'manual' ? null : 0, fatG: kind === 'manual' ? null : 0 },
      { calories: 60, carbsG: 10, proteinG: 5, fatG: kind === 'manual' ? null : 0 },
      { calories: 96, carbsG: 10, proteinG: 5, fatG: 4 },
      { calories: 200, carbsG: 10, proteinG: 5, fatG: 4 },
      { calories: 200, carbsG: 20, proteinG: 5, fatG: 4 },
      { calories: 200, carbsG: 20, proteinG: 12, fatG: 4 },
      { calories: 200, carbsG: 20, proteinG: 12, fatG: 8 },
    ]);
  });

  it('preserves field IDs, accessible labels, hints, numeric attributes and layout', () => {
    const form = open();
    expect(form.host.querySelectorAll('.form-row .form-group')).toHaveLength(3);
    for (const [name, label, step] of [['carbs', 'Carbs (g)', '0.1'], ['protein', 'Protein (g)', '0.1'], ['fat', 'Fat (g)', '0.1'], ['cal', 'Calories (auto-calculated)', '1']]) {
      const field = form.field(name);
      expect(field.type).toBe('number');
      expect(field.min).toBe('0');
      expect(field.step).toBe(step);
      expect(field.labels?.[0].textContent).toBe(label);
    }
    expect(form.host.querySelector(`#${prefix}-cal-hint`)?.textContent).toBe('(auto-calculated)');
  });

  it('reads current blank, zero and numeric fields without calculating or notifying', () => {
    const form = open();
    const blank = kind === 'manual' ? null : 0;
    expect(form.entry.read()).toEqual({ calories: blank, carbsG: blank, proteinG: blank, fatG: blank });
    form.field('carbs').value = '1e2';
    form.field('protein').value = '-2';
    form.field('fat').value = '0.25';
    expect(form.entry.read()).toEqual({ calories: blank, carbsG: 100, proteinG: -2, fatG: 0.25 });
    expect(form.field('cal').value).toBe('');
    form.field('cal').value = '0';
    expect(form.entry.read()?.calories).toBe(0);
    form.field('cal').value = 'nonnumeric';
    expect(form.entry.read()?.calories).toBe(blank);
    expect(form.changed).not.toHaveBeenCalled();
  });

  it.each(['0', ''])('keeps a calorie override of %j sticky and still notifies for every gram field', override => {
    const form = open();
    form.input('cal', override);
    for (const name of ['carbs', 'protein', 'fat']) {
      form.input(name, '10');
      expect(form.field('cal').value).toBe(override);
    }
    expect(form.changed).toHaveBeenCalledTimes(4);
    expect(form.entry.read()).toEqual({ calories: override === '' && kind === 'manual' ? null : 0, carbsG: 10, proteinG: 10, fatG: 10 });
  });

  it.each([false, true])('hydrates silently while preserving a prior user override of %s', overridden => {
    const form = open();
    if (overridden) form.input('cal', '200');
    form.changed.mockClear();
    form.entry.hydrate({ calories: 0, carbsG: 10, proteinG: null, fatG: null });
    expect(form.field('cal').value).toBe('0');
    expect(form.field('protein').value).toBe('');
    expect(form.field('fat').value).toBe('');
    expect(form.changed).not.toHaveBeenCalled();
    form.input('carbs', '20');
    expect(form.field('cal').value).toBe(overridden ? '0' : '80');
    expect(form.changed).toHaveBeenCalledOnce();
  });

  it('keeps simultaneous entries independent, including after one is disposed', () => {
    const first = open();
    const second = open();
    first.input('cal', '200');
    second.input('carbs', '10');
    expect(first.entry.read()?.calories).toBe(200);
    expect(second.entry.read()?.calories).toBe(40);
    first.entry.dispose();
    second.input('carbs', '20');
    expect(second.entry.read()?.calories).toBe(80);
    expect(second.changed).toHaveBeenCalledTimes(2);
  });

  const removals = ['dispose', 'host', 'control', 'row', 'ancestor', 'ancestor then move host'] as const;
  it.each(removals.flatMap(removal => (['input', 'read', 'hydrate', 'observer'] as const).map(first => ({ removal, first }))))('permanently retires after $removal, checking $first first', async ({ removal, first }) => {
    const wrapper = document.createElement('section');
    document.body.append(wrapper);
    const form = open(wrapper);
    const entry = form.entry;
    form.input('carbs', '10');
    form.changed.mockClear();
    const cal = form.field('cal');
    const carbs = form.field('carbs');
    if (removal === 'dispose') { entry.dispose(); entry.dispose(); }
    else if (removal === 'host') { form.host.remove(); wrapper.append(form.host); }
    else if (removal === 'control') { carbs.remove(); form.host.append(carbs); }
    else if (removal === 'row') {
      const row = carbs.closest('.form-row')!;
      row.remove(); form.host.append(row);
    } else {
      wrapper.remove();
      if (removal === 'ancestor then move host') document.body.append(form.host);
      document.body.append(wrapper);
    }
    const hydrate = () => entry.hydrate({ calories: 999, carbsG: 99, proteinG: 99, fatG: 99 });
    if (first === 'read') expect(entry.read()).toBeUndefined();
    else if (first === 'hydrate') hydrate();
    else if (first === 'observer') await Promise.resolve();
    carbs.value = '20';
    carbs.dispatchEvent(new Event('input'));
    hydrate();
    expect(entry.read()).toBeUndefined();
    expect(cal.value).toBe('40');
    expect(carbs.value).toBe('20');
    expect(form.changed).not.toHaveBeenCalled();
  });
});

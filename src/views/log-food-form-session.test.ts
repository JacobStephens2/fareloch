import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { foods, meals, setToken } from '../api';
import { setGuestMode } from '../local-db';
import { createMountedLifetime } from '../mounted-lifetime';
import { deferred, food } from '../test/food-search-fixtures';
import { mountLogFoodFormSession } from './log-food-form-session';

type Kind = 'quick' | 'custom';
const date = '2026-04-01';
const disposers: (() => void)[] = [];
const find = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const input = (selector: string, value: string) => {
  const control = find<HTMLInputElement>(selector);
  control.value = value;
  control.dispatchEvent(new Event('input'));
};

function mount(kind: Kind, isParentLive = () => true, host = find('#content')) {
  const saved = vi.fn();
  const created = vi.fn();
  const canceled = vi.fn();
  const dispose = mountLogFoodFormSession(host, kind === 'quick'
    ? { kind, date, mealType: 'lunch', isParentLive, onSaved: saved }
    : { kind, mealType: 'lunch', isParentLive, onCreated: created, onCancel: canceled });
  disposers.push(dispose);
  return {
    form: host.querySelector<HTMLFormElement>('form')!,
    prefix: kind === 'quick' ? 'quick' : 'cf',
    dispose, saved, created, canceled,
  };
}
const submit = (form: HTMLFormElement) => form.dispatchEvent(new Event('submit', { cancelable: true }));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const records = async (kind: Kind) => kind === 'quick' ? (await meals.getByDate(date)).meals : (await foods.custom()).foods;

beforeEach(() => {
  localStorage.clear();
  setGuestMode(true);
  document.body.innerHTML = '<main><button id="parent-fixed">Back</button><section><div id="content"></div></section></main>';
});
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['quick', 'custom'] as const)('%s never reads a successor name control', async kind => {
  const { form, prefix } = mount(kind);
  input(`#${prefix}-name`, 'Captured name');
  const name = find<HTMLInputElement>(`#${prefix}-name`);
  const successor = name.cloneNode(true) as HTMLInputElement;
  successor.value = 'Successor';
  name.replaceWith(successor);
  submit(form);
  expect((await meals.getByDate(date)).meals).toHaveLength(0);
  expect((await foods.custom()).foods).toHaveLength(0);
});

it.each(['quick', 'custom'] as const)('%s consumes synchronous submissions exactly once', async kind => {
  const { form, prefix, saved, created } = mount(kind);
  input(`#${prefix}-name`, 'One save');
  submit(form);
  submit(form);
  await settle();
  form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = false;
  submit(form);
  await settle();
  expect(await records(kind)).toHaveLength(1);
  expect(kind === 'quick' ? saved : created).toHaveBeenCalledOnce();
});

it.each(['quick', 'custom'] as const)('%s failure leaves a replaced form button untouched', async kind => {
  const { form, prefix } = mount(kind);
  setGuestMode(false);
  setToken('form-token');
  const response = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => response.promise));
  input(`#${prefix}-name`, 'Pending save');
  submit(form);
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  mount('quick');
  const before = button.outerHTML;
  response.resolve(Response.json({ error: 'Unavailable' }, { status: 503 }));
  await settle();
  expect(button.outerHTML).toBe(before);
});

it.each(['quick', 'custom'] as const)('%s guest save captures metadata, automatic calories and overrides once', async kind => {
  const { form, prefix, saved, created } = mount(kind);
  input(`#${prefix}-name`, 'Captured snack');
  if (kind === 'custom') {
    input('#cf-brand', 'Farm');
    input('#cf-serving', '50.5');
    input('#cf-unit', 'g');
  }
  input(`#${prefix}-carbs`, '10');
  input(`#${prefix}-protein`, '5');
  input(`#${prefix}-fat`, '4');
  expect(find<HTMLInputElement>(`#${prefix}-cal`).value).toBe('96');
  input(`#${prefix}-cal`, '123');
  input(`#${prefix}-carbs`, '20');
  expect(find<HTMLInputElement>(`#${prefix}-cal`).value).toBe('123');
  expect(form.querySelector('button[type="submit"]')!.textContent).toBe(kind === 'quick' ? 'Add to Lunch' : 'Create & Add to Lunch');
  submit(form);
  input(`#${prefix}-name`, 'Later name');
  input(`#${prefix}-cal`, '999');
  if (kind === 'custom') {
    input('#cf-brand', 'Later brand');
    input('#cf-serving', '99');
    input('#cf-unit', 'later');
  }
  await settle();
  const savedRecords = await records(kind);
  expect(savedRecords).toHaveLength(1);
  expect(savedRecords[0]).toMatchObject({
    calories: 123, carbs_g: 20, protein_g: 5, fat_g: 4,
    ...(kind === 'quick' ? { date, meal_type: 'lunch', note: 'Captured snack' }
      : { name: 'Captured snack', brand: 'Farm', serving_size: 50.5, serving_unit: 'g' }),
  });
  if (kind === 'quick') expect(saved).toHaveBeenCalledOnce();
  else expect(created).toHaveBeenCalledExactlyOnceWith(savedRecords[0]);
});

it.each(['quick', 'custom'] as const)('%s preserves blank metadata and numeric fallbacks', async kind => {
  const { form } = mount(kind);
  if (kind === 'custom') {
    input('#cf-name', 'Blank defaults');
    input('#cf-serving', '0');
    input('#cf-unit', '');
  }
  submit(form);
  await settle();
  expect((await records(kind))[0]).toMatchObject({
    calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0,
    ...(kind === 'quick' ? { note: null } : { brand: null, serving_size: 1, serving_unit: 'serving' }),
  });
});

const fixedDepartures = (['quick', 'custom'] as const).flatMap(kind => {
  const prefix = kind === 'quick' ? 'quick' : 'cf';
  return ['form', '#content', 'section', 'main', 'form > .form-group', `#${prefix}-macros .form-row`, `#${prefix}-name`, 'button[type="submit"]', `#${prefix}-macros`,
    `#${prefix}-carbs`, `#${prefix}-protein`, `#${prefix}-fat`, `#${prefix}-cal`,
    ...(kind === 'custom' ? ['#cf-brand', '#cf-serving', '#cf-unit', '#cancel-create'] : []),
  ].flatMap(selector => (['replacement', 'reconnection'] as const).map(mode => ({ kind, selector, mode })));
});

it.each(fixedDepartures)('$kind $selector $mode permanently retires all local controls before observer delivery', async ({ kind, selector, mode }) => {
  const { form, prefix, canceled } = mount(kind);
  input(`#${prefix}-carbs`, '10');
  const carbs = form.querySelector<HTMLInputElement>(`#${prefix}-carbs`)!;
  const calories = form.querySelector<HTMLInputElement>(`#${prefix}-cal`)!;
  const cancel = form.querySelector<HTMLButtonElement>('#cancel-create');
  const node = find(selector);
  const parent = node.parentNode!;
  node.remove();
  parent.append(mode === 'replacement' ? node.cloneNode(true) : node);
  if (mode === 'replacement') parent.append(node);
  const before = document.body.innerHTML;
  carbs.value = '20';
  carbs.dispatchEvent(new Event('input'));
  submit(form);
  cancel?.click();
  expect(calories.value).toBe('40');
  expect(document.body.innerHTML).toBe(before);
  expect(canceled).not.toHaveBeenCalled();
  expect(await records(kind)).toHaveLength(0);
  await settle();
  submit(form);
  cancel?.click();
  expect(await records(kind)).toHaveLength(0);
});

it.each(['quick', 'custom'] as const)('%s disposal is idempotent, preserves retained DOM and allows an independent fresh mount', async kind => {
  const old = mount(kind);
  input(`#${old.prefix}-cal`, '200');
  const before = old.form.outerHTML;
  old.dispose();
  old.dispose();
  expect(old.form.outerHTML).toBe(before);
  const fresh = mount(kind);
  find('#content').append(old.form);
  const oldCarbs = old.form.querySelector<HTMLInputElement>(`#${old.prefix}-carbs`)!;
  oldCarbs.value = '30';
  oldCarbs.dispatchEvent(new Event('input'));
  submit(old.form);
  old.form.querySelector<HTMLButtonElement>('#cancel-create')?.click();
  expect(old.form.querySelector<HTMLInputElement>(`#${old.prefix}-cal`)!.value).toBe('200');
  expect(await records(kind)).toHaveLength(0);
  expect(old.canceled).not.toHaveBeenCalled();
  const currentCarbs = fresh.form.querySelector<HTMLInputElement>(`#${fresh.prefix}-carbs`)!;
  const currentCalories = fresh.form.querySelector<HTMLInputElement>(`#${fresh.prefix}-cal`)!;
  expect(currentCalories.value).toBe('');
  expect(currentCarbs.value).toBe('');
  currentCarbs.value = '10';
  currentCarbs.dispatchEvent(new Event('input'));
  expect(currentCalories.value).toBe('40');
  submit(fresh.form);
  expect(await records(kind)).toHaveLength(1);
});

it.each(['quick', 'custom'] as const)('%s rejects initially ineligible hosts and permanently retires after parent ineligibility', async kind => {
  const disconnected = document.createElement('div');
  disconnected.textContent = 'Unrendered';
  const before = disconnected.outerHTML;
  const rejected = mount(kind, () => true, disconnected);
  expect(disconnected.outerHTML).toBe(before);
  find('#content').append(disconnected);
  rejected.dispose();
  rejected.dispose();
  let parentLive = false;
  const host = find('#content');
  const html = host.innerHTML;
  const ineligible = mount(kind, () => parentLive);
  expect(host.innerHTML).toBe(html);
  ineligible.dispose();
  parentLive = true;
  const fresh = mount(kind, () => parentLive);
  input(`#${fresh.prefix}-carbs`, '10');
  parentLive = false;
  input(`#${fresh.prefix}-carbs`, '20');
  parentLive = true;
  input(`#${fresh.prefix}-carbs`, '30');
  submit(fresh.form);
  fresh.form.querySelector<HTMLButtonElement>('#cancel-create')?.click();
  expect(find<HTMLInputElement>(`#${fresh.prefix}-cal`).value).toBe('40');
  expect(await records(kind)).toHaveLength(0);
  expect(fresh.canceled).not.toHaveBeenCalled();
});

it.each(['quick', 'custom'] as const)('%s parent fixed-node departure retires Macros, submission and Cancel synchronously', async kind => {
  const parent = createMountedLifetime(find('main'), { ownedNodes: [find('#parent-fixed')] });
  disposers.push(parent.dispose);
  const current = mount(kind, parent.isLive);
  input(`#${current.prefix}-carbs`, '10');
  const fixed = find('#parent-fixed');
  fixed.replaceWith(fixed.cloneNode(true));
  input(`#${current.prefix}-carbs`, '20');
  submit(current.form);
  current.form.querySelector<HTMLButtonElement>('#cancel-create')?.click();
  expect(find<HTMLInputElement>(`#${current.prefix}-cal`).value).toBe('40');
  expect(current.canceled).not.toHaveBeenCalled();
  expect(await records(kind)).toHaveLength(0);
});

it.each(['quick', 'custom'] as const)('%s authenticated pending save captures payload and credentials, permits one live retry, then stays consumed', async kind => {
  setGuestMode(false);
  setToken('form-token');
  const first = deferred<Response>();
  const retry = deferred<Response>();
  const network = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  vi.stubGlobal('fetch', network);
  const current = mount(kind);
  input(`#${current.prefix}-name`, 'HTTP snack');
  input(`#${current.prefix}-carbs`, '10');
  input(`#${current.prefix}-protein`, '5');
  input(`#${current.prefix}-fat`, '4');
  if (kind === 'custom') {
    input('#cf-brand', 'HTTP farm');
    input('#cf-serving', '50');
    input('#cf-unit', 'g');
  }
  const button = current.form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submit(current.form);
  expect(button.disabled).toBe(true);
  button.disabled = false;
  submit(current.form);
  expect(network).toHaveBeenCalledExactlyOnceWith(kind === 'quick' ? '/api/meals/quick' : '/api/foods', expect.objectContaining({
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer form-token' },
    body: JSON.stringify(kind === 'quick'
      ? { date, mealType: 'lunch', name: 'HTTP snack', calories: 96, carbsG: 10, proteinG: 5, fatG: 4 }
      : { name: 'HTTP snack', brand: 'HTTP farm', servingSize: 50, servingUnit: 'g', calories: 96, carbsG: 10, proteinG: 5, fatG: 4 }),
  }));
  input(`#${current.prefix}-name`, 'Retry name');
  first.resolve(Response.json({ error: 'Unavailable' }, { status: 503 }));
  await vi.waitFor(() => expect(button.textContent).toBe('Failed - Retry'));
  expect(button.disabled).toBe(false);
  submit(current.form);
  expect(network).toHaveBeenCalledTimes(2);
  expect(JSON.parse(network.mock.calls[1][1].body).name).toBe('Retry name');
  retry.resolve(Response.json({ food: food('Saved HTTP food'), meal: { id: 10 } }));
  await vi.waitFor(() => expect(kind === 'quick' ? current.saved : current.created).toHaveBeenCalledOnce());
  const before = current.form.outerHTML;
  submit(current.form);
  await settle();
  expect(network).toHaveBeenCalledTimes(2);
  expect(current.form.outerHTML).toBe(before);
});

it.each((['quick', 'custom'] as const).flatMap(kind =>
  (['success', 'failure'] as const).flatMap(outcome =>
    ['dispose', 'replacement', 'form reconnection', 'metadata replacement', 'Macros replacement', 'ancestor reconnection', 'parent departure', ...(kind === 'custom' ? ['Cancel'] : [])]
      .map(retirement => ({ kind, outcome, retirement })))))(
  '$kind pending $outcome after $retirement keeps old and successor DOM intact', async ({ kind, outcome, retirement }) => {
  setGuestMode(false);
  setToken('form-token');
  const response = deferred<Response>();
  const network = vi.fn(() => response.promise);
  vi.stubGlobal('fetch', network);
  const parent = createMountedLifetime(find('main'), { ownedNodes: [find('#parent-fixed')] });
  disposers.push(parent.dispose);
  const current = mount(kind, parent.isLive);
  input(`#${current.prefix}-name`, 'Pending snack');
  submit(current.form);
  if (retirement === 'dispose') current.dispose();
  else if (retirement === 'replacement') mount('quick', parent.isLive);
  else if (retirement === 'Cancel') current.form.querySelector<HTMLButtonElement>('#cancel-create')!.click();
  else {
    const node = retirement === 'form reconnection' ? current.form
      : retirement === 'metadata replacement' ? find(`#${current.prefix}-name`)
      : retirement === 'Macros replacement' ? find(`#${current.prefix}-cal`)
      : retirement === 'parent departure' ? find('#parent-fixed') : find('section');
    const owner = node.parentNode!;
    node.remove();
    owner.append(retirement.includes('replacement') ? node.cloneNode(true) : node);
  }
  const old = current.form.outerHTML;
  const successor = document.body.innerHTML;
  response.resolve(outcome === 'success' ? Response.json({ food: food('Created snack'), meal: { id: 10 } })
    : Response.json({ error: 'Unavailable' }, { status: 503 }));
  await settle();
  expect(current.form.outerHTML).toBe(old);
  expect(document.body.innerHTML).toBe(successor);
  expect(kind === 'quick' ? current.saved : current.created).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
  submit(current.form);
  expect(network).toHaveBeenCalledOnce();
});

it('Custom Food Cancel stays available during persistence and retires before notifying the parent', async () => {
  setGuestMode(false);
  const response = deferred<Response>();
  const network = vi.fn(() => response.promise);
  vi.stubGlobal('fetch', network);
  const current = mount('custom');
  input('#cf-name', 'Pending food');
  const cancel = find<HTMLButtonElement>('#cancel-create');
  current.canceled.mockImplementation(() => {
    // A synchronous parent callback cannot reenter the canceled form.
    input('#cf-carbs', '20');
    submit(current.form);
    cancel.click();
  });
  input('#cf-carbs', '10');
  submit(current.form);
  expect(cancel.disabled).toBe(false);
  cancel.click();
  expect(current.canceled).toHaveBeenCalledOnce();
  expect(find<HTMLInputElement>('#cf-cal').value).toBe('40');
  response.resolve(Response.json({ food: food('Accepted food') }));
  await vi.waitFor(() => expect(current.created).toHaveBeenCalledExactlyOnceWith(food('Accepted food')));
  submit(current.form);
  expect(network).toHaveBeenCalledOnce();
});

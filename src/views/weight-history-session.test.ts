import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { weight } from '../api';
import { reading } from '../test/weight-fixtures';
import { departAndReconnect } from '../test/mounted-lifetime-fixtures';
import { deferred } from '../test/food-search-fixtures';
import { mountWeightHistorySession } from './weight-history-session';

let host: HTMLElement;
let dispose = () => {};

function open(logs = [reading()], isParentLive = () => true) {
  dispose();
  const onDeleteSuccess = vi.fn();
  dispose = mountWeightHistorySession(host, { logs, isParentLive, onDeleteSuccess });
  return onDeleteSuccess;
}

function buttons() {
  return [...host.querySelectorAll<HTMLButtonElement>('.btn-delete-weight')];
}

beforeEach(() => {
  document.body.innerHTML = '<main><section id="history"></section><aside id="unrelated"></aside></main>';
  host = document.getElementById('history')!;
  vi.spyOn(weight, 'delete').mockResolvedValue({ success: true });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  dispose();
  vi.restoreAllMocks();
});

it('presents the first 14 readings in incoming order with the existing labels and CSS hooks', () => {
  const logs = Array.from({ length: 16 }, (_, index) => ({
    ...reading(180 - index, index + 1), time: index ? '' : '07:30', waist_inches: index ? null : 30.8,
  }));
  open(logs);
  expect(host.querySelector('h3')!.textContent).toBe('Recent Entries');
  const rows = [...host.querySelectorAll('.weight-entry')];
  expect(rows).toHaveLength(14);
  expect(rows.map(row => row.querySelector('.weight-value')!.textContent)).toEqual([
    '180 lbs Waist 30.8"', '179 lbs', '178 lbs', '177 lbs', '176 lbs', '175 lbs', '174 lbs',
    '173 lbs', '172 lbs', '171 lbs', '170 lbs', '169 lbs', '168 lbs', '167 lbs',
  ]);
  expect(rows[0].querySelector('.weight-date')!.textContent).toBe('Wed, Nov 4 at 07:30');
  expect(rows[1].querySelector('.weight-date')!.textContent).toBe('Wed, Nov 4');
  expect(rows[0].querySelector('.weight-waist')!.textContent).toBe('Waist 30.8"');
  expect(rows[1].querySelector('.weight-waist')).toBeNull();
  expect(buttons()[0].classList.contains('btn-icon')).toBe(true);
  expect(buttons()[0].textContent).toBe('×');
  expect(buttons().map(button => button.dataset.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14']);
});

it('captures numeric identities and presentation despite source and DOM changes', async () => {
  const logs = [reading(165, 7), reading(180, 9)];
  const onSuccess = open(logs);
  const before = host.innerHTML;
  logs.reverse();
  logs[1].id = 99;
  logs[1].weight_lbs = 200;
  logs[1].date = '2026-11-05';
  logs[1].time = '';
  logs[1].waist_inches = null;
  logs.push(reading());
  expect(host.innerHTML).toBe(before);
  const [first, second] = buttons();
  first.dataset.id = '99';
  second.removeAttribute('data-id');
  first.click();
  second.click();
  await Promise.resolve();
  expect(vi.mocked(weight.delete).mock.calls).toEqual([[7], [9]]);
  expect(onSuccess).toHaveBeenCalledTimes(2);
  expect(window.confirm).toHaveBeenCalledWith('Delete this entry?');
});

it('presents empty history and repeated disposal leaves retained DOM unchanged', () => {
  open([]);
  expect(host.querySelector('.text-muted')!.textContent).toBe('No weight entries yet. Log your first one above!');
  expect(host.querySelector('h3')).toBeNull();
  expect(buttons()).toHaveLength(0);
  const before = host.outerHTML;
  dispose();
  dispose();
  expect(host.outerHTML).toBe(before);
});

it.each(['disconnected', 'parent'])('initially %s mounting changes nothing and a fresh eligible mount works', eligibility => {
  host.innerHTML = '<button class="btn-delete-weight" data-id="7">Retained</button>';
  const retained = buttons()[0];
  if (eligibility === 'disconnected') host.remove();
  let eligible = eligibility !== 'parent';
  const before = host.outerHTML;
  const oldSuccess = open([reading()], () => eligible);
  document.querySelector('main')!.append(host);
  eligible = true;
  retained.click();
  expect(host.outerHTML).toBe(before);
  expect(weight.delete).not.toHaveBeenCalled();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(oldSuccess).not.toHaveBeenCalled();
  dispose();
  dispose();
  open();
  buttons()[0].click();
  expect(weight.delete).toHaveBeenCalledWith(7);
});

it.each(['dispose', 'parent', 'root', 'ancestor', 'h3', '.weight-entry', '.weight-date', '.weight-value', '.weight-waist', '.btn-delete-weight', 'fixed replacement'])(
  '%s permanently retires every row before and after observer delivery', async departure => {
    for (const delivered of [false, true]) {
      let eligible = true;
      open([reading(), reading(180, 9)], () => eligible);
      const retained = buttons();
      if (departure === 'dispose') { dispose(); dispose(); }
      else if (departure === 'parent') eligible = false;
      else departAndReconnect(host, departure, '.weight-entry');
      if (delivered) await Promise.resolve();
      const before = host.outerHTML;
      retained.forEach(button => button.click());
      eligible = true;
      await Promise.resolve();
      retained.forEach(button => button.click());
      expect(host.outerHTML).toBe(before);
      expect(window.confirm).not.toHaveBeenCalled();
      expect(weight.delete).not.toHaveBeenCalled();
    }
    open();
    buttons()[0].click();
    expect(weight.delete).toHaveBeenCalledWith(7);
  },
);

it.each(['root', 'ancestor', '.weight-entry', '.btn-delete-weight'])(
  '%s stays retired when reconnection follows observer delivery', async departure => {
    open();
    const retained = buttons()[0];
    const node = departure === 'root' ? host : departure === 'ancestor' ? host.parentElement!
      : host.querySelector(departure)!;
    const parent = node.parentNode!;
    node.remove();
    await Promise.resolve();
    parent.appendChild(node);
    retained.click();
    expect(weight.delete).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    open();
    buttons()[0].click();
    expect(weight.delete).toHaveBeenCalledWith(7);
  },
);

it('replaced and reconnected rows stay inert while a freshly mounted history works', () => {
  open();
  const retained = buttons()[0];
  const row = host.querySelector('.weight-entry')!;
  const onSuccess = open([reading(180, 9)]);
  host.append(row);
  const before = host.outerHTML;
  retained.click();
  expect(weight.delete).not.toHaveBeenCalled();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(host.outerHTML).toBe(before);
  expect(onSuccess).not.toHaveBeenCalled();
  buttons()[0].click();
  expect(weight.delete).toHaveBeenCalledWith(9);
});

it('style, visibility and unrelated DOM changes preserve live actions', async () => {
  open();
  host.querySelector<HTMLElement>('.weight-entry')!.style.opacity = '0.9';
  host.hidden = true;
  host.parentElement!.classList.add('hidden');
  document.querySelector('#unrelated')!.innerHTML = '<strong>Changed</strong>';
  const other = document.createElement('div');
  document.body.append(other);
  other.remove();
  await Promise.resolve();
  host.hidden = false;
  buttons()[0].click();
  expect(weight.delete).toHaveBeenCalledWith(7);
});

it('reserves a row before confirmation, releases cancellation and consumes successful deletion', async () => {
  const onSuccess = open();
  const [button] = buttons();
  vi.mocked(window.confirm).mockImplementationOnce(() => {
    button.click();
    return false;
  });
  button.click();
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(weight.delete).not.toHaveBeenCalled();
  button.click();
  await Promise.resolve();
  button.click();
  expect(weight.delete).toHaveBeenCalledExactlyOnceWith(7);
  expect(onSuccess).toHaveBeenCalledOnce();
  expect(window.confirm).toHaveBeenCalledTimes(2);
});

it('suppresses duplicate pending deletes while different rows remain independently actionable', async () => {
  const pending = deferred<{ success: boolean }>();
  vi.mocked(weight.delete).mockReturnValueOnce(pending.promise);
  const onSuccess = open([reading(), reading(180, 9)]);
  const [first, second] = buttons();
  first.click();
  first.click();
  second.click();
  await Promise.resolve();
  expect(vi.mocked(weight.delete).mock.calls).toEqual([[7], [9]]);
  expect(window.confirm).toHaveBeenCalledTimes(2);
  expect(onSuccess).toHaveBeenCalledOnce();
  pending.resolve({ success: true });
  await Promise.resolve();
  first.click();
  expect(weight.delete).toHaveBeenCalledTimes(2);
  expect(onSuccess).toHaveBeenCalledTimes(2);
});

it.each(['parent', 'row', 'dispose'])('rechecks %s eligibility after confirmation', retirement => {
  let eligible = true;
  const onSuccess = open([reading()], () => eligible);
  const [button] = buttons();
  vi.mocked(window.confirm).mockImplementationOnce(() => {
    if (retirement === 'parent') eligible = false;
    else if (retirement === 'row') departAndReconnect(host, '.weight-entry');
    else dispose();
    return true;
  });
  button.click();
  eligible = true;
  button.click();
  expect(window.confirm).toHaveBeenCalledOnce();
  expect(weight.delete).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
});

it('a live failure stays silent, does not refresh, and releases the row for retry', async () => {
  vi.mocked(weight.delete).mockRejectedValueOnce(new Error('Delete failed'));
  const onSuccess = open();
  const [button] = buttons();
  const before = host.outerHTML;
  button.click();
  await Promise.resolve();
  expect(host.outerHTML).toBe(before);
  expect(onSuccess).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
  button.click();
  await Promise.resolve();
  expect(weight.delete).toHaveBeenCalledTimes(2);
  expect(onSuccess).toHaveBeenCalledOnce();
});

it.each(['child', 'parent', 'replacement'])(
  'accepted deletion completes with its identity and notifies once after %s retirement', async retirement => {
    const pending = deferred<{ success: boolean }>();
    vi.mocked(weight.delete).mockReturnValueOnce(pending.promise);
    const logs = [reading()];
    let eligible = true;
    const onSuccess = open(logs, () => eligible);
    const [retained] = buttons();
    retained.click();
    logs[0].id = 99;
    retained.dataset.id = '99';
    if (retirement === 'child') departAndReconnect(host, '.weight-entry');
    else if (retirement === 'parent') eligible = false;
    else open([reading(180, 9)]);
    const before = host.outerHTML;
    pending.resolve({ success: true });
    await Promise.resolve();
    retained.click();
    expect(host.outerHTML).toBe(before);
    expect(weight.delete).toHaveBeenCalledExactlyOnceWith(7);
    expect(onSuccess).toHaveBeenCalledOnce();
  },
);

it('a late failure stays silent and cannot enable retry on a retired history', async () => {
  const pending = deferred<{ success: boolean }>();
  vi.mocked(weight.delete).mockReturnValueOnce(pending.promise);
  const onSuccess = open();
  const [retained] = buttons();
  retained.click();
  departAndReconnect(host, '.weight-entry');
  pending.reject(new Error('Late delete failure'));
  await Promise.resolve();
  retained.click();
  expect(weight.delete).toHaveBeenCalledTimes(1);
  expect(onSuccess).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
});

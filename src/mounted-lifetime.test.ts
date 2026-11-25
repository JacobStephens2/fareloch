import { afterEach, expect, it, vi } from 'vitest';
import { createMountedLifetime } from './mounted-lifetime';

afterEach(() => { document.body.replaceChildren(); });

function mount() {
  const ancestor = document.createElement('main');
  ancestor.innerHTML = '<section><div id="host"><div id="row"><button>Action</button></div><div id="preview">Preview</div></div></section>';
  document.body.append(ancestor);
  const host = ancestor.querySelector<HTMLElement>('#host')!;
  const row = host.querySelector<HTMLElement>('#row')!;
  const button = host.querySelector('button')!;
  const preview = host.querySelector<HTMLElement>('#preview')!;
  const cleanup = vi.fn();
  const accepted = vi.fn();
  const lifetime = createMountedLifetime(host, { ownedNodes: [button, preview], cleanup });
  button.addEventListener('click', () => { if (lifetime.isLive()) accepted(); }, { signal: lifetime.signal });
  return { ancestor, host, row, button, preview, cleanup, accepted, lifetime };
}

it('permanently retires an extracted host after its mounted ancestor departs', () => {
  const ancestor = document.createElement('section');
  const host = document.createElement('div');
  ancestor.append(host);
  document.body.append(ancestor);
  const cleanup = vi.fn();
  const lifetime = createMountedLifetime(host, { cleanup });
  ancestor.remove();
  document.body.append(host, ancestor);
  expect(lifetime.isLive()).toBe(false);
  expect(lifetime.signal.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
});

const departures = ['host', 'parent', 'ancestor', 'owned node', 'owned ancestor', 'extract host', 'extract owned node'] as const;
function depart(form: ReturnType<typeof mount>, departure: typeof departures[number]) {
  const node = departure === 'host' ? form.host
    : departure === 'parent' ? form.host.parentElement!
    : departure === 'owned node' ? form.button
    : departure === 'owned ancestor' || departure === 'extract owned node' ? form.row
    : form.ancestor;
  const parent = node.parentElement!;
  node.remove();
  if (departure === 'extract host') document.body.append(form.host);
  if (departure === 'extract owned node') form.host.append(form.button);
  return () => parent.append(node);
}

it.each(departures.flatMap(departure => (['action', 'completion', 'observer'] as const).map(first => ({ departure, first }))))(
  '$departure stays retired after synchronous reconnection with $first first', async ({ departure, first }) => {
    const form = mount();
    // Queue completion before removal to exercise guards before observer delivery.
    const completion = first === 'completion' ? Promise.resolve().then(() => {
      if (form.lifetime.isLive()) form.accepted();
    }) : undefined;
    depart(form, departure)();
    if (first === 'action') form.button.click();
    else if (first === 'completion') await completion;
    else await Promise.resolve();
    expect(form.lifetime.signal.aborted).toBe(true);
    expect(form.cleanup).toHaveBeenCalledOnce();
    expect(form.lifetime.isLive()).toBe(false);
    form.button.click();
    form.lifetime.dispose();
    await Promise.resolve();
    expect(form.accepted).not.toHaveBeenCalled();
    expect(form.cleanup).toHaveBeenCalledOnce();
  },
);

it.each(departures)('%s stays retired when reconnection follows observer delivery', async departure => {
  const form = mount();
  const reconnect = depart(form, departure);
  await Promise.resolve();
  expect(form.lifetime.signal.aborted).toBe(true);
  reconnect();
  form.button.click();
  expect(form.lifetime.isLive()).toBe(false);
  expect(form.accepted).not.toHaveBeenCalled();
  expect(form.cleanup).toHaveBeenCalledOnce();
});

it('finishes retirement before exactly-once, reentrant cleanup without rewriting DOM', () => {
  const host = document.createElement('div');
  host.innerHTML = '<button>Keep me</button>';
  document.body.append(host);
  const before = host.innerHTML;
  const action = vi.fn();
  const cleanup = vi.fn(() => {
    expect(lifetime.isLive()).toBe(false);
    expect(lifetime.signal.aborted).toBe(true);
    host.querySelector('button')!.click();
    lifetime.dispose();
  });
  const lifetime = createMountedLifetime(host, { cleanup });
  host.querySelector('button')!.addEventListener('click', action, { signal: lifetime.signal });
  lifetime.dispose();
  lifetime.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(action).not.toHaveBeenCalled();
  expect(host.innerHTML).toBe(before);
});

it.each(['detached host', 'outside owned node', 'detached owned node'] as const)('starts retired for %s and never revives', invalid => {
  const host = document.createElement('div');
  const owned = document.createElement('input');
  if (invalid === 'detached host') host.append(owned);
  else document.body.append(host);
  if (invalid === 'outside owned node') document.body.append(owned);
  const cleanup = vi.fn();
  const lifetime = createMountedLifetime(host, { ownedNodes: [owned], cleanup });
  expect(lifetime.signal.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
  document.body.append(host);
  host.append(owned);
  expect(lifetime.isLive()).toBe(false);
  lifetime.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});

it('keeps independent lifetimes and a fresh mount live after an old owner retires', () => {
  const first = mount();
  const second = mount();
  depart(first, 'ancestor')();
  expect(first.lifetime.isLive()).toBe(false);
  second.button.click();
  expect(second.accepted).toHaveBeenCalledOnce();
  expect(second.lifetime.isLive()).toBe(true);
  const fresh = createMountedLifetime(first.host);
  expect(fresh.isLive()).toBe(true);
  expect(first.lifetime.isLive()).toBe(false);
  fresh.dispose();
  second.lifetime.dispose();
});

it('allows descendant rendering, hint changes and unrelated mutations while ownership stays fixed', async () => {
  const form = mount();
  form.preview.replaceChildren(document.createTextNode('New preview'));
  const hint = document.createElement('span');
  form.row.append(hint);
  hint.textContent = 'New hint';
  hint.remove();
  const unrelated = document.createElement('aside');
  document.body.append(unrelated);
  unrelated.remove();
  expect(form.lifetime.isLive()).toBe(true);
  await Promise.resolve();
  form.button.click();
  expect(form.accepted).toHaveBeenCalledOnce();
  expect(form.cleanup).not.toHaveBeenCalled();
  form.lifetime.dispose();
});

it('captures the owned-node collection at construction', () => {
  const host = document.createElement('div');
  const owned = document.createElement('input');
  host.append(owned);
  document.body.append(host);
  const nodes: Node[] = [owned];
  const lifetime = createMountedLifetime(host, { ownedNodes: nodes });
  nodes.length = 0;
  owned.remove();
  host.append(owned);
  expect(lifetime.isLive()).toBe(false);
});

// Ownership is fixed at mount time; reconnecting retained DOM never revives it.
export function createMountedLifetime(host: HTMLElement, { ownedNodes = [], cleanup }: {
  ownedNodes?: readonly Node[];
  cleanup?: () => void;
} = {}) {
  const owned = [...ownedNodes];
  const watched = new Set<Node>();
  for (let node: Node | null = host; node; node = node.parentNode) watched.add(node);
  for (const control of owned) {
    for (let node: Node | null = control; node && node !== host; node = node.parentNode) watched.add(node);
  }
  let retired = false;
  const events = new AbortController();
  const departed = (records: MutationRecord[]) => records.some(record =>
    Array.from(record.removedNodes).some(node => watched.has(node)));
  const observer = new MutationObserver(records => {
    if (departed(records)) dispose();
  });
  observer.observe(host.ownerDocument, { childList: true, subtree: true });

  function dispose() {
    if (retired) return;
    retired = true;
    observer.disconnect();
    events.abort();
    cleanup?.();
  }

  function isLive() {
    if (retired) return false;
    // Actions and async completions can precede mutation-observer delivery.
    if (departed(observer.takeRecords()) || !host.isConnected || owned.some(node => !host.contains(node))) dispose();
    return !retired;
  }

  isLive();
  return { isLive, signal: events.signal, dispose };
}

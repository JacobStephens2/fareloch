// Stay synchronous so callers control whether actions or completions precede observer delivery.
export function departAndReconnect(root: Element, departure: string, fixedSelector = '#back-btn') {
  const node = departure === 'root' ? root : departure === 'ancestor' ? root.parentElement!
    : root.querySelector(departure === 'fixed replacement' ? fixedSelector : departure)!;
  const parent = node.parentNode!;
  node.remove();
  parent.appendChild(departure === 'fixed replacement' ? node.cloneNode(true) : node);
}

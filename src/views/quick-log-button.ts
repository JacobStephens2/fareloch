export function appendQuickLogButton(row: HTMLElement, name: string, log: () => Promise<void>, isLive: () => boolean, signal: AbortSignal) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-icon quick-log-button';
  button.textContent = '+';
  button.setAttribute('aria-label', `Quick-log one serving of ${name}`);
  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (!row.contains(button) || !isLive() || button.hasAttribute('aria-disabled')) return;
    button.setAttribute('aria-disabled', 'true');
    try {
      await log();
    } finally {
      if (row.contains(button) && isLive()) button.removeAttribute('aria-disabled');
    }
  }, { signal });
  row.append(button);
}

import { weight } from '../api';
import type { WeightLog } from '../types';
import { createMountedLifetime } from '../mounted-lifetime';

export function mountWeightHistorySession(container: HTMLElement, {
  logs, isParentLive, onDeleteSuccess,
}: {
  logs: readonly WeightLog[];
  isParentLive: () => boolean;
  onDeleteSuccess: () => void;
}): () => void {
  if (!container.isConnected || !isParentLive()) return () => {};
  const readings = logs.slice(0, 14).map(log => ({ ...log }));
  let html = logs.length ? '<h3>Recent Entries</h3>'
    : '<p class="text-muted">No weight entries yet. Log your first one above!</p>';
  for (const log of readings) {
    const date = new Date(log.date + 'T12:00:00');
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = log.time ? ` at ${log.time}` : '';
    html += `
        <div class="weight-entry">
          <span class="weight-date">${dateStr}${timeStr}</span>
          <span class="weight-value">${log.weight_lbs} lbs${log.waist_inches != null ? ` <span class="weight-waist">Waist ${log.waist_inches}&quot;</span>` : ''}</span>
          <button class="btn-icon btn-delete-weight" data-id="${log.id}">&times;</button>
        </div>
      `;
  }
  container.innerHTML = html;
  const lifetime = createMountedLifetime(container, { ownedNodes: [...container.querySelectorAll('*')] });
  const isLive = () => {
    if (!isParentLive()) lifetime.dispose();
    return lifetime.isLive();
  };
  container.querySelectorAll<HTMLElement>('.btn-delete-weight').forEach((button, index) => {
    const id = readings[index].id;
    let reserved = false;
    button.addEventListener('click', async () => {
      if (!isLive() || reserved) return;
      reserved = true;
      if (!confirm('Delete this entry?')) {
        reserved = false;
        return;
      }
      if (!isLive()) return;
      try {
        await weight.delete(id);
      } catch {
        if (isLive()) reserved = false;
        return;
      }
      // Accepted persistence and successful refresh belong to the original parent,
      // even when this rendered history has since retired or been replaced.
      onDeleteSuccess();
    }, { signal: lifetime.signal });
  });
  return lifetime.dispose;
}

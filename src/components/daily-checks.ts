import { dailyChecks } from '../api';
import { DAILY_CHECKS } from '../../server/src/daily-checks';

export function mountDailyChecks(container: HTMLElement) {
  container.innerHTML = `
    <div class="daily-check-pills" role="group" aria-label="Daily checks">
      ${DAILY_CHECKS.map(check => `
        <button type="button" class="daily-check-pill" data-check-key="${check.key}" aria-pressed="false" disabled>${check.label}</button>
      `).join('')}
    </div>
    <p class="text-muted" role="status"></p>
  `;
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-check-key]')];
  const status = container.querySelector<HTMLElement>('[role="status"]')!;
  const pendingDates = new Set<string>();
  let selectedDate = '';
  let loadVersion = 0;

  const disableButtons = (disabled: boolean) => {
    buttons.forEach(button => { button.disabled = disabled; });
  };

  const applyChecks = (checks: string[]) => {
    buttons.forEach(button => {
      button.setAttribute('aria-pressed', String(checks.includes(button.dataset.checkKey!)));
    });
  };

  const load = async (date: string) => {
    selectedDate = date;
    const version = ++loadVersion;
    disableButtons(true);
    applyChecks([]);
    status.textContent = '';
    try {
      const { checks } = await dailyChecks.get(date);
      if (version !== loadVersion || !container.isConnected) return;
      applyChecks(checks);
      disableButtons(pendingDates.has(date));
    } catch {
      if (version === loadVersion && container.isConnected) {
        status.textContent = 'Could not load daily checks. Reopen this date to retry.';
      }
    }
  };

  buttons.forEach((button, index) => {
    button.addEventListener('click', async () => {
      const date = selectedDate;
      if (pendingDates.has(date)) return;
      const checked = button.getAttribute('aria-pressed') !== 'true';
      pendingDates.add(date);
      disableButtons(true);
      status.textContent = '';
      let saved = false;
      try {
        await dailyChecks.set(date, DAILY_CHECKS[index].key, checked);
        saved = true;
      } catch { /* reload the saved state below */ }
      finally {
        pendingDates.delete(date);
      }
      if (selectedDate === date && container.isConnected) {
        await load(date);
        if (!saved && selectedDate === date && container.isConnected) {
          status.textContent = 'Could not save daily check. Please try again.';
        }
      }
    });
  });

  return load;
}

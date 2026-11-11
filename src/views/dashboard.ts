import { dailyChecks as dailyChecksApi, meals as mealsApi, workoutDays as workoutDaysApi } from '../api';
import { state, formatDate, todayStr, toLocalDateStr } from '../state';
import { navigate, setCleanup } from '../router';
import { isGuestMode, hasSampleData, dismissSampleData } from '../local-db';
import type { MealLog } from '../types';
import { DAILY_CHECKS } from '../../server/src/daily-checks';
import { createMountedLifetime } from '../mounted-lifetime';
import { mountMealEditSession } from './meal-edit-session';
import { mountMealListSession } from './meal-list-session';

function formatDateSub(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function getTargets(isWorkout: boolean) {
  const user = state.user;
  if (isWorkout && user) {
    return {
      cal: user.workoutTargetCalories || user.targetCalories || 2890,
      carbs: user.workoutTargetCarbsG || user.targetCarbsG || 380,
      protein: user.workoutTargetProteinG || user.targetProteinG || 170,
      fat: user.workoutTargetFatG || user.targetFatG || 80,
    };
  }
  return {
    cal: user?.targetCalories || 2590,
    carbs: user?.targetCarbsG || 340,
    protein: user?.targetProteinG || 150,
    fat: user?.targetFatG || 70,
  };
}

export function dashboardView() {
  const date = state.selectedDate;
  const t = getTargets(false);

  const showSampleBanner = isGuestMode() && hasSampleData();

  return {
    html: `
      <div class="page dashboard-page">
        <header class="page-header">
          <h1>Fareloch</h1>
        </header>

        ${showSampleBanner ? `
        <div class="sample-banner" id="sample-banner">
          <span>Showing sample data. <a href="#/register">Create an account</a> to start tracking your own.</span>
          <button type="button" id="sample-dismiss-btn" class="btn btn-sm btn-outline">Clear sample data</button>
        </div>
        ` : ''}

        <div class="date-nav">
          <button id="date-prev" class="btn-icon" aria-label="Previous day">&larr;</button>
          <div class="date-display">
            <button id="date-label" class="date-label">${formatDate(date)}</button>
            <span id="date-sub" class="date-sub">${formatDateSub(date)}</span>
          </div>
          <button id="date-next" class="btn-icon" aria-label="Next day">&rarr;</button>
        </div>

        <label class="workout-toggle" id="workout-toggle-wrap">
          <input type="checkbox" id="workout-toggle" />
          <span class="workout-toggle-label">Workout day</span>
        </label>

        <div class="daily-checks" id="daily-checks"></div>

        <div id="macro-summary" class="macro-summary">
          <div class="macro-ring" data-macro="calories">
            <div class="macro-ring-inner">
              <span class="macro-value" id="cal-value">0</span>
              <span class="macro-label">kcal</span>
            </div>
            <svg class="ring-svg" viewBox="0 0 100 100">
              <circle class="ring-bg" cx="50" cy="50" r="42" />
              <circle class="ring-fill ring-calories" id="cal-ring" cx="50" cy="50" r="42" />
            </svg>
          </div>
          <div class="macro-bars">
            <div class="macro-bar-row">
              <span class="macro-bar-label">Carbs</span>
              <div class="macro-bar-track">
                <div class="macro-bar-fill bar-carbs" id="carbs-bar"></div>
              </div>
              <span class="macro-bar-value" id="carbs-value">0 / ${t.carbs}g</span>
            </div>
            <div class="macro-bar-remaining" id="carbs-remaining"></div>
            <div class="macro-bar-row">
              <span class="macro-bar-label">Protein</span>
              <div class="macro-bar-track">
                <div class="macro-bar-fill bar-protein" id="protein-bar"></div>
              </div>
              <span class="macro-bar-value" id="protein-value">0 / ${t.protein}g</span>
            </div>
            <div class="macro-bar-remaining" id="protein-remaining"></div>
            <div class="macro-bar-row">
              <span class="macro-bar-label">Fat</span>
              <div class="macro-bar-track">
                <div class="macro-bar-fill bar-fat" id="fat-bar"></div>
              </div>
              <span class="macro-bar-value" id="fat-value">0 / ${t.fat}g</span>
            </div>
            <div class="macro-bar-remaining" id="fat-remaining"></div>
          </div>
        </div>

        <div class="macro-remaining-summary" id="cal-remaining"></div>

        <section id="sticky-day-summary" class="sticky-day-summary" aria-label="Day totals" hidden>
          <div class="sticky-day-heading">
            <span>Day totals</span>
            <span id="sticky-day-date">${formatDate(date)}</span>
          </div>
          <dl class="sticky-day-macros">
            ${([['cal', 'kcal'], ['carbs', 'Carbs (g)'], ['protein', 'Protein (g)'], ['fat', 'Fat (g)']] as const).map(([macro, label]) => `
              <div class="sticky-day-macro">
                <dt>${label}</dt>
                <dd id="day-${macro}-value">0 / ${t[macro]}</dd>
              </div>
            `).join('')}
          </dl>
        </section>

        <div class="dashboard-actions">
          <button id="copy-prev-btn" class="btn btn-outline btn-sm">Copy Previous Day</button>
        </div>

        <div id="meals-container" class="meals-container">
          <div class="loading-spinner">Loading...</div>
        </div>

        <div class="dashboard-legend">
          <p><span class="legend-swatch swatch-on-track"></span> On track - both calories and protein reach 85%+ of per-meal targets (daily / 4)</p>
          <p><span class="legend-swatch swatch-partial"></span> Partial - either calories or protein reaches 50%+, but not both reach 85%</p>
          <p><span class="legend-swatch swatch-low"></span> Low - both calories and protein are under 50% of per-meal targets</p>
          <p>Outlined protein chip - protein reaches 85%+ of its per-meal target</p>
        </div>

        <div id="edit-meal-modal" class="modal hidden">
          <div class="modal-content">
            <div class="modal-header">
              <h2 id="edit-meal-name"></h2>
              <button id="edit-modal-close" class="btn-icon">&times;</button>
            </div>
            <div id="edit-meal-body"></div>
          </div>
        </div>
      </div>
    `,
    init: () => mountDashboardDateSession(document.getElementById('app')!.querySelector<HTMLElement>('.dashboard-page')!, date),
  };
}

// Date, data and unfinished work belong to this mount. Event handlers capture
// a selection once; no asynchronous callback discovers its date from app state.
function mountDashboardDateSession(root: HTMLElement, initialDate: string) {
  const find = <T extends Element = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const workoutCache = new Map<string, boolean>();
  const pendingWorkouts = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pendingDailyChecks = new Set<string>();
  let selectedDate = initialDate;
  let generation = 0;
  let mealRevision = 0;
  let workoutRevision = 0;
  let dailyChecksRevision = 0;
  let currentMeals: MealLog[] = [];
  let mealStatus: 'loading' | 'ready' | 'error' = 'loading';
  let isWorkout = false;
  let copyPending = false;
  let picker: HTMLInputElement | undefined;
  let releaseMeals = () => {};
  let releaseEditor = () => {};

  function syncSummaryVisibility() {
    if (!isLive()) return;
    // Take over before the full summary's totals scroll under the page header.
    // Keep the compact bar out of the accessibility tree until needed.
    const header = root.querySelector<HTMLElement>('.page-header')!;
    find('sticky-day-summary').hidden = find('macro-summary').getBoundingClientRect().top > header.offsetHeight;
  }

  function captureSelection() {
    const current = generation;
    return () => isLive() && current === generation;
  }

  const dailyChecksContainer = find('daily-checks');
  dailyChecksContainer.innerHTML = `
    <div class="daily-check-pills" role="group" aria-label="Daily checks">
      ${DAILY_CHECKS.map(check => `
        <button type="button" class="daily-check-pill" data-check-key="${check.key}" aria-pressed="false" disabled>${check.label}</button>
      `).join('')}
    </div>
    <p class="text-muted" role="status"></p>
  `;
  const dailyCheckButtons = [...dailyChecksContainer.querySelectorAll<HTMLButtonElement>('[data-check-key]')];
  const dailyChecksStatus = dailyChecksContainer.querySelector<HTMLElement>('[role="status"]')!;
  const modal = find('edit-meal-modal');
  const modalBody = find('edit-meal-body');
  const lifetime = createMountedLifetime(root, {
    ownedNodes: [
      ...root.querySelectorAll(`
        .page-header, #date-prev, #date-next, #date-label, #date-sub,
        #workout-toggle-wrap, #workout-toggle, #daily-checks,
        #macro-summary, #macro-summary [id], #cal-remaining,
        #sticky-day-summary, #sticky-day-summary [id], #copy-prev-btn,
        #meals-container, #edit-meal-modal, #edit-meal-name, #edit-modal-close, #edit-meal-body
      `),
      ...dailyCheckButtons, dailyChecksStatus,
    ],
    cleanup: () => {
      generation++;
      releaseSelectionResources();
      workoutCache.clear();
    },
  });
  const { isLive } = lifetime;
  setCleanup(lifetime.dispose);
  if (!isLive()) return;
  const eventOptions = { signal: lifetime.signal };
  window.addEventListener('scroll', syncSummaryVisibility, { ...eventOptions, passive: true });
  window.addEventListener('resize', syncSummaryVisibility, eventOptions);

  function disableDailyChecks(disabled: boolean) {
    if (!isLive()) return;
    dailyCheckButtons.forEach(button => { button.disabled = disabled; });
  }

  function applyDailyChecks(checks: string[]) {
    if (!isLive()) return;
    dailyCheckButtons.forEach(button => {
      button.setAttribute('aria-pressed', String(checks.includes(button.dataset.checkKey!)));
    });
  }

  async function refreshDailyChecks(date: string = selectedDate) {
    if (!isLive() || date !== selectedDate) return;
    const selectionIsCurrent = captureSelection();
    const revision = ++dailyChecksRevision;
    const isCurrent = () => selectionIsCurrent() && revision === dailyChecksRevision;
    disableDailyChecks(true);
    applyDailyChecks([]);
    dailyChecksStatus.textContent = '';
    try {
      const { checks } = await dailyChecksApi.get(date);
      if (isCurrent()) {
        applyDailyChecks(checks);
        disableDailyChecks(pendingDailyChecks.has(date));
      }
    } catch {
      if (isCurrent()) {
        dailyChecksStatus.textContent = 'Could not load daily checks. Reopen this date to retry.';
      }
    }
    // Save feedback belongs to this read, including when its load failed.
    return isCurrent;
  }

  dailyCheckButtons.forEach((button, index) => {
    button.addEventListener('click', async () => {
      const date = selectedDate;
      if (!isLive() || !root.contains(dailyChecksContainer) || !dailyChecksContainer.contains(button)
        || button.disabled || pendingDailyChecks.has(date)) return;
      const key = DAILY_CHECKS[index].key;
      const checked = button.getAttribute('aria-pressed') !== 'true';
      pendingDailyChecks.add(date);
      disableDailyChecks(true);
      dailyChecksStatus.textContent = '';
      let saved = false;
      try {
        await dailyChecksApi.set(date, key, checked);
        saved = true;
      } catch { /* Reload persisted state after either outcome. */ }
      finally {
        pendingDailyChecks.delete(date);
      }
      // A returning selection of this date needs a fresh read too. Disposal
      // ends ownership permanently, but never cancels submitted persistence.
      if (!isLive() || selectedDate !== date) return;
      const refreshIsCurrent = await refreshDailyChecks(date);
      if (!saved && refreshIsCurrent?.()) {
        dailyChecksStatus.textContent = 'Could not save daily check. Please try again.';
      }
    }, eventOptions);
  });

  function later(callback: () => void, delay: number) {
    if (!isLive()) return;
    const isCurrent = captureSelection();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (isCurrent()) callback();
    }, delay);
    timers.add(timer);
  }

  function releaseSelectionResources() {
    releaseEditor();
    releaseMeals();
    timers.forEach(timer => clearTimeout(timer));
    timers.clear();
    picker?.remove();
    picker = undefined;
  }

  function render() {
    if (!isLive()) return;
    const toggle = find<HTMLInputElement>('workout-toggle');
    toggle.checked = isWorkout;
    find('workout-toggle-wrap').classList.toggle('active', isWorkout);
    updateMacroSummary(currentMeals);
    syncSummaryVisibility();
    releaseMeals();
    const container = find('meals-container');
    if (mealStatus === 'error') {
      container.innerHTML = '<p class="text-muted">Failed to load meals.</p>';
    } else {
      const date = selectedDate;
      const isCurrent = captureSelection();
      releaseMeals = mountMealListSession(container, {
        meals: currentMeals, date, targets: getTargets(isWorkout), parentIsCurrent: isCurrent,
        onAddFood: (type, mealDate) => navigate(`#/log?meal=${type}&date=${mealDate}`),
        onEdit: meal => showEditMealModal(meal, date),
        onDeleted: () => {
          if (isCurrent()) later(() => { void refreshMeals(date); }, 300);
        },
      });
    }
  }

  async function refreshMeals(date: string = selectedDate) {
    if (!isLive() || date !== selectedDate) return;
    const isCurrent = captureSelection();
    const revision = ++mealRevision;
    mealStatus = 'loading';
    try {
      const { meals } = await mealsApi.getByDate(date);
      if (!isCurrent() || revision !== mealRevision) return;
      currentMeals = meals;
      mealStatus = 'ready';
      render();
    } catch {
      if (!isCurrent() || revision !== mealRevision) return;
      mealStatus = 'error';
      render();
    }
  }

  async function readWorkout(date: string) {
    if (!isLive() || date !== selectedDate) return;
    const isCurrent = captureSelection();
    const revision = ++workoutRevision;
    // A read begun during a write must never replace that write's optimistic
    // flag, even if the write finishes before this read does.
    const hadPendingWrite = pendingWorkouts.has(date);
    try {
      const { isWorkoutDay } = await workoutDaysApi.get(date);
      if (!isCurrent() || revision !== workoutRevision || hadPendingWrite || pendingWorkouts.has(date)) return;
      workoutCache.set(date, isWorkoutDay);
      isWorkout = isWorkoutDay;
      render();
    } catch { /* Keep this date's cached flag or rest-day fallback. */ }
  }

  function resetCopyButton() {
    if (!isLive()) return;
    const button = find<HTMLButtonElement>('copy-prev-btn');
    button.disabled = copyPending;
    button.textContent = copyPending ? 'Copying...' : 'Copy Previous Day';
  }

  function selectDate(date: string) {
    if (!isLive()) return;
    generation++;
    releaseSelectionResources();
    modal.classList.add('hidden');
    // Date changes clear the live modal; retirement only releases resources.
    modalBody.replaceChildren();
    if (date !== selectedDate) currentMeals = [];
    selectedDate = date;
    state.selectedDate = date;
    mealStatus = 'loading';
    isWorkout = workoutCache.get(date) ?? false;
    find('date-label').textContent = formatDate(date);
    find('date-sub').textContent = formatDateSub(date);
    find('sticky-day-date').textContent = formatDate(date);
    find('date-next').classList.toggle('invisible', date >= todayStr());
    resetCopyButton();
    render();
    void refreshMeals(date);
    void readWorkout(date);
    void refreshDailyChecks(date);
  }

  find('sample-dismiss-btn')?.addEventListener('click', () => {
    if (!isLive()) return;
    dismissSampleData();
    find('sample-banner')?.remove();
    void refreshMeals();
  }, eventOptions);

  find<HTMLInputElement>('workout-toggle').addEventListener('change', async () => {
    if (!isLive()) return;
    const date = selectedDate;
    isWorkout = find<HTMLInputElement>('workout-toggle').checked;
    const checked = isWorkout;
    workoutRevision++;
    workoutCache.set(date, checked);
    pendingWorkouts.set(date, (pendingWorkouts.get(date) ?? 0) + 1);
    render();
    try {
      await workoutDaysApi.set(date, checked);
    } catch { /* Preserve the optimistic state on failure. */ }
    finally {
      const pending = (pendingWorkouts.get(date) ?? 1) - 1;
      if (pending) pendingWorkouts.set(date, pending);
      else pendingWorkouts.delete(date);
    }
  }, eventOptions);

  for (const [id, delta] of [['date-prev', -1], ['date-next', 1]] as const) {
    find(id).addEventListener('click', () => {
      const date = new Date(selectedDate + 'T12:00:00');
      date.setDate(date.getDate() + delta);
      selectDate(toLocalDateStr(date));
    }, eventOptions);
  }

  find('date-label').addEventListener('click', () => {
    if (!isLive()) return;
    picker?.remove();
    const input = document.createElement('input');
    picker = input;
    const isCurrent = captureSelection();
    input.type = 'date';
    input.value = selectedDate;
    input.style.position = 'absolute';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      if (!isCurrent() || picker !== input) return;
      if (input.value) selectDate(input.value);
      input.remove();
      if (picker === input) picker = undefined;
    }, eventOptions);
    input.showPicker?.();
    input.focus();
    input.click();
  }, eventOptions);

  find<HTMLButtonElement>('copy-prev-btn').addEventListener('click', async () => {
    if (!isLive() || copyPending) return;
    const date = selectedDate;
    const isCurrent = captureSelection();
    const prevDate = new Date(date + 'T12:00:00');
    prevDate.setDate(prevDate.getDate() - 1);
    const fromDate = toLocalDateStr(prevDate);
    if (!confirm(`Copy all meals from ${formatDate(fromDate)} to ${formatDate(date)}?`)) return;
    copyPending = true;
    resetCopyButton();
    let message: string;
    try {
      const { copied } = await mealsApi.copy(fromDate, date);
      message = `Copied ${copied} items!`;
      if (isCurrent()) void refreshMeals(date);
    } catch {
      message = 'No meals to copy';
    }
    copyPending = false;
    if (!isLive()) return;
    if (!isCurrent()) {
      resetCopyButton();
      return;
    }
    find('copy-prev-btn').textContent = message;
    later(resetCopyButton, 2000);
  }, eventOptions);

  selectDate(initialDate);

  function updateMacroSummary(mealList: MealLog[]) {
    const totals = mealList.reduce(
      (acc, m) => ({
        calories: acc.calories + m.calories,
        carbs: acc.carbs + m.carbs_g,
        protein: acc.protein + m.protein_g,
        fat: acc.fat + m.fat_g,
      }),
      { calories: 0, carbs: 0, protein: 0, fat: 0 }
    );

    const t = getTargets(isWorkout);
    const targetCal = t.cal;
    const targetCarbs = t.carbs;
    const targetProtein = t.protein;
    const targetFat = t.fat;

    for (const [macro, current, target] of [
      ['cal', totals.calories, targetCal],
      ['carbs', totals.carbs, targetCarbs],
      ['protein', totals.protein, targetProtein],
      ['fat', totals.fat, targetFat],
    ] as const) {
      const value = find(`day-${macro}-value`);
      value.textContent = `${Math.round(current)} / ${target}`;
      value.classList.toggle('over', current > target);
    }

    // Update calorie ring
    const calValue = find('cal-value');
    const calRing = find('cal-ring') as SVGCircleElement | null;
    if (calValue) calValue.textContent = Math.round(totals.calories).toString();
    if (calRing) {
      const pct = Math.min(totals.calories / targetCal, 1);
      const circumference = 2 * Math.PI * 42;
      calRing.style.strokeDasharray = `${circumference}`;
      calRing.style.strokeDashoffset = `${circumference * (1 - pct)}`;
    }

    // Update bars
    updateBar('carbs', totals.carbs, targetCarbs);
    updateBar('protein', totals.protein, targetProtein);
    updateBar('fat', totals.fat, targetFat);

    // Calorie remaining
    const calRemaining = find('cal-remaining');
    if (calRemaining) {
      const rem = Math.round(targetCal - totals.calories);
      calRemaining.textContent = rem > 0 ? `${rem} kcal remaining` : `${Math.abs(rem)} kcal over`;
      calRemaining.className = `macro-remaining-summary ${rem < 0 ? 'over' : ''}`;
    }
  }

  function updateBar(macro: string, current: number, target: number) {
    const bar = find(`${macro}-bar`) as HTMLElement | null;
    const value = find(`${macro}-value`) as HTMLElement | null;
    const remaining = find(`${macro}-remaining`) as HTMLElement | null;
    if (bar) {
      const pct = Math.min((current / target) * 100, 100);
      bar.style.width = `${pct}%`;
      if (current > target) bar.classList.add('over');
      else bar.classList.remove('over');
    }
    if (value) {
      value.textContent = `${Math.round(current)} / ${target}g`;
    }
    if (remaining) {
      const rem = Math.round(target - current);
      remaining.textContent = rem > 0 ? `${rem}g remaining` : `${Math.abs(rem)}g over`;
      remaining.className = `macro-bar-remaining ${rem < 0 ? 'over' : ''}`;
    }
  }


  function showEditMealModal(meal: MealLog, date: string) {
    if (!isLive()) return;
    releaseEditor();
    const isCurrent = captureSelection();
    releaseEditor = mountMealEditSession(modal, meal, isCurrent, () => {
      if (isCurrent()) void refreshMeals(date);
    });
  }
}

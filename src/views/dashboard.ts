import { dailyChecks as dailyChecksApi, meals as mealsApi, workoutDays as workoutDaysApi } from '../api';
import { state, formatDate, todayStr, toLocalDateStr } from '../state';
import { navigate, setCleanup } from '../router';
import { isGuestMode, hasSampleData, dismissSampleData } from '../local-db';
import type { MealLog, MealType } from '../types';
import { mealPulseStatus } from '../../server/src/nutrition';
import { DAILY_CHECKS } from '../../server/src/daily-checks';
import { createMountedLifetime } from '../mounted-lifetime';

function formatDateSub(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

const MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snacks',
};

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
  const frames = new Set<number>();
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

  function animate(callback: () => void) {
    if (!isLive()) return;
    const isCurrent = captureSelection();
    const frame = requestAnimationFrame(() => {
      frames.delete(frame);
      if (isCurrent()) callback();
    });
    frames.add(frame);
  }

  function releaseSelectionResources() {
    releaseMeals();
    timers.forEach(timer => clearTimeout(timer));
    timers.clear();
    frames.forEach(frame => cancelAnimationFrame(frame));
    frames.clear();
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
      releaseMeals = renderMeals(container, currentMeals, selectedDate);
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

  find('edit-modal-close').addEventListener('click', () => {
    if (!isLive()) return;
    modal.classList.add('hidden');
    modalBody.replaceChildren();
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

  function renderMeals(container: HTMLElement, mealList: MealLog[], date: string) {
    const events = new AbortController();
    const options = { signal: events.signal };
    const isCurrent = captureSelection();
    let active = true;
    const canAct = () => active && isCurrent();
    const grouped: Record<MealType, MealLog[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snack: [],
    };
    mealList.forEach((m) => grouped[m.meal_type]?.push(m));

    const mealItemText = new Map<number, { name: string; brand: string | null }>();
    let html = '';
    for (const type of MEAL_ORDER) {
      const items = grouped[type];
      const subtotals = items.reduce(
        (acc, m) => ({
          cal: acc.cal + m.calories,
          c: acc.c + m.carbs_g,
          p: acc.p + m.protein_g,
          f: acc.f + m.fat_g,
        }),
        { cal: 0, c: 0, p: 0, f: 0 }
      );

      // Per-meal target: daily / 4 (equal split)
      const tg = getTargets(isWorkout);
      const mealTargetCal = tg.cal / 4;
      const mealTargetC = Math.round(tg.carbs / 4);
      const mealTargetP = tg.protein / 4;
      const mealTargetF = Math.round(tg.fat / 4);
      const mealStatus = mealPulseStatus(
        { calories: subtotals.cal, carbsG: subtotals.c, proteinG: subtotals.p, fatG: subtotals.f },
        { calories: mealTargetCal, carbsG: mealTargetC, proteinG: mealTargetP, fatG: mealTargetF },
      );

      html += `
        <div class="meal-section ${mealStatus}">
          <div class="meal-header">
            <h3>${MEAL_LABELS[type]}</h3>
            <span class="meal-subtotal">${Math.round(subtotals.cal)} / ${Math.round(mealTargetCal)} kcal</span>
          </div>
          ${items.length > 0 ? `<div class="meal-macro-chips">
            <span class="macro-chip chip-carbs">${Math.round(subtotals.c)}/${mealTargetC}c</span>
            <span class="macro-chip chip-protein${subtotals.p >= 0.85 * mealTargetP ? ' chip-protein-hit' : ''}">${Math.round(subtotals.p)}/${Math.round(mealTargetP)}p</span>
            <span class="macro-chip chip-fat">${Math.round(subtotals.f)}/${mealTargetF}f</span>
          </div>` : ''}
          <div class="meal-items">
      `;

      if (items.length === 0) {
        html += `<p class="text-muted meal-empty">No items logged</p>`;
      } else {
        for (const item of items) {
          const name = item.food_name || item.recipe_name || item.note || 'Quick entry';
          const displayServings = item.unit_scale ? item.servings / item.unit_scale : item.servings;
          const servingsLabel = displayServings !== 1 ? `${parseFloat(displayServings.toFixed(2))}x ` : '';
          const timeStr = item.created_at ? new Date(item.created_at + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
          mealItemText.set(item.id, { name: `${servingsLabel}${name}`, brand: item.food_brand });
          html += `
            <div class="meal-item-wrapper" data-id="${item.id}">
              <div class="meal-item-swipe-bg">Delete</div>
              <div class="meal-item" data-id="${item.id}">
                <div class="meal-item-info">
                  <span class="meal-item-name"></span>
                  ${item.food_brand ? '<span class="food-brand"></span>' : ''}
                  ${timeStr ? `<span class="food-serving">${timeStr}</span>` : ''}
                </div>
                <div class="meal-item-macros">
                  <span class="macro-chip chip-calories">${Math.round(item.calories)}</span>
                  <span class="macro-chip chip-carbs">${Math.round(item.carbs_g)}c</span>
                  <span class="macro-chip chip-protein">${Math.round(item.protein_g)}p</span>
                  <span class="macro-chip chip-fat">${Math.round(item.fat_g)}f</span>
                </div>
              </div>
            </div>
          `;
        }
      }

      html += `
          </div>
          <button class="btn btn-add-meal" data-meal-type="${type}" data-date="${date}">+ Add Food</button>
        </div>
      `;
    }

    container.innerHTML = html;

    container.querySelectorAll<HTMLElement>('.meal-item').forEach((el) => {
      const text = mealItemText.get(Number(el.dataset.id));
      if (!text) return;
      el.querySelector('.meal-item-name')!.textContent = text.name;
      if (text.brand) el.querySelector('.food-brand')!.textContent = text.brand;
    });

    // Add food buttons
    container.querySelectorAll('.btn-add-meal').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!canAct()) return;
        const mealType = (btn as HTMLElement).dataset.mealType;
        const mealDate = (btn as HTMLElement).dataset.date;
        navigate(`#/log?meal=${mealType}&date=${mealDate}`);
      }, options);
    });

    // Swipe-to-delete and tap-to-edit
    container.querySelectorAll('.meal-item-wrapper').forEach((wrapper) => {
      const el = wrapper as HTMLElement;
      const inner = el.querySelector('.meal-item') as HTMLElement;
      let startX = 0, startY = 0, currentX = 0, swiping = false, didMove = false;

      const onStart = (clientX: number, clientY: number) => {
        if (!canAct()) return;
        startX = clientX;
        startY = clientY;
        currentX = 0;
        swiping = true;
        didMove = false;
        inner.style.transition = 'none';
      };

      const onMove = (clientX: number, clientY: number) => {
        if (!canAct() || !swiping) return;
        currentX = clientX - startX;
        if (Math.abs(currentX) > 5 || Math.abs(clientY - startY) > 5) didMove = true;
        if (currentX > 0) currentX = 0; // Only swipe left
        inner.style.transform = `translateX(${currentX}px)`;
      };

      const onEnd = async () => {
        if (!swiping || !canAct()) return;
        swiping = false;
        inner.style.transition = 'transform 0.2s ease';

        if (currentX < -80) {
          // Delete
          inner.style.transform = 'translateX(-100%)';
          const mealId = parseInt(el.dataset.id || '0');
          if (mealId) {
            try {
              await mealsApi.delete(mealId);
              if (!isCurrent()) return;
              if (el.isConnected) el.style.height = el.offsetHeight + 'px';
              animate(() => {
                if (!el.isConnected) return;
                el.style.transition = 'height 0.2s, opacity 0.2s';
                el.style.height = '0';
                el.style.opacity = '0';
                el.style.overflow = 'hidden';
              });
              later(() => { void refreshMeals(date); }, 300);
            } catch { /* ignore */ }
          }
        } else {
          inner.style.transform = 'translateX(0)';
          // Tap (no significant movement) = edit
          if (!didMove) {
            const mealId = parseInt(el.dataset.id || '0');
            const meal = mealList.find((m) => m.id === mealId);
            if (meal) showEditMealModal(meal, date);
          }
        }
      };

      inner.addEventListener('touchstart', (e) => onStart(e.touches[0].clientX, e.touches[0].clientY), { ...options, passive: true });
      inner.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX, e.touches[0].clientY), { ...options, passive: true });
      inner.addEventListener('touchend', onEnd, options);
      inner.addEventListener('touchcancel', () => {
        if (!canAct()) return;
        swiping = false;
        inner.style.transform = 'translateX(0)';
      }, options);

      // Mouse fallback for desktop
      inner.addEventListener('mousedown', (e) => {
        if (!canAct()) return;
        onStart(e.clientX, e.clientY);
        e.preventDefault();
      }, options);
      document.addEventListener('mousemove', (e) => { if (swiping) onMove(e.clientX, e.clientY); }, options);
      document.addEventListener('mouseup', () => { if (swiping) void onEnd(); }, options);
      events.signal.addEventListener('abort', () => { swiping = false; }, { once: true });
    });
    return () => {
      active = false;
      events.abort();
    };
  }

  function showEditMealModal(meal: MealLog, date: string) {
    if (!isLive()) return;
    const isCurrent = captureSelection();
    const modal = find('edit-meal-modal')!;
    const name = meal.food_name || meal.recipe_name || meal.note || 'Quick entry';
    find('edit-meal-name')!.textContent = name;

    const body = find('edit-meal-body')!;
    const hasFoodRef = meal.food_id || meal.recipe_id;
    let readEdit: () => Parameters<typeof mealsApi.update>[1];

    // For food/recipe-based entries, show per-unit macros and servings control
    // For quick entries, show editable macro fields
    // If unit_scale is set, show macros per that unit and display the user's original quantity
    const scale = meal.unit_scale || 1;
    const perUnitCal = meal.servings ? (meal.calories / meal.servings) * scale : meal.calories;
    const perUnitC = meal.servings ? (meal.carbs_g / meal.servings) * scale : meal.carbs_g;
    const perUnitP = meal.servings ? (meal.protein_g / meal.servings) * scale : meal.protein_g;
    const perUnitF = meal.servings ? (meal.fat_g / meal.servings) * scale : meal.fat_g;
    const displayQty = meal.servings / scale;

    if (hasFoodRef) {
      body.innerHTML = `
        ${meal.food_brand ? '<p class="food-brand"></p>' : ''}
        <div class="modal-macros">
          <div class="modal-macro"><strong>${Math.round(perUnitCal)}</strong> kcal</div>
          <div class="modal-macro"><strong>${Math.round(perUnitC * 10) / 10}g</strong> carbs</div>
          <div class="modal-macro"><strong>${Math.round(perUnitP * 10) / 10}g</strong> protein</div>
          <div class="modal-macro"><strong>${Math.round(perUnitF * 10) / 10}g</strong> fat</div>
        </div>
        <p class="text-muted" id="edit-per-label"></p>
        <div class="form-group">
          <label for="edit-servings" id="edit-qty-label"></label>
          <div class="servings-control">
            <button type="button" id="edit-serv-minus" class="btn-icon">-</button>
            <input type="number" id="edit-servings" value="${parseFloat(displayQty.toFixed(2))}" min="1" step="1" />
            <button type="button" id="edit-serv-plus" class="btn-icon">+</button>
          </div>
        </div>
        <div class="form-group">
          <label for="edit-meal-type">Meal</label>
          <select id="edit-meal-type">
            <option value="breakfast" ${meal.meal_type === 'breakfast' ? 'selected' : ''}>Breakfast</option>
            <option value="lunch" ${meal.meal_type === 'lunch' ? 'selected' : ''}>Lunch</option>
            <option value="dinner" ${meal.meal_type === 'dinner' ? 'selected' : ''}>Dinner</option>
            <option value="snack" ${meal.meal_type === 'snack' ? 'selected' : ''}>Snack</option>
          </select>
        </div>
        <div class="modal-total" id="edit-total">
          <span>${Math.round(meal.calories)} kcal</span>
          <span>${Math.round(meal.carbs_g * 10) / 10}g C</span>
          <span>${Math.round(meal.protein_g * 10) / 10}g P</span>
          <span>${Math.round(meal.fat_g * 10) / 10}g F</span>
        </div>
        <div class="form-row">
          <button type="button" id="edit-save-btn" class="btn btn-primary" style="flex:1">Save</button>
          <button type="button" id="edit-delete-btn" class="btn btn-danger" style="flex:0 0 auto">Delete</button>
        </div>
      `;

      if (meal.food_brand) body.querySelector('.food-brand')!.textContent = meal.food_brand;
      const perUnitLabel = meal.unit_label
        || (meal.serving_size && meal.serving_unit ? `${meal.serving_size}${meal.serving_unit}` : 'serving');
      find('edit-per-label')!.textContent = `Per ${perUnitLabel}`;
      find('edit-qty-label')!.textContent = meal.unit_label ? meal.unit_label : 'Servings';

      const servingsInput = find('edit-servings') as HTMLInputElement;
      const updateTotal = () => {
        if (!isCurrent() || !servingsInput.isConnected) return;
        const qty = parseFloat(servingsInput.value) || 1;
        find('edit-total')!.innerHTML = `
          <span>${Math.round(perUnitCal * qty)} kcal</span>
          <span>${Math.round(perUnitC * qty * 10) / 10}g C</span>
          <span>${Math.round(perUnitP * qty * 10) / 10}g P</span>
          <span>${Math.round(perUnitF * qty * 10) / 10}g F</span>
        `;
      };
      servingsInput.addEventListener('input', updateTotal, eventOptions);
      find('edit-serv-minus')!.addEventListener('click', () => {
        if (!isCurrent() || !servingsInput.isConnected) return;
        servingsInput.value = String(Math.max(1, (parseFloat(servingsInput.value) || 1) - 1));
        updateTotal();
      }, eventOptions);
      find('edit-serv-plus')!.addEventListener('click', () => {
        if (!isCurrent() || !servingsInput.isConnected) return;
        servingsInput.value = String((parseFloat(servingsInput.value) || 1) + 1);
        updateTotal();
      }, eventOptions);

      readEdit = () => {
        const qty = parseFloat(servingsInput.value) || 1;
        const effectiveServings = qty * scale;
        const mealType = (find('edit-meal-type') as HTMLSelectElement).value;
        return {
          servings: effectiveServings,
          mealType,
          calories: Math.round(perUnitCal * qty * 10) / 10,
          carbsG: Math.round(perUnitC * qty * 10) / 10,
          proteinG: Math.round(perUnitP * qty * 10) / 10,
          fatG: Math.round(perUnitF * qty * 10) / 10,
        };
      };
    } else {
      // Quick entry — editable macros
      body.innerHTML = `
        <div class="form-group">
          <label for="edit-meal-type">Meal</label>
          <select id="edit-meal-type">
            <option value="breakfast" ${meal.meal_type === 'breakfast' ? 'selected' : ''}>Breakfast</option>
            <option value="lunch" ${meal.meal_type === 'lunch' ? 'selected' : ''}>Lunch</option>
            <option value="dinner" ${meal.meal_type === 'dinner' ? 'selected' : ''}>Dinner</option>
            <option value="snack" ${meal.meal_type === 'snack' ? 'selected' : ''}>Snack</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="edit-carbs">Carbs (g)</label>
            <input type="number" id="edit-carbs" value="${meal.carbs_g}" min="0" step="0.1" />
          </div>
          <div class="form-group">
            <label for="edit-protein">Protein (g)</label>
            <input type="number" id="edit-protein" value="${meal.protein_g}" min="0" step="0.1" />
          </div>
          <div class="form-group">
            <label for="edit-fat">Fat (g)</label>
            <input type="number" id="edit-fat" value="${meal.fat_g}" min="0" step="0.1" />
          </div>
        </div>
        <div class="form-group">
          <label for="edit-cal">Calories</label>
          <input type="number" id="edit-cal" value="${meal.calories}" min="0" step="1" />
        </div>
        <div class="form-row">
          <button type="button" id="edit-save-btn" class="btn btn-primary" style="flex:1">Save</button>
          <button type="button" id="edit-delete-btn" class="btn btn-danger" style="flex:0 0 auto">Delete</button>
        </div>
      `;

      readEdit = () => ({
        mealType: (find('edit-meal-type') as HTMLSelectElement).value,
        calories: parseFloat((find('edit-cal') as HTMLInputElement).value) || 0,
        carbsG: parseFloat((find('edit-carbs') as HTMLInputElement).value) || 0,
        proteinG: parseFloat((find('edit-protein') as HTMLInputElement).value) || 0,
        fatG: parseFloat((find('edit-fat') as HTMLInputElement).value) || 0,
      });
    }

    const saveButton = find<HTMLButtonElement>('edit-save-btn');
    saveButton.addEventListener('click', async () => {
      if (!isCurrent() || !saveButton.isConnected || saveButton.disabled) return;
      const payload = readEdit();
      saveButton.disabled = true;
      try {
        await mealsApi.update(meal.id, payload);
        if (!isCurrent()) return;
        if (saveButton.isConnected) modal.classList.add('hidden');
        void refreshMeals(date);
      } catch {
        if (!isCurrent() || !saveButton.isConnected) return;
        saveButton.disabled = false;
        saveButton.textContent = 'Failed - Retry';
      }
    }, eventOptions);

    // Delete button (shared)
    const deleteButton = find('edit-delete-btn')!;
    deleteButton.addEventListener('click', async () => {
      if (!isCurrent() || !deleteButton.isConnected) return;
      if (confirm('Remove this entry?')) {
        try {
          await mealsApi.delete(meal.id);
          if (!isCurrent()) return;
          if (deleteButton.isConnected) modal.classList.add('hidden');
          void refreshMeals(date);
        } catch { /* ignore */ }
      }
    }, eventOptions);

    modal.classList.remove('hidden');
  }
}

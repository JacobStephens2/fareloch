import { meals as mealsApi, workoutDays as workoutDaysApi } from '../api';
import { state, formatDate, todayStr, toLocalDateStr } from '../state';
import { navigate } from '../router';
import { isGuestMode, hasSampleData, dismissSampleData } from '../local-db';
import type { MealLog, MealType } from '../types';

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

// Local cache of which dates are workout days, so the dashboard can render
// targets immediately on date change without flashing rest-day numbers first.
const workoutDayCache: Record<string, boolean> = {};
let currentIsWorkout = false;

function getTargets() {
  const user = state.user;
  if (currentIsWorkout && user) {
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
  currentIsWorkout = workoutDayCache[date] || false;
  const t = getTargets();

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

        <div class="dashboard-actions">
          <button id="copy-prev-btn" class="btn btn-outline btn-sm">Copy Previous Day</button>
        </div>

        <div id="meals-container" class="meals-container">
          <div class="loading-spinner">Loading...</div>
        </div>

        <div class="dashboard-legend">
          <p><span class="legend-swatch swatch-on-track"></span> On track — meal is 90%+ of per-meal target (daily / 4)</p>
          <p><span class="legend-swatch swatch-partial"></span> Partial — meal is 50-90% of per-meal target</p>
          <p><span class="legend-swatch swatch-low"></span> Low — meal is under 50% of per-meal target</p>
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
    init: () => {
      // Sample-data dismiss
      const dismissBtn = document.getElementById('sample-dismiss-btn');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          dismissSampleData();
          document.getElementById('sample-banner')?.remove();
          loadMeals(state.selectedDate);
        });
      }

      const toggle = document.getElementById('workout-toggle') as HTMLInputElement;
      const toggleWrap = document.getElementById('workout-toggle-wrap')!;

      const applyWorkoutState = (isWorkout: boolean) => {
        currentIsWorkout = isWorkout;
        workoutDayCache[state.selectedDate] = isWorkout;
        toggle.checked = isWorkout;
        toggleWrap.classList.toggle('active', isWorkout);
      };

      const loadWorkoutDay = async (date: string) => {
        // Use cached value immediately, then verify from server.
        applyWorkoutState(!!workoutDayCache[date]);
        try {
          const { isWorkoutDay } = await workoutDaysApi.get(date);
          if (workoutDayCache[date] !== isWorkoutDay) {
            applyWorkoutState(isWorkoutDay);
            updateMacroSummaryFromDom();
          }
        } catch { /* ignore */ }
      };

      // Date navigation
      const refreshDate = () => {
        document.getElementById('date-label')!.textContent = formatDate(state.selectedDate);
        document.getElementById('date-sub')!.textContent = formatDateSub(state.selectedDate);
        document.getElementById('date-next')!.classList.toggle('invisible', state.selectedDate >= todayStr());
        loadWorkoutDay(state.selectedDate);
        loadMeals(state.selectedDate);
      };

      toggle.addEventListener('change', async () => {
        const checked = toggle.checked;
        applyWorkoutState(checked);
        updateMacroSummaryFromDom();
        try {
          await workoutDaysApi.set(state.selectedDate, checked);
        } catch { /* ignore — local cache keeps UI consistent */ }
      });

      document.getElementById('date-prev')!.addEventListener('click', () => {
        const d = new Date(state.selectedDate + 'T12:00:00');
        d.setDate(d.getDate() - 1);
        state.selectedDate = toLocalDateStr(d);
        refreshDate();
      });

      document.getElementById('date-next')!.addEventListener('click', () => {
        const d = new Date(state.selectedDate + 'T12:00:00');
        d.setDate(d.getDate() + 1);
        state.selectedDate = toLocalDateStr(d);
        refreshDate();
      });

      document.getElementById('date-label')!.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'date';
        input.value = state.selectedDate;
        input.style.position = 'absolute';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', () => {
          if (input.value) {
            state.selectedDate = input.value;
            refreshDate();
          }
          input.remove();
        });
        input.showPicker?.();
        // Fallback if showPicker not supported
        input.focus();
        input.click();
      });

      // Edit modal close
      document.getElementById('edit-modal-close')!.addEventListener('click', () => {
        document.getElementById('edit-meal-modal')!.classList.add('hidden');
      });

      // Copy previous day
      document.getElementById('copy-prev-btn')!.addEventListener('click', async () => {
        const btn = document.getElementById('copy-prev-btn') as HTMLButtonElement;
        const prevDate = new Date(state.selectedDate + 'T12:00:00');
        prevDate.setDate(prevDate.getDate() - 1);
        const fromDate = prevDate.toISOString().slice(0, 10);

        if (!confirm(`Copy all meals from ${formatDate(fromDate)} to ${formatDate(state.selectedDate)}?`)) return;
        btn.disabled = true;
        btn.textContent = 'Copying...';
        try {
          const { copied } = await mealsApi.copy(fromDate, state.selectedDate);
          btn.textContent = `Copied ${copied} items!`;
          loadMeals(state.selectedDate);
        } catch {
          btn.textContent = 'No meals to copy';
        }
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = 'Copy Previous Day';
        }, 2000);
      });

      loadWorkoutDay(state.selectedDate);
      loadMeals(state.selectedDate);
    },
  };
}

// Cached meal list for the current date so we can re-render macro totals
// when the workout-day toggle flips without re-fetching.
let cachedMeals: MealLog[] = [];

function updateMacroSummaryFromDom() {
  updateMacroSummary(cachedMeals);
  const container = document.getElementById('meals-container');
  if (container) renderMeals(container, cachedMeals, state.selectedDate);
}

async function loadMeals(date: string) {
  const container = document.getElementById('meals-container');
  if (!container) return;

  try {
    const { meals: mealList } = await mealsApi.getByDate(date);
    cachedMeals = mealList;
    renderMeals(container, mealList, date);
    updateMacroSummary(mealList);
  } catch {
    container.innerHTML = '<p class="text-muted">Failed to load meals.</p>';
  }
}

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

  const t = getTargets();
  const targetCal = t.cal;
  const targetCarbs = t.carbs;
  const targetProtein = t.protein;
  const targetFat = t.fat;

  // Update calorie ring
  const calValue = document.getElementById('cal-value');
  const calRing = document.getElementById('cal-ring') as SVGCircleElement | null;
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
  const calRemaining = document.getElementById('cal-remaining');
  if (calRemaining) {
    const rem = Math.round(targetCal - totals.calories);
    calRemaining.textContent = rem > 0 ? `${rem} kcal remaining` : `${Math.abs(rem)} kcal over`;
    calRemaining.className = `macro-remaining-summary ${rem < 0 ? 'over' : ''}`;
  }
}

function updateBar(macro: string, current: number, target: number) {
  const bar = document.getElementById(`${macro}-bar`) as HTMLElement | null;
  const value = document.getElementById(`${macro}-value`) as HTMLElement | null;
  const remaining = document.getElementById(`${macro}-remaining`) as HTMLElement | null;
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
  const grouped: Record<MealType, MealLog[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snack: [],
  };
  mealList.forEach((m) => grouped[m.meal_type]?.push(m));

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
    const tg = getTargets();
    const mealTargetCal = Math.round(tg.cal / 4);
    const mealTargetC = Math.round(tg.carbs / 4);
    const mealTargetP = Math.round(tg.protein / 4);
    const mealTargetF = Math.round(tg.fat / 4);
    const mealPct = mealTargetCal > 0 ? subtotals.cal / mealTargetCal : 0;
    const mealStatus = mealPct >= 0.9 ? 'on-track' : mealPct >= 0.5 ? 'partial' : items.length > 0 ? 'low' : '';

    html += `
      <div class="meal-section ${mealStatus}">
        <div class="meal-header">
          <h3>${MEAL_LABELS[type]}</h3>
          <span class="meal-subtotal">${Math.round(subtotals.cal)} / ${mealTargetCal} kcal</span>
        </div>
        ${items.length > 0 ? `<div class="meal-macro-chips">
          <span class="macro-chip chip-carbs">${Math.round(subtotals.c)}/${mealTargetC}c</span>
          <span class="macro-chip chip-protein">${Math.round(subtotals.p)}/${mealTargetP}p</span>
          <span class="macro-chip chip-fat">${Math.round(subtotals.f)}/${mealTargetF}f</span>
        </div>` : ''}
        <div class="meal-items">
    `;

    if (items.length === 0) {
      html += `<p class="text-muted meal-empty">No items logged</p>`;
    } else {
      for (const item of items) {
        const name = item.food_name || item.recipe_name || item.note || 'Quick entry';
        const brand = item.food_brand ? `<span class="food-brand">${item.food_brand}</span>` : '';
        const displayServings = item.unit_scale ? item.servings / item.unit_scale : item.servings;
        const servingsLabel = displayServings !== 1 ? `${parseFloat(displayServings.toFixed(2))}x ` : '';
        const timeStr = item.created_at ? new Date(item.created_at + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        html += `
          <div class="meal-item-wrapper" data-id="${item.id}">
            <div class="meal-item-swipe-bg">Delete</div>
            <div class="meal-item" data-id="${item.id}">
              <div class="meal-item-info">
                <span class="meal-item-name">${servingsLabel}${name}</span>
                ${brand}
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

  // Add food buttons
  container.querySelectorAll('.btn-add-meal').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mealType = (btn as HTMLElement).dataset.mealType;
      const mealDate = (btn as HTMLElement).dataset.date;
      navigate(`#/log?meal=${mealType}&date=${mealDate}`);
    });
  });

  // Swipe-to-delete and tap-to-edit
  container.querySelectorAll('.meal-item-wrapper').forEach((wrapper) => {
    const el = wrapper as HTMLElement;
    const inner = el.querySelector('.meal-item') as HTMLElement;
    let startX = 0, startY = 0, currentX = 0, swiping = false, didMove = false;

    const onStart = (clientX: number, clientY: number) => {
      startX = clientX;
      startY = clientY;
      currentX = 0;
      swiping = true;
      didMove = false;
      inner.style.transition = 'none';
    };

    const onMove = (clientX: number, clientY: number) => {
      if (!swiping) return;
      currentX = clientX - startX;
      if (Math.abs(currentX) > 5 || Math.abs(clientY - startY) > 5) didMove = true;
      if (currentX > 0) currentX = 0; // Only swipe left
      inner.style.transform = `translateX(${currentX}px)`;
    };

    const onEnd = async () => {
      if (!swiping) return;
      swiping = false;
      inner.style.transition = 'transform 0.2s ease';

      if (currentX < -80) {
        // Delete
        inner.style.transform = 'translateX(-100%)';
        const mealId = parseInt(el.dataset.id || '0');
        if (mealId) {
          try {
            await mealsApi.delete(mealId);
            el.style.height = el.offsetHeight + 'px';
            requestAnimationFrame(() => {
              el.style.transition = 'height 0.2s, opacity 0.2s';
              el.style.height = '0';
              el.style.opacity = '0';
              el.style.overflow = 'hidden';
            });
            setTimeout(() => loadMeals(date), 300);
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

    inner.addEventListener('touchstart', (e) => onStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    inner.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    inner.addEventListener('touchend', onEnd);

    // Mouse fallback for desktop
    inner.addEventListener('mousedown', (e) => { onStart(e.clientX, e.clientY); e.preventDefault(); });
    document.addEventListener('mousemove', (e) => { if (swiping) onMove(e.clientX, e.clientY); });
    document.addEventListener('mouseup', () => { if (swiping) onEnd(); });
  });
}

function showEditMealModal(meal: MealLog, date: string) {
  const modal = document.getElementById('edit-meal-modal')!;
  const name = meal.food_name || meal.recipe_name || meal.note || 'Quick entry';
  document.getElementById('edit-meal-name')!.textContent = name;

  const body = document.getElementById('edit-meal-body')!;
  const hasFoodRef = meal.food_id || meal.recipe_id;

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
      ${meal.food_brand ? `<p class="food-brand">${meal.food_brand}</p>` : ''}
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

    const perUnitLabel = meal.unit_label
      || (meal.serving_size && meal.serving_unit ? `${meal.serving_size}${meal.serving_unit}` : 'serving');
    document.getElementById('edit-per-label')!.textContent = `Per ${perUnitLabel}`;
    document.getElementById('edit-qty-label')!.textContent = meal.unit_label ? meal.unit_label : 'Servings';

    const servingsInput = document.getElementById('edit-servings') as HTMLInputElement;
    const updateTotal = () => {
      const qty = parseFloat(servingsInput.value) || 1;
      document.getElementById('edit-total')!.innerHTML = `
        <span>${Math.round(perUnitCal * qty)} kcal</span>
        <span>${Math.round(perUnitC * qty * 10) / 10}g C</span>
        <span>${Math.round(perUnitP * qty * 10) / 10}g P</span>
        <span>${Math.round(perUnitF * qty * 10) / 10}g F</span>
      `;
    };
    servingsInput.addEventListener('input', updateTotal);
    document.getElementById('edit-serv-minus')!.addEventListener('click', () => {
      servingsInput.value = String(Math.max(1, (parseFloat(servingsInput.value) || 1) - 1));
      updateTotal();
    });
    document.getElementById('edit-serv-plus')!.addEventListener('click', () => {
      servingsInput.value = String((parseFloat(servingsInput.value) || 1) + 1);
      updateTotal();
    });

    document.getElementById('edit-save-btn')!.addEventListener('click', async () => {
      const qty = parseFloat(servingsInput.value) || 1;
      const effectiveServings = qty * scale;
      const mealType = (document.getElementById('edit-meal-type') as HTMLSelectElement).value;
      const btn = document.getElementById('edit-save-btn') as HTMLButtonElement;
      btn.disabled = true;
      try {
        await mealsApi.update(meal.id, {
          servings: effectiveServings,
          mealType,
          calories: Math.round(perUnitCal * qty * 10) / 10,
          carbsG: Math.round(perUnitC * qty * 10) / 10,
          proteinG: Math.round(perUnitP * qty * 10) / 10,
          fatG: Math.round(perUnitF * qty * 10) / 10,
        });
        modal.classList.add('hidden');
        loadMeals(date);
      } catch {
        btn.disabled = false;
        btn.textContent = 'Failed - Retry';
      }
    });
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

    document.getElementById('edit-save-btn')!.addEventListener('click', async () => {
      const btn = document.getElementById('edit-save-btn') as HTMLButtonElement;
      btn.disabled = true;
      try {
        await mealsApi.update(meal.id, {
          mealType: (document.getElementById('edit-meal-type') as HTMLSelectElement).value,
          calories: parseFloat((document.getElementById('edit-cal') as HTMLInputElement).value) || 0,
          carbsG: parseFloat((document.getElementById('edit-carbs') as HTMLInputElement).value) || 0,
          proteinG: parseFloat((document.getElementById('edit-protein') as HTMLInputElement).value) || 0,
          fatG: parseFloat((document.getElementById('edit-fat') as HTMLInputElement).value) || 0,
        });
        modal.classList.add('hidden');
        loadMeals(date);
      } catch {
        btn.disabled = false;
        btn.textContent = 'Failed - Retry';
      }
    });
  }

  // Delete button (shared)
  document.getElementById('edit-delete-btn')!.addEventListener('click', async () => {
    if (confirm('Remove this entry?')) {
      try {
        await mealsApi.delete(meal.id);
        modal.classList.add('hidden');
        loadMeals(date);
      } catch { /* ignore */ }
    }
  });

  modal.classList.remove('hidden');
}

import { meals } from '../api';
import { createMountedLifetime } from '../mounted-lifetime';
import type { MealLog, MealType } from '../types';
import { mealPulseStatus } from '../../server/src/nutrition';

const MEAL_ORDER: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks',
};

// Local effects end permanently with this list. Accepted deletes still notify
// the captured Dashboard date session, which owns refresh eligibility and timing.
export function mountMealListSession(container: HTMLElement, {
  meals: mealList, date, targets, parentIsCurrent, onAddFood, onEdit, onDeleted,
}: {
  meals: readonly MealLog[];
  date: string;
  targets: { cal: number; carbs: number; protein: number; fat: number };
  parentIsCurrent: () => boolean;
  onAddFood: (type: MealType, date: string) => void;
  onEdit: (meal: MealLog) => void;
  onDeleted: () => void;
}): () => void {
  if (!container.isConnected || !parentIsCurrent()) return () => {};
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
    const tg = targets;
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

  const frames = new Set<number>();
  const lifetime = createMountedLifetime(container, {
    ownedNodes: [...container.querySelectorAll('*')],
    cleanup: () => {
      frames.forEach(frame => cancelAnimationFrame(frame));
      frames.clear();
    },
  });
  const isLive = () => {
    if (!parentIsCurrent()) lifetime.dispose();
    return lifetime.isLive();
  };
  const options = { signal: lifetime.signal };

  container.querySelectorAll<HTMLButtonElement>('.btn-add-meal').forEach((button, index) => {
    const type = MEAL_ORDER[index];
    button.addEventListener('click', () => {
      if (isLive()) onAddFood(type, date);
    }, options);
  });

  const renderedMeals = MEAL_ORDER.flatMap(type => grouped[type]);
  container.querySelectorAll<HTMLElement>('.meal-item-wrapper').forEach((wrapper, index) => {
    const meal = renderedMeals[index];
    const mealId = meal.id;
    const inner = wrapper.querySelector<HTMLElement>('.meal-item')!;
    const text = mealItemText.get(mealId)!;
    inner.querySelector('.meal-item-name')!.textContent = text.name;
    if (text.brand) inner.querySelector('.food-brand')!.textContent = text.brand;
    let startX = 0, startY = 0, currentX = 0, swiping = false, didMove = false;
    let deleteAccepted = false;
    const canAct = () => isLive() && !deleteAccepted;

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
      if (currentX > 0) currentX = 0;
      inner.style.transform = `translateX(${currentX}px)`;
    };
    const onEnd = async () => {
      if (!swiping || !canAct()) return;
      swiping = false;
      inner.style.transition = 'transform 0.2s ease';
      if (currentX < -80) {
        deleteAccepted = true;
        inner.style.transform = 'translateX(-100%)';
        try {
          await meals.delete(mealId);
        } catch {
          if (isLive()) deleteAccepted = false;
          return;
        }
        onDeleted();
        if (!isLive()) return;
        wrapper.style.height = wrapper.offsetHeight + 'px';
        const frame = requestAnimationFrame(() => {
          frames.delete(frame);
          if (!isLive()) return;
          wrapper.style.transition = 'height 0.2s, opacity 0.2s';
          wrapper.style.height = '0';
          wrapper.style.opacity = '0';
          wrapper.style.overflow = 'hidden';
        });
        frames.add(frame);
      } else {
        inner.style.transform = 'translateX(0)';
        if (!didMove) onEdit(meal);
      }
    };
    inner.addEventListener('touchstart', event => onStart(event.touches[0].clientX, event.touches[0].clientY), { ...options, passive: true });
    inner.addEventListener('touchmove', event => onMove(event.touches[0].clientX, event.touches[0].clientY), { ...options, passive: true });
    inner.addEventListener('touchend', onEnd, options);
    inner.addEventListener('touchcancel', () => {
      if (!canAct()) return;
      swiping = false;
      inner.style.transform = 'translateX(0)';
    }, options);
    inner.addEventListener('mousedown', event => {
      if (!canAct()) return;
      onStart(event.clientX, event.clientY);
      event.preventDefault();
    }, options);
    document.addEventListener('mousemove', event => { if (swiping) onMove(event.clientX, event.clientY); }, options);
    document.addEventListener('mouseup', () => { if (swiping) void onEnd(); }, options);
  });
  return lifetime.dispose;
}

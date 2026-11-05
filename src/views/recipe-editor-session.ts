import { recipes as recipesApi, foods as foodsApi } from '../api';
import { navigate } from '../router';
import { createFoodSearchSession, type FoodSearchResult } from '../food-search-session';
import { assignFoodDetailText, assignPerUnitMacros, assignSavedMeasureOptions, assignTotalMacros, macroChips, measureCountSuffix, savedMeasureSuffix, sourceLabel, textSpan } from './food-search-text';
import type { Food, FoodMeasure, RecipeIngredient } from '../types';
import { macrosOf, scaleMacros, recipePerServing, roundMacros, unitScale, caloriesFromMacros } from '../../server/src/nutrition';


// A blank manual field is unset. Zero is a real Manual macros value, so it must not collapse to null.
function manualNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// One mount owns all editor effects, including work that outlives its DOM.
export function mountRecipeEditor(root: HTMLElement, recipeId: 'new' | number): () => void {
  const isNew = recipeId === 'new';
  let disposed = false;
  const events = new AbortController();
  const find = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const isLive = () => !disposed && root.isConnected;

  function on<K extends keyof HTMLElementEventMap>(element: Element | null, type: K, handler: (event: HTMLElementEventMap[K]) => void) {
    element?.addEventListener(type, event => {
      if (isLive()) handler(event as HTMLElementEventMap[K]);
    }, { signal: events.signal });
  }

  const ingredients: { foodId: number; servings: number; qty?: number; food: Food | RecipeIngredient; unitLabel?: string }[] = [];
  let mode: 'ingredients' | 'manual' = 'ingredients';
  const searchInput = find('ing-search') as HTMLInputElement;
  const results = find('ing-results')!;
  const session = createFoodSearchSession({
    search: query => foodsApi.search(query),
    onChange: snapshot => {
      if (!isLive()) return;
      searchInput.classList.toggle('searching', snapshot.status === 'debouncing' || snapshot.status === 'loading');
      results.innerHTML = '';
      results.classList.toggle('hidden', snapshot.status !== 'ready' && snapshot.status !== 'error');
      if (snapshot.status === 'ready') renderIngredientResults(snapshot.result);
      if (snapshot.status === 'error') results.innerHTML = '<p class="form-error" style="padding:8px">Search failed</p>';
    },
  });


  on(find('back-btn'), 'click', () => navigate('#/recipes'));

  // Ingredient modal close
  on(find('ing-modal-close'), 'click', () => {
    find('ing-modal')!.classList.add('hidden');
  });

  // Show ingredient add/edit modal with unit picker
  const showIngredientModal = (food: Food | RecipeIngredient, editIndex?: number) => {
    const isEdit = editIndex !== undefined;
    const modal = find('ing-modal')!;
    find('ing-modal-name')!.textContent = food.name;
    const body = find('ing-modal-body')!;

    let measures: FoodMeasure[] = [];
    try { measures = food.measures ? JSON.parse(food.measures) : []; } catch { /* */ }
    const hasMeasures = measures.length > 0;

    body.innerHTML = `
      ${food.brand ? '<p class="food-brand"></p>' : ''}
      <div class="modal-macros" id="ing-modal-per-unit"></div>
      <p class="text-muted" id="ing-modal-per-label"></p>
      ${hasMeasures ? `<div class="form-group">
        <label for="ing-unit-select">Unit</label>
        <select id="ing-unit-select">
          <option value="default"></option>
        </select>
      </div>` : ''}
      <div class="form-group">
        <label for="ing-qty">Quantity</label>
        <div class="servings-control">
          <button type="button" id="ing-qty-minus" class="btn-icon">-</button>
          <input type="number" id="ing-qty" value="${isEdit ? (ingredients[editIndex!].qty ?? Math.round(ingredients[editIndex!].servings * 100) / 100) : 1}" min="1" step="1" />
          <button type="button" id="ing-qty-plus" class="btn-icon">+</button>
        </div>
      </div>
      <div class="modal-total" id="ing-modal-total"></div>
      <div class="form-row">
        <button type="button" id="ing-add-btn" class="btn btn-primary" style="flex:1">${isEdit ? 'Update' : 'Add Ingredient'}</button>
        ${isEdit ? '<button type="button" id="ing-remove-btn" class="btn btn-danger" style="flex:0 0 auto">Remove</button>' : ''}
      </div>
    `;
    assignFoodDetailText(
      body,
      food,
      find('ing-modal-per-label')!,
      root.querySelector('#ing-unit-select option[value="default"]'),
    );
    const perUnit = find('ing-modal-per-unit')!;
    const total = find('ing-modal-total')!;
    assignPerUnitMacros(perUnit, food);

    let scale = 1;
    // When editing, recover the unit scale from stored servings and qty
    if (isEdit) {
      const editQty = ingredients[editIndex!].qty ?? ingredients[editIndex!].servings;
      scale = ingredients[editIndex!].servings / editQty;
    }
    const qtyInput = find('ing-qty') as HTMLInputElement;
    const unitSelect = find('ing-unit-select') as HTMLSelectElement | null;
    if (unitSelect) assignSavedMeasureOptions(unitSelect, measures);

    const updateTotal = () => {
      const qty = parseFloat(qtyInput.value) || 1;
      assignTotalMacros(total, food, scale * qty, 'rounded');
    };

    const updatePerUnit = () => {
      assignPerUnitMacros(perUnit, food, scale, 'rounded');
    };

    if (unitSelect) {
      on(unitSelect, 'change', () => {
        if (unitSelect.value === 'default') {
          scale = 1;
          find('ing-modal-per-label')!.textContent = `Per ${food.serving_size}${food.serving_unit}`;
        } else {
          const m = measures[parseInt(unitSelect.value)];
          scale = unitScale(m.gramWeight, food.serving_size);
          find('ing-modal-per-label')!.textContent = `Per ${m.label} (${m.gramWeight}g)`;
        }
        updatePerUnit();
        updateTotal();
      });
    }

    on(qtyInput, 'input', updateTotal);
    on(find('ing-qty-minus'), 'click', () => {
      qtyInput.value = String(Math.max(1, (parseFloat(qtyInput.value) || 1) - 1));
      updateTotal();
    });
    on(find('ing-qty-plus'), 'click', () => {
      qtyInput.value = String((parseFloat(qtyInput.value) || 1) + 1);
      updateTotal();
    });

    // Initial render
    updateTotal();

    on(find('ing-add-btn'), 'click', () => {
      const qty = parseFloat(qtyInput.value) || 1;
      const effectiveServings = qty * scale;
      const selectedUnit = unitSelect?.value;
      let unitLabel: string | undefined;
      if (selectedUnit && selectedUnit !== 'default') {
        const m = measures[parseInt(selectedUnit)];
        unitLabel = qty !== 1 ? `${qty}x ${m.label}` : m.label;
      } else {
        unitLabel = qty !== 1 ? `${qty}x ${food.serving_size}${food.serving_unit}` : `${food.serving_size}${food.serving_unit}`;
      }
      if (isEdit) {
        ingredients[editIndex!] = { foodId: food.id, servings: effectiveServings, qty, food, unitLabel };
      } else {
        ingredients.push({ foodId: food.id, servings: effectiveServings, qty, food, unitLabel });
      }
      renderIngredients();
      modal.classList.add('hidden');
      searchInput.value = '';
      session.setQuery('');
    });

    on(find('ing-remove-btn'), 'click', () => {
      ingredients.splice(editIndex!, 1);
      renderIngredients();
      modal.classList.add('hidden');
    });

    modal.classList.remove('hidden');
  };

  // Edit callback for ingredient rows
  const onEditIngredient = (idx: number) => {
    const ing = ingredients[idx];
    // A loaded ingredient's row identity is different from its Food identity.
    const food = { ...ing.food, id: ing.foodId };
    showIngredientModal(food, idx);
  };

  // Mode toggle
  root.querySelectorAll('[data-mode]').forEach((tab) => {
    on(tab, 'click', () => {
      root.querySelector('[data-mode].active')?.classList.remove('active');
      tab.classList.add('active');
      mode = (tab as HTMLElement).dataset.mode as 'ingredients' | 'manual';
      session.setActive(mode === 'ingredients');
      find('ingredients-section')!.classList.toggle('hidden', mode === 'manual');
      find('manual-section')!.classList.toggle('hidden', mode === 'ingredients');
      updateTotals();
    });
  });

  // Auto-calc calories for manual mode
  const manualCalInput = find('manual-cal') as HTMLInputElement;
  let manualCalManual = false;
  on(manualCalInput, 'input', () => { manualCalManual = true; });
  const autoCalcManual = () => {
    if (manualCalManual) return;
    const c = parseFloat((find('manual-carbs') as HTMLInputElement).value) || 0;
    const p = parseFloat((find('manual-protein') as HTMLInputElement).value) || 0;
    const f = parseFloat((find('manual-fat') as HTMLInputElement).value) || 0;
    manualCalInput.value = String(caloriesFromMacros(c, p, f));
    updateTotals();
  };
  ['manual-carbs', 'manual-protein', 'manual-fat'].forEach(id =>
    on(find(id), 'input', autoCalcManual)
  );
  on(manualCalInput, 'input', () => updateTotals());

  // Servings/unit changes update totals
  on(find('recipe-servings'), 'input', () => updateTotals());

  // Load existing recipe
  if (!isNew) {
    void loadExistingRecipe();
  }

  // Ingredient search
  on(searchInput, 'input', () => {
    session.setQuery(searchInput.value);
  });
  session.setActive(true);

  function renderIngredientResults({ foods, external }: FoodSearchResult) {
    for (const food of foods) {
      const item = document.createElement('div');
      item.className = 'food-item food-item-sm';
      const info = document.createElement('div');
      info.className = 'food-item-info';
      const serving = textSpan('food-serving', `${food.serving_size}${food.serving_unit}${savedMeasureSuffix(food.measures)} · `);
      serving.append(sourceLabel(food.source), document.createTextNode(` · ${Math.round(food.calories)} kcal`));
      info.append(
        textSpan('food-item-name', `${food.name}${food.brand ? ` (${food.brand})` : ''}`),
        serving,
      );
      item.append(info, macroChips({ carbs: food.carbs_g, protein: food.protein_g, fat: food.fat_g }));
      on(item, 'click', () => {
        showIngredientModal(food);
      });
      results.appendChild(item);
    }

    for (const ext of external) {
      const serving = textSpan('food-serving', `${ext.servingSize}${ext.servingUnit}${measureCountSuffix(ext.measures?.length ?? 0)} · `);
      serving.append(sourceLabel(ext.source), document.createTextNode(` · ${Math.round(ext.calories)} kcal`));
      const info = document.createElement('div');
      info.className = 'food-item-info';
      info.append(
        textSpan('food-item-name', `${ext.name}${ext.brand ? ` (${ext.brand})` : ''}`),
        serving,
      );
      const item = document.createElement('div');
      item.className = 'food-item food-item-sm';
      item.append(info, macroChips({ carbs: ext.carbsG, protein: ext.proteinG, fat: ext.fatG }));
      on(item, 'click', async () => {
        try {
          const { food } = await foodsApi.saveExternal(ext);
          if (!isLive()) return;
          showIngredientModal(food);
        } catch {
          if (isLive()) alert('Failed to save food');
        }
      });
      results.appendChild(item);
    }

    if (foods.length === 0 && external.length === 0) {
      results.innerHTML = '<p class="text-muted" style="padding:8px">No results</p>';
    }
  }

  // Form submit
  on(find('recipe-form'), 'submit', async (e) => {
    e.preventDefault();
    const name = (find('recipe-name') as HTMLInputElement).value;
    const totalServings = parseFloat((find('recipe-servings') as HTMLInputElement).value) || 1;
    const servingUnit = (find('recipe-unit') as HTMLInputElement).value.trim() || 'serving';
    const btn = (e.target as HTMLFormElement).querySelector('button[type=submit]') as HTMLButtonElement;
    btn.disabled = true;

    try {
      const ingData = ingredients.map((i) => ({ foodId: i.foodId, servings: i.servings, qty: i.qty, unitLabel: i.unitLabel }));
      const manualCalories = mode === 'manual' ? manualNumber(manualCalInput.value) : null;
      const manualCarbsG = mode === 'manual' ? manualNumber((find('manual-carbs') as HTMLInputElement).value) : null;
      const manualProteinG = mode === 'manual' ? manualNumber((find('manual-protein') as HTMLInputElement).value) : null;
      const manualFatG = mode === 'manual' ? manualNumber((find('manual-fat') as HTMLInputElement).value) : null;

      if (isNew) {
        await recipesApi.create({ name, totalServings, servingUnit, ingredients: ingData, manualCalories, manualCarbsG, manualProteinG, manualFatG });
      } else {
        await recipesApi.update(recipeId as number, { name, totalServings, servingUnit, ingredients: ingData, manualCalories, manualCarbsG, manualProteinG, manualFatG });
      }
      if (isLive()) navigate('#/recipes');
    } catch {
      if (!isLive()) return;
      btn.disabled = false;
      btn.textContent = 'Failed - Retry';
    }
  });

  // Duplicate
  on(find('copy-recipe'), 'click', async () => {
    const btn = find('copy-recipe') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Duplicating...';
    try {
      const { recipe } = await recipesApi.copy(recipeId as number);
      if (isLive()) navigate(`#/recipes/${recipe.id}`);
    } catch {
      if (!isLive()) return;
      btn.disabled = false;
      btn.textContent = 'Duplicate Recipe';
    }
  });

  // Delete
  on(find('delete-recipe'), 'click', async () => {
    if (confirm('Delete this recipe?')) {
      try {
        await recipesApi.delete(recipeId as number);
        if (isLive()) navigate('#/recipes');
      } catch {
        if (isLive()) alert('Failed to delete recipe');
      }
    }
  });


  async function loadExistingRecipe() {
    try {
      const { recipe, ingredients: ings } = await recipesApi.get(recipeId as number);
      if (!isLive()) return;
      (find('recipe-name') as HTMLInputElement).value = recipe.name;
      (find('recipe-servings') as HTMLInputElement).value = String(recipe.total_servings);
      (find('recipe-unit') as HTMLInputElement).value = recipe.serving_unit || 'serving';

      if (recipe.manual_calories != null) {
        // Manual mode
        (find('manual-cal') as HTMLInputElement).value = String(recipe.manual_calories);
        (find('manual-carbs') as HTMLInputElement).value = String(recipe.manual_carbs_g ?? '');
        (find('manual-protein') as HTMLInputElement).value = String(recipe.manual_protein_g ?? '');
        (find('manual-fat') as HTMLInputElement).value = String(recipe.manual_fat_g ?? '');
        mode = 'manual';
        session.setActive(false);
        root.querySelector('[data-mode="ingredients"]')?.classList.remove('active');
        root.querySelector('[data-mode="manual"]')?.classList.add('active');
        find('ingredients-section').classList.add('hidden');
        find('manual-section').classList.remove('hidden');
        updateTotals();
      } else {
        for (const ing of ings) {
          let unitLabel = ing.unit_label ?? undefined;
          let qty = ing.qty ?? undefined;

          // For old data without unit_label, try to match servings to a known measure
          if (!unitLabel && ing.measures) {
            try {
              const measures: { label: string; gramWeight: number }[] = JSON.parse(ing.measures);
              const effectiveGrams = ing.servings * (ing.serving_size || 100);
              for (const m of measures) {
                const ratio = effectiveGrams / m.gramWeight;
                if (Math.abs(ratio - Math.round(ratio)) < 0.01 && Math.round(ratio) > 0) {
                  qty = Math.round(ratio);
                  unitLabel = qty !== 1 ? `${qty}x ${m.label}` : m.label;
                  break;
                }
              }
            } catch { /* ignore */ }
          }

          ingredients.push({
            foodId: ing.food_id,
            servings: ing.servings,
            qty,
            food: ing,
            unitLabel,
          });
        }
        renderIngredients();
      }
    } catch {
      // Ignore
    }
  }

  function updateTotals() {
    const servings = parseFloat((find('recipe-servings') as HTMLInputElement)?.value) || 1;
    const unit = (find('recipe-unit') as HTMLInputElement)?.value.trim() || 'serving';
    const totalsEl = find('recipe-totals');
    if (!totalsEl) return;

    // Same parsing as the save handler: blank manual calories fall back to the ingredients, and 0 stays 0.
    const manualValue = (id: string) =>
      mode === 'manual' ? manualNumber((find(id) as HTMLInputElement)?.value) : null;
    const perServing = roundMacros(recipePerServing(
      {
        total_servings: servings,
        manual_calories: manualValue('manual-cal'),
        manual_carbs_g: manualValue('manual-carbs'),
        manual_protein_g: manualValue('manual-protein'),
        manual_fat_g: manualValue('manual-fat'),
      },
      ingredients.map((ing) => ({ food: ing.food, servings: ing.servings })),
    ), 'display');

    const unitLabel = unit + (servings !== 1 ? 's' : '');
    totalsEl.innerHTML = `
      <h4>Per ${unit} (of ${servings} ${unitLabel})</h4>
      <div class="modal-macros">
        <div class="modal-macro"><strong>${perServing.calories}</strong> kcal</div>
        <div class="modal-macro"><strong>${perServing.carbsG}g</strong> carbs</div>
        <div class="modal-macro"><strong>${perServing.proteinG}g</strong> protein</div>
        <div class="modal-macro"><strong>${perServing.fatG}g</strong> fat</div>
      </div>
    `;
  }

  function renderIngredients() {
    const container = find('ingredients-list')!;

    container.innerHTML = '';
    ingredients.forEach((ing, idx) => {
      const f = ing.food;
      const macros = scaleMacros(macrosOf(f), ing.servings);
      const servingSize = ('serving_size' in f ? f.serving_size : 0) || 0;
      const servingUnit = ('serving_unit' in f ? f.serving_unit : '') || '';
      let unit = ing.unitLabel;
      if (!unit) {
        if (servingSize && servingUnit) {
          const totalAmount = Math.round(ing.servings * servingSize * 10) / 10;
          unit = `${totalAmount}${servingUnit}`;
        } else {
          unit = `${Math.round(ing.servings * 100) / 100} serving${ing.servings !== 1 ? 's' : ''}`;
        }
      }

      const el = document.createElement('div');
      el.className = 'ingredient-row';
      const info = document.createElement('div');
      info.className = 'ingredient-info ingredient-clickable';
      info.dataset.idx = String(idx);
      info.append(textSpan('ingredient-name', f.name), textSpan('ingredient-unit', unit));
      el.appendChild(info);
      el.insertAdjacentHTML('beforeend', `
        <div class="ingredient-macros">
          <span class="macro-chip chip-calories">${Math.round(macros.calories)}</span>
          <span class="macro-chip chip-carbs">${Math.round(macros.carbsG)}c</span>
          <span class="macro-chip chip-protein">${Math.round(macros.proteinG)}p</span>
          <span class="macro-chip chip-fat">${Math.round(macros.fatG)}f</span>
        </div>
        <button type="button" class="btn-icon btn-remove-ing" data-idx="${idx}">&times;</button>
      `);
      container.appendChild(el);
    });

    updateTotals();

    // Edit handlers
    {
      container.querySelectorAll('.ingredient-clickable').forEach((el) => {
        on(el, 'click', () => {
          const idx = parseInt((el as HTMLElement).dataset.idx || '0');
          onEditIngredient(idx);
        });
      });
    }

    // Remove handlers
    container.querySelectorAll('.btn-remove-ing').forEach((btn) => {
      on(btn, 'click', (e) => {
        e.stopPropagation();
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
        ingredients.splice(idx, 1);
        renderIngredients();
      });
    });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    session.dispose();
    events.abort();
  };
}

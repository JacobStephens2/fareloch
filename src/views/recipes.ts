import { recipes as recipesApi, foods as foodsApi } from '../api';
import { navigate, setCleanup } from '../router';
import { createFoodSearchSession, type FoodSearchResult } from '../food-search-session';
import { assignFoodDetailText, assignPerUnitMacros, assignSavedMeasureOptions, assignTotalMacros, macroChips, measureCountSuffix, savedMeasureSuffix, sourceLabel, textSpan } from './food-search-text';
import type { Food, FoodMeasure, RecipeIngredient } from '../types';

export function recipesView() {
  return {
    html: `
      <div class="page">
        <header class="page-header">
          <h1>Recipes</h1>
        </header>
        <button id="new-recipe-btn" class="btn btn-primary btn-block" style="margin-bottom:16px">+ New Recipe</button>
        <div id="recipe-list" class="food-list">
          <div class="loading-spinner">Loading...</div>
        </div>
      </div>
    `,
    init: () => {
      document.getElementById('new-recipe-btn')!.addEventListener('click', () => navigate('#/recipes/new'));
      loadRecipes();
    },
  };
}

async function loadRecipes() {
  const container = document.getElementById('recipe-list')!;
  try {
    const { recipes } = await recipesApi.list();
    if (recipes.length === 0) {
      container.innerHTML = '<p class="text-muted">No recipes yet. Create one to save your favorite meals!</p>';
      return;
    }

    container.innerHTML = '';
    for (const recipe of recipes) {
      const el = document.createElement('div');
      el.className = 'food-item';
      const servLabel = recipe.serving_unit && recipe.serving_unit !== 'serving'
        ? `${recipe.total_servings} ${recipe.serving_unit}${recipe.total_servings !== 1 ? 's' : ''}`
        : `${recipe.total_servings} serving${recipe.total_servings !== 1 ? 's' : ''}`;
      const detail = recipe.manual_calories != null
        ? `Manual macros &middot; ${servLabel}`
        : `${recipe.ingredientCount} ingredient${recipe.ingredientCount !== 1 ? 's' : ''} &middot; ${servLabel}`;
      el.innerHTML = `
        <div class="food-item-info">
          <span class="food-item-name">${recipe.name}</span>
          <span class="food-serving">${detail}</span>
        </div>
        <div class="food-item-macros">
          <span class="macro-chip chip-calories">${recipe.perServing.calories}</span>
          <span class="macro-chip chip-carbs">${recipe.perServing.carbsG}c</span>
          <span class="macro-chip chip-protein">${recipe.perServing.proteinG}p</span>
          <span class="macro-chip chip-fat">${recipe.perServing.fatG}f</span>
        </div>
      `;
      el.addEventListener('click', () => navigate(`#/recipes/${recipe.id}`));
      container.appendChild(el);
    }
  } catch {
    container.innerHTML = '<p class="form-error">Failed to load recipes</p>';
  }
}

export function recipeEditView(params: Record<string, string>) {
  const isNew = params.id === 'new';

  return {
    html: `
      <div class="page">
        <header class="page-header">
          <button id="back-btn" class="btn-icon">&larr;</button>
          <h1>${isNew ? 'New Recipe' : 'Edit Recipe'}</h1>
        </header>
        <form id="recipe-form">
          <div class="form-group">
            <label for="recipe-name">Recipe Name *</label>
            <input type="text" id="recipe-name" required placeholder="e.g. Green Smoothie" />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="recipe-servings">Total Servings</label>
              <input type="number" id="recipe-servings" value="1" min="1" step="1" />
            </div>
            <div class="form-group">
              <label for="recipe-unit">Serving Unit</label>
              <input type="text" id="recipe-unit" value="serving" placeholder="e.g. cup, bowl, scoop" />
            </div>
          </div>

          <div class="tab-bar" style="margin-bottom:12px">
            <button type="button" class="tab active" data-mode="ingredients">From Ingredients</button>
            <button type="button" class="tab" data-mode="manual">Manual Macros</button>
          </div>

          <div id="ingredients-section">
            <div id="ingredients-list" class="ingredients-list"></div>
            <div class="ingredient-search">
              <input type="search" id="ing-search" placeholder="Search to add ingredient..." autocomplete="off" />
              <div id="ing-results" class="food-list hidden"></div>
            </div>
          </div>

          <div id="manual-section" class="hidden">
            <p class="text-muted" style="margin-bottom:12px">Enter the macros for the entire recipe (all servings combined).</p>
            <div class="form-row">
              <div class="form-group">
                <label for="manual-carbs">Carbs (g)</label>
                <input type="number" id="manual-carbs" min="0" step="0.1" />
              </div>
              <div class="form-group">
                <label for="manual-protein">Protein (g)</label>
                <input type="number" id="manual-protein" min="0" step="0.1" />
              </div>
              <div class="form-group">
                <label for="manual-fat">Fat (g)</label>
                <input type="number" id="manual-fat" min="0" step="0.1" />
              </div>
            </div>
            <div class="form-group">
              <label for="manual-cal">Calories <span class="form-hint" id="manual-cal-hint">(auto-calculated)</span></label>
              <input type="number" id="manual-cal" min="0" step="1" />
            </div>
          </div>

          <div id="recipe-totals" class="recipe-totals"></div>

          <button type="submit" class="btn btn-primary btn-block">${isNew ? 'Create Recipe' : 'Save Changes'}</button>
          ${!isNew ? '<button type="button" id="copy-recipe" class="btn btn-block" style="background:var(--border);color:var(--text)">Duplicate Recipe</button>' : ''}
          ${!isNew ? '<button type="button" id="delete-recipe" class="btn btn-danger btn-block">Delete Recipe</button>' : ''}
        </form>

        <div id="ing-modal" class="modal hidden">
          <div class="modal-content">
            <div class="modal-header">
              <h2 id="ing-modal-name"></h2>
              <button id="ing-modal-close" class="btn-icon">&times;</button>
            </div>
            <div id="ing-modal-body"></div>
          </div>
        </div>
      </div>
    `,
    init: () => {
      const ingredients: { foodId: number; servings: number; qty?: number; food: Food | RecipeIngredient; unitLabel?: string }[] = [];
      let mode: 'ingredients' | 'manual' = 'ingredients';
      const searchInput = document.getElementById('ing-search') as HTMLInputElement;
      const results = document.getElementById('ing-results')!;
      const session = createFoodSearchSession({
        search: query => foodsApi.search(query),
        onChange: snapshot => {
          searchInput.classList.toggle('searching', snapshot.status === 'debouncing' || snapshot.status === 'loading');
          results.innerHTML = '';
          results.classList.toggle('hidden', snapshot.status !== 'ready' && snapshot.status !== 'error');
          if (snapshot.status === 'ready') renderIngredientResults(snapshot.result);
          if (snapshot.status === 'error') results.innerHTML = '<p class="form-error" style="padding:8px">Search failed</p>';
        },
      });
      setCleanup(() => session.dispose());

      document.getElementById('back-btn')!.addEventListener('click', () => navigate('#/recipes'));

      // Ingredient modal close
      document.getElementById('ing-modal-close')!.addEventListener('click', () => {
        document.getElementById('ing-modal')!.classList.add('hidden');
      });

      // Show ingredient add/edit modal with unit picker
      const showIngredientModal = (food: Food, editIndex?: number) => {
        const isEdit = editIndex !== undefined;
        const modal = document.getElementById('ing-modal')!;
        document.getElementById('ing-modal-name')!.textContent = food.name;
        const body = document.getElementById('ing-modal-body')!;

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
          document.getElementById('ing-modal-per-label')!,
          document.querySelector('#ing-unit-select option[value="default"]'),
        );
        const perUnit = document.getElementById('ing-modal-per-unit')!;
        const total = document.getElementById('ing-modal-total')!;
        assignPerUnitMacros(perUnit, food);

        let unitScale = 1;
        // When editing, recover the unit scale from stored servings and qty
        if (isEdit) {
          const editQty = ingredients[editIndex!].qty ?? ingredients[editIndex!].servings;
          unitScale = ingredients[editIndex!].servings / editQty;
        }
        const qtyInput = document.getElementById('ing-qty') as HTMLInputElement;
        const unitSelect = document.getElementById('ing-unit-select') as HTMLSelectElement | null;
        if (unitSelect) assignSavedMeasureOptions(unitSelect, measures);

        const updateTotal = () => {
          const qty = parseFloat(qtyInput.value) || 1;
          assignTotalMacros(total, food, unitScale * qty, 'scaled');
        };

        const updatePerUnit = () => {
          assignPerUnitMacros(perUnit, food, unitScale, 'scaled');
        };

        if (unitSelect) {
          unitSelect.addEventListener('change', () => {
            if (unitSelect.value === 'default') {
              unitScale = 1;
              document.getElementById('ing-modal-per-label')!.textContent = `Per ${food.serving_size}${food.serving_unit}`;
            } else {
              const m = measures[parseInt(unitSelect.value)];
              unitScale = m.gramWeight / food.serving_size;
              document.getElementById('ing-modal-per-label')!.textContent = `Per ${m.label} (${m.gramWeight}g)`;
            }
            updatePerUnit();
            updateTotal();
          });
        }

        qtyInput.addEventListener('input', updateTotal);
        document.getElementById('ing-qty-minus')!.addEventListener('click', () => {
          qtyInput.value = String(Math.max(1, (parseFloat(qtyInput.value) || 1) - 1));
          updateTotal();
        });
        document.getElementById('ing-qty-plus')!.addEventListener('click', () => {
          qtyInput.value = String((parseFloat(qtyInput.value) || 1) + 1);
          updateTotal();
        });

        // Initial render
        updateTotal();

        document.getElementById('ing-add-btn')!.addEventListener('click', () => {
          const qty = parseFloat(qtyInput.value) || 1;
          const effectiveServings = qty * unitScale;
          const selectedUnit = unitSelect?.value;
          let unitLabel: string | undefined;
          if (selectedUnit && selectedUnit !== 'default') {
            const m = measures[parseInt(selectedUnit)];
            unitLabel = qty !== 1 ? `${qty}x ${m.label}` : m.label;
          } else {
            unitLabel = qty !== 1 ? `${qty}x ${food.serving_size}${food.serving_unit}` : `${food.serving_size}${food.serving_unit}`;
          }
          if (isEdit) {
            ingredients[editIndex!] = { foodId: food.id, servings: effectiveServings, qty, food: food as any, unitLabel };
          } else {
            ingredients.push({ foodId: food.id, servings: effectiveServings, qty, food: food as any, unitLabel });
          }
          renderIngredients(ingredients, mode, onEditIngredient);
          modal.classList.add('hidden');
          searchInput.value = '';
          session.setQuery('');
        });

        document.getElementById('ing-remove-btn')?.addEventListener('click', () => {
          ingredients.splice(editIndex!, 1);
          renderIngredients(ingredients, mode, onEditIngredient);
          modal.classList.add('hidden');
        });

        modal.classList.remove('hidden');
      };

      // Edit callback for ingredient rows
      const onEditIngredient = (idx: number) => {
        const ing = ingredients[idx];
        // The food may be a RecipeIngredient (from server) — cast to Food for the modal
        const food = ing.food as Food;
        showIngredientModal(food, idx);
      };

      // Mode toggle
      document.querySelectorAll('[data-mode]').forEach((tab) => {
        tab.addEventListener('click', () => {
          document.querySelector('[data-mode].active')?.classList.remove('active');
          tab.classList.add('active');
          mode = (tab as HTMLElement).dataset.mode as 'ingredients' | 'manual';
          session.setActive(mode === 'ingredients');
          document.getElementById('ingredients-section')!.classList.toggle('hidden', mode === 'manual');
          document.getElementById('manual-section')!.classList.toggle('hidden', mode === 'ingredients');
          updateTotals(ingredients, mode);
        });
      });

      // Auto-calc calories for manual mode
      const manualCalInput = document.getElementById('manual-cal') as HTMLInputElement;
      let manualCalManual = false;
      manualCalInput.addEventListener('input', () => { manualCalManual = true; });
      const autoCalcManual = () => {
        if (manualCalManual) return;
        const c = parseFloat((document.getElementById('manual-carbs') as HTMLInputElement).value) || 0;
        const p = parseFloat((document.getElementById('manual-protein') as HTMLInputElement).value) || 0;
        const f = parseFloat((document.getElementById('manual-fat') as HTMLInputElement).value) || 0;
        manualCalInput.value = String(Math.round(c * 4 + p * 4 + f * 9));
        updateTotals(ingredients, mode);
      };
      ['manual-carbs', 'manual-protein', 'manual-fat'].forEach(id =>
        document.getElementById(id)!.addEventListener('input', autoCalcManual)
      );
      manualCalInput.addEventListener('input', () => updateTotals(ingredients, mode));

      // Servings/unit changes update totals
      document.getElementById('recipe-servings')!.addEventListener('input', () => updateTotals(ingredients, mode));

      // Load existing recipe
      if (!isNew) {
        loadExistingRecipe(parseInt(params.id), ingredients, (recipeMode) => {
          mode = recipeMode;
          session.setActive(mode === 'ingredients');
          if (mode === 'manual') {
            document.querySelector('[data-mode="ingredients"]')?.classList.remove('active');
            document.querySelector('[data-mode="manual"]')?.classList.add('active');
            document.getElementById('ingredients-section')!.classList.add('hidden');
            document.getElementById('manual-section')!.classList.remove('hidden');
          }
        }, onEditIngredient);
      }

      // Ingredient search
      searchInput.addEventListener('input', () => {
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
          item.addEventListener('click', () => {
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
          item.addEventListener('click', async () => {
            try {
              const { food } = await foodsApi.saveExternal(ext);
              showIngredientModal(food);
            } catch {
              alert('Failed to save food');
            }
          });
          results.appendChild(item);
        }

        if (foods.length === 0 && external.length === 0) {
          results.innerHTML = '<p class="text-muted" style="padding:8px">No results</p>';
        }
      }

      // Form submit
      document.getElementById('recipe-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = (document.getElementById('recipe-name') as HTMLInputElement).value;
        const totalServings = parseFloat((document.getElementById('recipe-servings') as HTMLInputElement).value) || 1;
        const servingUnit = (document.getElementById('recipe-unit') as HTMLInputElement).value.trim() || 'serving';
        const btn = (e.target as HTMLFormElement).querySelector('button[type=submit]') as HTMLButtonElement;
        btn.disabled = true;

        try {
          const ingData = ingredients.map((i) => ({ foodId: i.foodId, servings: i.servings, qty: i.qty, unitLabel: i.unitLabel }));
          const manualCalories = mode === 'manual' ? (parseFloat(manualCalInput.value) || null) : null;
          const manualCarbsG = mode === 'manual' ? (parseFloat((document.getElementById('manual-carbs') as HTMLInputElement).value) || null) : null;
          const manualProteinG = mode === 'manual' ? (parseFloat((document.getElementById('manual-protein') as HTMLInputElement).value) || null) : null;
          const manualFatG = mode === 'manual' ? (parseFloat((document.getElementById('manual-fat') as HTMLInputElement).value) || null) : null;

          if (isNew) {
            await recipesApi.create({ name, totalServings, servingUnit, ingredients: ingData, manualCalories, manualCarbsG, manualProteinG, manualFatG });
          } else {
            await recipesApi.update(parseInt(params.id), { name, totalServings, servingUnit, ingredients: ingData, manualCalories, manualCarbsG, manualProteinG, manualFatG });
          }
          navigate('#/recipes');
        } catch {
          btn.disabled = false;
          btn.textContent = 'Failed - Retry';
        }
      });

      // Duplicate
      document.getElementById('copy-recipe')?.addEventListener('click', async () => {
        const btn = document.getElementById('copy-recipe') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Duplicating...';
        try {
          const { recipe } = await recipesApi.copy(parseInt(params.id));
          navigate(`#/recipes/${recipe.id}`);
        } catch {
          btn.disabled = false;
          btn.textContent = 'Duplicate Recipe';
        }
      });

      // Delete
      document.getElementById('delete-recipe')?.addEventListener('click', async () => {
        if (confirm('Delete this recipe?')) {
          await recipesApi.delete(parseInt(params.id));
          navigate('#/recipes');
        }
      });
    },
  };
}

async function loadExistingRecipe(
  id: number,
  ingredients: { foodId: number; servings: number; qty?: number; food: Food | RecipeIngredient; unitLabel?: string }[],
  onMode: (mode: 'ingredients' | 'manual') => void,
  onEdit?: (idx: number) => void
) {
  try {
    const { recipe, ingredients: ings } = await recipesApi.get(id);
    (document.getElementById('recipe-name') as HTMLInputElement).value = recipe.name;
    (document.getElementById('recipe-servings') as HTMLInputElement).value = String(recipe.total_servings);
    (document.getElementById('recipe-unit') as HTMLInputElement).value = recipe.serving_unit || 'serving';

    if (recipe.manual_calories != null) {
      // Manual mode
      (document.getElementById('manual-cal') as HTMLInputElement).value = String(recipe.manual_calories);
      (document.getElementById('manual-carbs') as HTMLInputElement).value = String(recipe.manual_carbs_g || '');
      (document.getElementById('manual-protein') as HTMLInputElement).value = String(recipe.manual_protein_g || '');
      (document.getElementById('manual-fat') as HTMLInputElement).value = String(recipe.manual_fat_g || '');
      onMode('manual');
      updateTotals(ingredients, 'manual');
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
      renderIngredients(ingredients, 'ingredients', onEdit);
    }
  } catch {
    // Ignore
  }
}

function updateTotals(
  ingredients: { foodId: number; servings: number; food: Food | RecipeIngredient }[],
  mode: 'ingredients' | 'manual'
) {
  const servings = parseFloat((document.getElementById('recipe-servings') as HTMLInputElement)?.value) || 1;
  const unit = (document.getElementById('recipe-unit') as HTMLInputElement)?.value.trim() || 'serving';
  const totalsEl = document.getElementById('recipe-totals');
  if (!totalsEl) return;

  let totalCal = 0, totalC = 0, totalP = 0, totalF = 0;

  if (mode === 'manual') {
    totalCal = parseFloat((document.getElementById('manual-cal') as HTMLInputElement)?.value) || 0;
    totalC = parseFloat((document.getElementById('manual-carbs') as HTMLInputElement)?.value) || 0;
    totalP = parseFloat((document.getElementById('manual-protein') as HTMLInputElement)?.value) || 0;
    totalF = parseFloat((document.getElementById('manual-fat') as HTMLInputElement)?.value) || 0;
  } else {
    for (const ing of ingredients) {
      const f = ing.food;
      totalCal += (f.calories || 0) * ing.servings;
      totalC += (f.carbs_g || 0) * ing.servings;
      totalP += (f.protein_g || 0) * ing.servings;
      totalF += (f.fat_g || 0) * ing.servings;
    }
  }

  const unitLabel = unit + (servings !== 1 ? 's' : '');
  totalsEl.innerHTML = `
    <h4>Per ${unit} (of ${servings} ${unitLabel})</h4>
    <div class="modal-macros">
      <div class="modal-macro"><strong>${Math.round(totalCal / servings)}</strong> kcal</div>
      <div class="modal-macro"><strong>${Math.round(totalC / servings * 10) / 10}g</strong> carbs</div>
      <div class="modal-macro"><strong>${Math.round(totalP / servings * 10) / 10}g</strong> protein</div>
      <div class="modal-macro"><strong>${Math.round(totalF / servings * 10) / 10}g</strong> fat</div>
    </div>
  `;
}

function renderIngredients(
  ingredients: { foodId: number; servings: number; qty?: number; food: Food | RecipeIngredient; unitLabel?: string }[],
  mode: 'ingredients' | 'manual',
  onEdit?: (idx: number) => void
) {
  const container = document.getElementById('ingredients-list')!;

  container.innerHTML = '';
  ingredients.forEach((ing, idx) => {
    const f = ing.food;
    const cal = (f.calories || 0) * ing.servings;
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

    const c = (f.carbs_g || 0) * ing.servings;
    const p = (f.protein_g || 0) * ing.servings;
    const fat = (f.fat_g || 0) * ing.servings;

    const el = document.createElement('div');
    el.className = 'ingredient-row';
    const info = document.createElement('div');
    info.className = 'ingredient-info ingredient-clickable';
    info.dataset.idx = String(idx);
    info.append(textSpan('ingredient-name', f.name), textSpan('ingredient-unit', unit));
    el.appendChild(info);
    el.insertAdjacentHTML('beforeend', `
      <div class="ingredient-macros">
        <span class="macro-chip chip-calories">${Math.round(cal)}</span>
        <span class="macro-chip chip-carbs">${Math.round(c)}c</span>
        <span class="macro-chip chip-protein">${Math.round(p)}p</span>
        <span class="macro-chip chip-fat">${Math.round(fat)}f</span>
      </div>
      <button type="button" class="btn-icon btn-remove-ing" data-idx="${idx}">&times;</button>
    `);
    container.appendChild(el);
  });

  updateTotals(ingredients, mode);

  // Edit handlers
  if (onEdit) {
    container.querySelectorAll('.ingredient-clickable').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt((el as HTMLElement).dataset.idx || '0');
        onEdit(idx);
      });
    });
  }

  // Remove handlers
  container.querySelectorAll('.btn-remove-ing').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
      ingredients.splice(idx, 1);
      renderIngredients(ingredients, mode, onEdit);
    });
  });
}

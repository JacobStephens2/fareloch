import { recipes as recipesApi, foods as foodsApi } from '../api';
import { navigate } from '../router';
import { mountFoodSearch } from '../food-search-session';
import { textSpan } from './food-search-text';
import { mountFoodQuantitySelection } from './food-quantity-selection';
import { mountMacrosEntry } from './macros-entry';
import type { Food, RecipeIngredient } from '../types';
import { macrosOf, scaleMacros, recipePerServing, roundMacros } from '../../server/src/nutrition';

// One mount owns all editor effects, including work that outlives its DOM.
export function mountRecipeEditor(root: HTMLElement, recipeId: 'new' | number): () => void {
  const isNew = recipeId === 'new';
  let disposed = false;
  let quantitySelection: ReturnType<typeof mountFoodQuantitySelection> | undefined;
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
  const session = mountFoodSearch(root, {
    kind: 'ingredient',
    foods: foodsApi,
    onSelect: food => showIngredientModal(food),
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

    quantitySelection?.dispose();
    body.innerHTML = `
      <div id="ingredient-quantity"></div>
      <div class="form-row">
        <button type="button" id="ing-add-btn" class="btn btn-primary" style="flex:1">${isEdit ? 'Update' : 'Add Ingredient'}</button>
        ${isEdit ? '<button type="button" id="ing-remove-btn" class="btn btn-danger" style="flex:0 0 auto">Remove</button>' : ''}
      </div>
    `;
    const stored = isEdit ? ingredients[editIndex!] : undefined;
    const selection = mountFoodQuantitySelection(find('ingredient-quantity'), food, {
      kind: 'ingredient',
      stored: stored ? { servings: stored.servings, quantity: stored.qty } : undefined,
    });
    quantitySelection = selection;
    on(find('ing-add-btn'), 'click', () => {
      const amount = selection.read();
      if (!amount) return;
      const { quantity: qty, servings: effectiveServings, unitLabel } = amount;
      if (isEdit) {
        ingredients[editIndex!] = { foodId: food.id, servings: effectiveServings, qty, food, unitLabel };
      } else {
        ingredients.push({ foodId: food.id, servings: effectiveServings, qty, food, unitLabel });
      }
      renderIngredients();
      modal.classList.add('hidden');
      session.setQuery('');
    });

    on(find('ing-remove-btn'), 'click', () => {
      if (!selection.read()) return;
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

  const macrosEntry = mountMacrosEntry(find('manual-macros'), 'manual', updateTotals);

  // Preview and Save share this one read; Ingredients mode leaves all Manual macros unset.
  function manualMacros() {
    if (mode === 'ingredients') return { calories: null, carbsG: null, proteinG: null, fatG: null };
    return macrosEntry.read();
  }

  // Servings/unit changes update totals
  on(find('recipe-servings'), 'input', () => updateTotals());

  // Load existing recipe
  if (!isNew) {
    void loadExistingRecipe();
  }

  session.setActive(true);

  // Form submit
  on(find('recipe-form'), 'submit', async (e) => {
    e.preventDefault();
    const values = manualMacros();
    if (!values) return;
    const name = (find('recipe-name') as HTMLInputElement).value;
    const totalServings = parseFloat((find('recipe-servings') as HTMLInputElement).value) || 1;
    const servingUnit = (find('recipe-unit') as HTMLInputElement).value.trim() || 'serving';
    const btn = (e.target as HTMLFormElement).querySelector('button[type=submit]') as HTMLButtonElement;
    btn.disabled = true;

    try {
      const ingData = ingredients.map((i) => ({ foodId: i.foodId, servings: i.servings, qty: i.qty, unitLabel: i.unitLabel }));
      const { calories: manualCalories, carbsG: manualCarbsG, proteinG: manualProteinG, fatG: manualFatG } = values;

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
        macrosEntry.hydrate({
          calories: recipe.manual_calories, carbsG: recipe.manual_carbs_g,
          proteinG: recipe.manual_protein_g, fatG: recipe.manual_fat_g,
        });
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

    const values = manualMacros();
    if (!values) return;
    const perServing = roundMacros(recipePerServing(
      {
        total_servings: servings,
        manual_calories: values.calories,
        manual_carbs_g: values.carbsG,
        manual_protein_g: values.proteinG,
        manual_fat_g: values.fatG,
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
    macrosEntry.dispose();
    quantitySelection?.dispose();
    session.dispose();
    events.abort();
  };
}

import { recipes as recipesApi, foods as foodsApi } from '../api';
import { navigate } from '../router';
import { mountFoodSearch } from '../food-search-session';
import { mountIngredientEditSession } from './ingredient-edit-session';
import { mountIngredientListSession } from './ingredient-list-session';
import { mountMacrosEntry } from './macros-entry';
import { createMountedLifetime } from '../mounted-lifetime';
import type { Food, RecipeIngredient } from '../types';
import { recipePerServing, roundMacros } from '../../server/src/nutrition';

// One mount owns all editor effects, including work that outlives its DOM.
export function mountRecipeEditor(root: HTMLElement, recipeId: 'new' | number): () => void {
  const isNew = recipeId === 'new';
  let disposeIngredient: (() => void) | undefined;
  let disposeIngredientList: (() => void) | undefined;
  let editedIngredient: (typeof ingredients)[number] | undefined;
  let disposeSearch: (() => void) | undefined;
  let disposeMacros: (() => void) | undefined;
  const find = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const { isLive, signal, dispose } = createMountedLifetime(root, {
    ownedNodes: [...root.querySelectorAll(
      '#back-btn, #recipe-form, #recipe-name, #recipe-servings, #recipe-unit, [data-mode], #ingredients-section, #ingredients-list, #ing-search, #ing-results, #manual-section, #manual-macros, #recipe-totals, button[type=submit], #copy-recipe, #delete-recipe, #ing-modal, #ing-modal-name, #ing-modal-close, #ing-modal-body',
    )],
    cleanup: () => {
      disposeIngredientList?.();
      disposeMacros?.();
      disposeIngredient?.();
      disposeSearch?.();
    },
  });
  if (!isLive()) return dispose;

  function on<K extends keyof HTMLElementEventMap>(element: Element | null, type: K, handler: (event: HTMLElementEventMap[K]) => void) {
    element?.addEventListener(type, event => {
      if (isLive() && element && root.contains(element)) handler(event as HTMLElementEventMap[K]);
    }, { signal });
  }

  const ingredients: { foodId: number; servings: number; qty?: number; food: Food | RecipeIngredient; unitLabel?: string }[] = [];
  let mode: 'ingredients' | 'manual' = 'ingredients';
  const session = mountFoodSearch(root, {
    kind: 'ingredient',
    isParentLive: isLive,
    foods: foodsApi,
    onSelect: food => showIngredientModal(food),
  });
  disposeSearch = session.dispose;


  on(find('back-btn'), 'click', () => navigate('#/recipes'));

  const showIngredientModal = (food: Food | RecipeIngredient, target?: (typeof ingredients)[number]) => {
    if (!isLive()) return;
    disposeIngredient?.();
    editedIngredient = target;
    const isEligible = () => isLive() && (!target || ingredients.includes(target));
    disposeIngredient = mountIngredientEditSession(
      find('ing-modal'), food,
      target ? { kind: 'edit', servings: target.servings, quantity: target.qty } : { kind: 'add' },
      isEligible,
      action => {
        // The child has already retired; only the captured parent/target gate this action.
        if (!isEligible()) return;
        if (action.kind === 'remove') {
          if (!target) return;
          ingredients.splice(ingredients.indexOf(target), 1);
        } else {
          const entry = { foodId: food.id, servings: action.servings, qty: action.quantity, food, unitLabel: action.unitLabel };
          if (target) Object.assign(target, entry);
          else ingredients.push(entry);
        }
        renderIngredients();
        if (action.kind === 'apply') session.setQuery('');
      },
    );
  };

  // Edit callback for ingredient rows
  const onEditIngredient = (ing: (typeof ingredients)[number]) => {
    if (!isLive() || !ingredients.includes(ing)) return;
    // A loaded ingredient's row identity is different from its Food identity.
    const food = { ...ing.food, id: ing.foodId };
    showIngredientModal(food, ing);
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

  const macrosEntry = mountMacrosEntry(find('manual-macros'), 'manual', updateTotals, isLive);
  disposeMacros = macrosEntry.dispose;

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
  // Even the initial empty list has its own mounted ownership.
  disposeIngredientList = mountIngredientListSession(find('ingredients-list'), {
    entries: ingredients, isParentLive: isLive, onEdit: onEditIngredient, onRemove: onRemoveIngredient,
  });

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
    if (!isLive()) return;
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
    if (!isLive()) return;
    disposeIngredientList?.();
    disposeIngredientList = mountIngredientListSession(find('ingredients-list'), {
      entries: ingredients, isParentLive: isLive, onEdit: onEditIngredient, onRemove: onRemoveIngredient,
    });
    updateTotals();
  }

  function onRemoveIngredient(ing: (typeof ingredients)[number]) {
    if (!isLive()) return;
    const index = ingredients.indexOf(ing);
    if (index < 0) return;
    if (editedIngredient === ing) disposeIngredient?.();
    ingredients.splice(index, 1);
    renderIngredients();
  }

  return dispose;
}

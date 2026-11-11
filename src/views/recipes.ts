import { recipes as recipesApi } from '../api';
import { navigate, setCleanup } from '../router';
import { mountRecipeEditor } from './recipe-editor-session';
import { mountRecipeList } from './recipe-list-session';

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
      const root = document.getElementById('app')!.querySelector<HTMLElement>('.page')!;
      const events = new AbortController();
      const newRecipe = root.querySelector<HTMLElement>('#new-recipe-btn')!;
      newRecipe.addEventListener('click', () => {
        if (root.isConnected && root.contains(newRecipe)) navigate('#/recipes/new');
      }, { signal: events.signal });
      const disposeList = mountRecipeList(root.querySelector<HTMLElement>('#recipe-list')!, {
        kind: 'manage', read: recipesApi.list,
        onSelect: recipe => navigate(`#/recipes/${recipe.id}`),
      });
      setCleanup(() => {
        events.abort();
        disposeList();
      });
    },
  };
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
            <div id="manual-macros"></div>
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
      const root = document.getElementById('recipe-form')!.closest<HTMLElement>('.page')!;
      setCleanup(mountRecipeEditor(root, isNew ? 'new' : parseInt(params.id)));
    },
  };
}

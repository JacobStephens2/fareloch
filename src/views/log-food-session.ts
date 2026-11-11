import { foods as foodsApi, meals as mealsApi, recipes as recipesApi } from '../api';
import { navigate } from '../router';
import { mountFoodSearch, mountSavedFoodList } from '../food-search-session';
import { mountMealAddSession } from './meal-add-session';
import { mountMacrosEntry } from './macros-entry';
import { mountRecipeList } from './recipe-list-session';
import { mountBarcodeScanner } from './barcode-scanner-session';
import { createMountedLifetime } from '../mounted-lifetime';
import type { Food, Recipe, MealType } from '../types';

export function mountLogFood(root: HTMLElement, date: string, mealType: MealType): () => void {
  let disposeMealAdd: (() => void) | undefined;
  let macrosEntry: ReturnType<typeof mountMacrosEntry> | undefined;
  let disposeRecipeList: (() => void) | undefined;
  let disposeSavedFoodList: (() => void) | undefined;
  let disposeSearch: (() => void) | undefined;
  let disposeScanner: (() => void) | undefined;
  let activeTab = 'search';
  let tabRevision = 0;
  const find = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const { isLive, signal, dispose } = createMountedLifetime(root, {
    ownedNodes: [...root.querySelectorAll(
      '#back-btn, #food-search, .tab, #tab-content, #scan-btn, #scanner-close, #scanner-container, #scanner-video, #food-detail-modal, #modal-food-name, #modal-close, #modal-body',
    )],
    cleanup: () => {
      ++tabRevision;
      disposeRecipeList?.();
      disposeSavedFoodList?.();
      macrosEntry?.dispose();
      disposeMealAdd?.();
      disposeSearch?.();
      disposeScanner?.();
    },
  });
  if (!isLive()) return dispose;

  function on<K extends keyof HTMLElementEventMap>(element: Element | null, type: K, handler: (event: HTMLElementEventMap[K]) => void) {
    element?.addEventListener(type, event => {
      if (isLive() && element && root.contains(element)) handler(event as HTMLElementEventMap[K]);
    }, { signal });
  }

  disposeScanner = mountBarcodeScanner(root, { onBarcode: lookupBarcode, isParentLive: isLive });

  const content = find('tab-content')!;
  const session = mountFoodSearch(root, {
    kind: 'meal',
    isParentLive: isLive,
    foods: foodsApi,
    onSelect: showAddModal,
    onQueryInput: () => {
      if (!isLive()) return;
      disposeRecipeList?.();
      disposeSavedFoodList?.();
      ++tabRevision;
      activeTab = 'search';
      root.querySelector('.tab.active')?.classList.remove('active');
      root.querySelector('[data-tab="search"]')!.classList.add('active');
      session.setActive(true);
    },
  });
  disposeSearch = session.dispose;

  // Back button
  on(find('back-btn'), 'click', () => navigate('#/'));

  // Tab switching
  root.querySelectorAll('.tab').forEach((tab) => {
    on(tab, 'click', () => {
      root.querySelector('.tab.active')?.classList.remove('active');
      tab.classList.add('active');
      activeTab = (tab as HTMLElement).dataset.tab || 'search';
      const current = ++tabRevision;
      disposeRecipeList?.();
      disposeSavedFoodList?.();
      session.setActive(activeTab === 'search');
      if (activeTab === 'recipes') {
        const host = document.createElement('div');
        host.className = 'food-list';
        content.replaceChildren(host);
        disposeRecipeList = mountRecipeList(host, {
          kind: 'meal', read: recipesApi.list, onSelect: showRecipeAddModal, isParentLive: isLive,
        });
      } else if (activeTab === 'recent' || activeTab === 'custom') {
        showSavedFoodList(activeTab, current);
      } else if (activeTab === 'quick') showQuickAddForm(content);
    });
  });

  function showSavedFoodList(kind: 'recent' | 'custom', current: number) {
    if (!isLive()) return;
    disposeSavedFoodList?.();
    const host = document.createElement('div');
    content.replaceChildren(host);
    disposeSavedFoodList = mountSavedFoodList(host, kind === 'recent'
      ? { kind, read: foodsApi.recent, onSelect: showAddModal, isParentLive: isLive }
      : { kind, read: foodsApi.custom, onSelect: showAddModal, isParentLive: isLive, onCreate: () => showCreateFoodForm(() => {
        if (isLive() && current === tabRevision) showSavedFoodList(kind, current);
      }) });
  }

  async function lookupBarcode(code: string) {
    if (!isLive()) return;
    const content = find('tab-content')!;
    content.innerHTML = '<div class="loading-spinner">Looking up barcode...</div>';

    try {
      const { food } = await foodsApi.barcode(code);
      if (!isLive()) return;
      showAddModal(food);
      const found = document.createElement('p');
      found.className = 'text-muted';
      found.append('Found: ', document.createTextNode(food.name));
      content.replaceChildren(found);
    } catch {
      if (!isLive()) return;
      const missing = document.createElement('p');
      missing.className = 'form-error';
      missing.append('No product found for barcode ', document.createTextNode(code));
      content.replaceChildren(missing);
    }
  }

  function showAddModal(food: Food) {
    showMealAdd({ kind: 'food', food });
  }

  function showRecipeAddModal(recipe: Recipe) {
    showMealAdd({ kind: 'recipe', recipe });
  }

  function showMealAdd(selection: Parameters<typeof mountMealAddSession>[1]) {
    if (!isLive()) return;
    disposeMealAdd?.();
    disposeMealAdd = mountMealAddSession(find('food-detail-modal'), selection, date, mealType, isLive, () => {
      if (!isLive()) return;
      disposeMealAdd?.();
      closeModal();
      navigate('#/');
    });
  }

  function showQuickAddForm(container: HTMLElement) {
    if (!isLive()) return;
    container.innerHTML = `
      <form id="quick-form" class="quick-form">
        <div class="form-group">
          <label for="quick-name">Description (optional)</label>
          <input type="text" id="quick-name" placeholder="e.g. Handful of almonds" />
        </div>
        <div id="quick-macros"></div>
        <button type="submit" class="btn btn-primary btn-block">Add to ${capitalize(mealType)}</button>
      </form>
    `;

    macrosEntry?.dispose();
    const entry = mountMacrosEntry(find('quick-macros'), 'quick', undefined, isLive);
    macrosEntry = entry;

    on(find('quick-form'), 'submit', async (e) => {
      e.preventDefault();
      const values = entry.read();
      if (!values) return;
      const btn = (e.target as HTMLFormElement).querySelector('button')!;
      btn.disabled = true;

      try {
        await mealsApi.quickLog({
          date,
          mealType,
          name: (find('quick-name') as HTMLInputElement).value || undefined,
          ...values,
        });
        if (!isLive()) return;
        navigate('#/');
      } catch {
        if (!isLive()) return;
        btn.disabled = false;
        btn.textContent = 'Failed - Retry';
      }
    });
  }

  function showCreateFoodForm(onCancel: () => void) {
    if (!isLive()) return;
    const content = find('tab-content')!;
    content.innerHTML = `
      <form id="create-food-form">
        <div class="form-group">
          <label for="cf-name">Name *</label>
          <input type="text" id="cf-name" required />
        </div>
        <div class="form-group">
          <label for="cf-brand">Brand</label>
          <input type="text" id="cf-brand" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="cf-serving">Serving Size</label>
            <input type="number" id="cf-serving" value="1" min="0" step="0.1" />
          </div>
          <div class="form-group">
            <label for="cf-unit">Unit</label>
            <input type="text" id="cf-unit" value="serving" />
          </div>
        </div>
        <div id="cf-macros"></div>
        <button type="submit" class="btn btn-primary btn-block">Create & Add to ${capitalize(mealType)}</button>
        <button type="button" id="cancel-create" class="btn btn-outline btn-block">Cancel</button>
      </form>
    `;

    macrosEntry?.dispose();
    const entry = mountMacrosEntry(find('cf-macros'), 'custom', undefined, isLive);
    macrosEntry = entry;

    on(find('cancel-create'), 'click', onCancel);

    on(find('create-food-form'), 'submit', async (e) => {
      e.preventDefault();
      const values = entry.read();
      if (!values) return;
      const btn = (e.target as HTMLFormElement).querySelector('button[type=submit]') as HTMLButtonElement;
      btn.disabled = true;

      try {
        const { food } = await foodsApi.create({
          name: (find('cf-name') as HTMLInputElement).value,
          brand: (find('cf-brand') as HTMLInputElement).value || null,
          serving_size: parseFloat((find('cf-serving') as HTMLInputElement).value) || 1,
          serving_unit: (find('cf-unit') as HTMLInputElement).value || 'serving',
          calories: values.calories,
          carbs_g: values.carbsG,
          protein_g: values.proteinG,
          fat_g: values.fatG,
        });

        if (!isLive()) return;
        showAddModal(food);
      } catch {
        if (!isLive()) return;
        btn.disabled = false;
        btn.textContent = 'Failed - Retry';
      }
    });
  }

  function closeModal() {
    if (!isLive()) return;
    find('food-detail-modal')?.classList.add('hidden');
  }

  session.setActive(true);
  return dispose;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

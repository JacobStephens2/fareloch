import { foods as foodsApi, recipes as recipesApi } from '../api';
import { navigate } from '../router';
import { mountFoodSearch, mountSavedFoodList } from '../food-search-session';
import { mountMealAddSession } from './meal-add-session';
import { mountLogFoodFormSession } from './log-food-form-session';
import { mountRecipeList } from './recipe-list-session';
import { mountBarcodeScanner } from './barcode-scanner-session';
import { createMountedLifetime } from '../mounted-lifetime';
import type { Food, Recipe, MealType } from '../types';

export function mountLogFood(root: HTMLElement, date: string, mealType: MealType): () => void {
  let disposeMealAdd: (() => void) | undefined;
  let disposeForm: (() => void) | undefined;
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
      disposeForm?.();
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
      disposeForm?.();
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
      disposeForm?.();
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
      } else if (activeTab === 'quick') showForm({ kind: 'quick', date, mealType, isParentLive: isLive, onSaved: () => {
        if (isLive()) navigate('#/');
      } });
    });
  });

  function showSavedFoodList(kind: 'recent' | 'custom', current: number) {
    if (!isLive()) return;
    disposeSavedFoodList?.();
    disposeForm?.();
    const host = document.createElement('div');
    content.replaceChildren(host);
    disposeSavedFoodList = mountSavedFoodList(host, kind === 'recent'
      ? { kind, read: foodsApi.recent, onSelect: showAddModal, isParentLive: isLive }
      : { kind, read: foodsApi.custom, onSelect: showAddModal, isParentLive: isLive, onCreate: () => showForm({
        kind: 'custom', mealType, isParentLive: isLive, onCreated: showAddModal,
        onCancel: () => {
          if (isLive() && current === tabRevision) showSavedFoodList(kind, current);
        },
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

  function showForm(options: Parameters<typeof mountLogFoodFormSession>[1]) {
    if (!isLive()) return;
    disposeForm?.();
    disposeForm = mountLogFoodFormSession(content, options);
  }

  function closeModal() {
    if (!isLive()) return;
    find('food-detail-modal')?.classList.add('hidden');
  }

  session.setActive(true);
  return dispose;
}

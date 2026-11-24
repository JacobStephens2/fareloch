import { foods as foodsApi, meals, recipes as recipesApi } from '../api';
import { navigate } from '../router';
import { state } from '../state';
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
  let addedEntries = 0;
  let pendingWrites = 0;
  let finishing = false;
  const failedWritesWhileFinishing: string[] = [];
  const pendingQuickLogs = new Set<string>();
  const routeHash = window.location.hash;
  const find = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const { isLive: isMounted, signal, dispose } = createMountedLifetime(root, {
    ownedNodes: [...root.querySelectorAll(
      '#back-btn, #log-food-done, #log-food-count, #quick-log-feedback, #food-search, .tab, #tab-content, #scan-btn, #scanner-close, #scanner-container, #scanner-video, #food-detail-modal, #modal-food-name, #modal-close, #modal-body',
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
  const isLive = () => isMounted() && window.location.hash === routeHash;
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
  const done = find<HTMLButtonElement>('log-food-done');
  on(done, 'click', () => {
    if (finishing) return;
    finishing = true;
    if (pendingWrites > 0) {
      done.disabled = true;
      done.textContent = 'Saving…';
    }
    finishWhenReady();
  });

  function finishWhenReady() {
    if (!finishing || pendingWrites !== 0 || !isLive()) return;
    state.selectedDate = date;
    if (failedWritesWhileFinishing.length) {
      state.mealLogNotice = `${failedWritesWhileFinishing.join(' ')} Open Log Food to retry.`;
    }
    navigate('#/');
  }

  async function recordEntry(write: () => Promise<unknown>, failureMessage: string) {
    pendingWrites++;
    try {
      await write();
      if (isLive()) {
        addedEntries++;
        find('log-food-count').textContent = `${addedEntries} ${addedEntries === 1 ? 'entry' : 'entries'} added`;
      }
    } catch (error) {
      if (finishing && isLive()) failedWritesWhileFinishing.push(failureMessage);
      throw error;
    } finally {
      pendingWrites--;
      finishWhenReady();
    }
  }

  async function quickLog(kind: 'food' | 'recipe', { id, name }: Food | Recipe) {
    const key = `${kind}:${id}`;
    if (pendingQuickLogs.has(key)) return;
    pendingQuickLogs.add(key);
    const feedback = find('quick-log-feedback');
    const identity = kind === 'food' ? { foodId: id } : { recipeId: id };
    const failureMessage = `Could not add ${name}.`;
    try {
      feedback.textContent = '';
      await recordEntry(() => meals.log({ date, mealType, ...identity, servings: 1 }), failureMessage);
      if (isLive()) feedback.textContent = ` · Added ${name}.`;
    } catch {
      if (isLive()) feedback.textContent = ` · ${failureMessage} Use + to retry.`;
    } finally {
      pendingQuickLogs.delete(key);
    }
  }

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
          onQuickLog: recipe => quickLog('recipe', recipe),
        });
      } else if (activeTab === 'recent' || activeTab === 'custom') {
        showSavedFoodList(activeTab, current);
      } else if (activeTab === 'quick') showQuickAdd();
    });
  });

  function showQuickAdd() {
    showForm({
      kind: 'quick', date, mealType, isParentLive: isLive,
      quickLog: data => recordEntry(() => meals.quickLog(data), 'Could not save a Quick Add entry.'),
      onSaved: showQuickAdd,
    });
  }

  function showSavedFoodList(kind: 'recent' | 'custom', current: number) {
    if (!isLive()) return;
    disposeSavedFoodList?.();
    disposeForm?.();
    disposeForm = undefined;
    const host = document.createElement('div');
    content.replaceChildren(host);
    const actions = {
      onSelect: showAddModal,
      onQuickLog: (food: Food) => quickLog('food', food),
      isParentLive: isLive,
    };
    disposeSavedFoodList = mountSavedFoodList(host, kind === 'recent'
      ? { ...actions, kind, read: foodsApi.recent }
      : { ...actions, kind, read: foodsApi.custom, onCreate: () => {
        const restoreList = () => {
          if (isLive() && current === tabRevision && (!disposeForm || disposeForm === original)) showSavedFoodList(kind, current);
        };
        const original = showForm({
          kind: 'custom', mealType, isParentLive: isLive,
          onCreated: food => {
            restoreList();
            showAddModal(food);
          },
          onCancel: restoreList,
        });
      } });
  }

  async function lookupBarcode(code: string) {
    if (!isLive()) return;
    ++tabRevision;
    content.innerHTML = '<div class="loading-spinner">Looking up barcode...</div>';

    try {
      const { food } = await foodsApi.barcode(code);
      if (!isLive()) return;
      ++tabRevision;
      showAddModal(food);
      const found = document.createElement('p');
      found.className = 'text-muted';
      found.append('Found: ', document.createTextNode(food.name));
      content.replaceChildren(found);
    } catch {
      if (!isLive()) return;
      ++tabRevision;
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
    const { name } = selection.kind === 'food' ? selection.food : selection.recipe;
    disposeMealAdd = mountMealAddSession(find('food-detail-modal'), selection, date, mealType, isLive,
      data => recordEntry(() => meals.log(data), `Could not add ${name}.`));
  }

  function showForm(options: Parameters<typeof mountLogFoodFormSession>[1]) {
    if (!isLive()) return;
    disposeForm?.();
    return disposeForm = mountLogFoodFormSession(content, options);
  }

  session.setActive(true);
  return dispose;
}

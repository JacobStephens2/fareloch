import { foods as foodsApi, meals as mealsApi, recipes as recipesApi } from '../api';
import { navigate } from '../router';
import { createFoodSearchSession, type FoodSearchResult } from '../food-search-session';
import { assignFoodDetailText, assignPerUnitMacros, assignSavedMeasureOptions, assignTotalMacros, macroChips, measureCountSuffix, savedMeasureSuffix, sourceLabel, textSpan } from './food-search-text';
import type { Food, ExternalFood, FoodMeasure, Recipe, MealType } from '../types';
import { scaleMacros, roundMacros, unitScale, caloriesFromMacros } from '../../server/src/nutrition';

// Only physical camera ownership is shared between mounted Log Food sessions.
let cameraGate: Promise<void> = Promise.resolve();
let nextCameraHost = 0;

type CameraAttempt = {
  host: HTMLElement;
  cancelled: boolean;
  consumed: boolean;
  code?: string;
  requestClose: () => void;
};

export function mountLogFood(root: HTMLElement, date: string, mealType: MealType): () => void {
  let disposed = false;
  const events = new AbortController();
  const isLive = () => !disposed && root.isConnected;
  const find = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  function on<K extends keyof HTMLElementEventMap>(element: Element | null, type: K, handler: (event: HTMLElementEventMap[K]) => void) {
    element?.addEventListener(type, event => {
      if (isLive() && element && root.contains(element)) handler(event as HTMLElementEventMap[K]);
    }, { signal: events.signal });
  }

  const scannerContainer = find('scanner-container');
  const scannerSlot = find('scanner-video');
  let cameraAttempt: CameraAttempt | undefined;
  const validAttempt = (attempt: CameraAttempt) => isLive() && cameraAttempt === attempt && !attempt.cancelled;

  function closeScanner() {
    if (cameraAttempt) {
      cameraAttempt.cancelled = true;
      cameraAttempt.requestClose();
    }
    if (isLive()) scannerContainer.classList.add('hidden');
  }

  // Optional constraints never hold camera release or the next attempt hostage.
  async function enhanceCamera(attempt: CameraAttempt) {
    try {
      const track = attempt.host.querySelector('video')?.srcObject as MediaStream | null;
      const cameraTrack = track?.getVideoTracks()[0];
      if (!cameraTrack || !validAttempt(attempt) || attempt.consumed) return;
      const caps = cameraTrack.getCapabilities() as MediaTrackCapabilities & {
        focusMode?: string[]; zoom?: { min: number; max: number }; torch?: boolean;
      };
      const advanced: MediaTrackConstraintSet[] = [];
      if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' } as MediaTrackConstraintSet);
      if (caps.zoom && caps.zoom.min < caps.zoom.max) advanced.push({ zoom: Math.min(1.5, caps.zoom.max) } as MediaTrackConstraintSet);
      try {
        if (advanced.length) await cameraTrack.applyConstraints({ advanced });
      } catch { /* Autofocus/zoom are optional; flashlight may still be supported. */ }
      if (!validAttempt(attempt) || attempt.consumed || !caps.torch) return;
      const toolbar = document.createElement('div');
      toolbar.className = 'scanner-toolbar';
      const button = document.createElement('button');
      button.id = 'torch-btn';
      button.className = 'btn btn-sm btn-outline';
      button.textContent = 'Flashlight';
      toolbar.append(button);
      scannerContainer.insertBefore(toolbar, find('scanner-close'));
      let torchOn = false;
      on(button, 'click', async () => {
        if (!validAttempt(attempt) || attempt.consumed) return;
        const next = !torchOn;
        try {
          await cameraTrack.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
          if (!validAttempt(attempt) || attempt.consumed) return;
          torchOn = next;
          button.textContent = torchOn ? 'Flashlight Off' : 'Flashlight';
        } catch { /* Keep the last successfully applied flashlight state. */ }
      });
    } catch { /* Unsupported camera capabilities are nonfatal. */ }
  }

  function openScanner() {
    if (cameraAttempt && !cameraAttempt.cancelled && !cameraAttempt.consumed) {
      closeScanner();
      return;
    }
    scannerContainer.classList.remove('hidden');
    scannerContainer.querySelector('.form-error')?.remove();
    scannerContainer.querySelector('.scanner-toolbar')?.remove();
    const host = document.createElement('div');
    host.id = `log-food-camera-${++nextCameraHost}`;
    scannerSlot.append(host);
    let requestClose!: () => void;
    const closing = new Promise<void>(resolve => { requestClose = resolve; });
    const attempt: CameraAttempt = { host, cancelled: false, consumed: false, requestClose };
    cameraAttempt = attempt;
    const previous = cameraGate;

    async function runCamera() {
      let scanner: import('html5-qrcode').Html5Qrcode | undefined;
      let started = false;
      const tracks = new Set<MediaStreamTrack>();
      const captureTracks = () => {
        attempt.host.querySelectorAll('video').forEach(video => {
          const stream = video.srcObject as MediaStream | null;
          stream?.getTracks().forEach(track => tracks.add(track));
        });
      };
      try {
        await previous;
        if (!validAttempt(attempt)) return;
        const { Html5Qrcode } = await import('html5-qrcode');
        if (!validAttempt(attempt)) return;
        scanner = new Html5Qrcode(host.id);
        started = true;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 15, qrbox: { width: Math.min(window.innerWidth - 40, 300), height: 150 }, aspectRatio: 1.777778 },
          code => {
            if (!validAttempt(attempt) || attempt.consumed) return;
            attempt.consumed = true;
            attempt.code = code;
            scannerContainer.classList.add('hidden');
            attempt.requestClose();
          },
          () => {},
        );
        if (validAttempt(attempt) && !attempt.consumed) void enhanceCamera(attempt);
        if (validAttempt(attempt) && !attempt.consumed) await closing;
      } catch {
        if (validAttempt(attempt) && !attempt.consumed) {
          const error = document.createElement('p');
          error.className = 'form-error';
          error.textContent = 'Camera access denied or not available.';
          scannerContainer.insertBefore(error, find('scanner-close'));
        }
      } finally {
        try {
          captureTracks();
          if (scanner && started) {
            try { await scanner.stop(); } catch { /* Fall back to this host's captured tracks. */ }
          }
        } finally {
          captureTracks();
          for (const track of tracks) {
            try { if (track.readyState !== 'ended') track.stop(); } catch { /* Continue releasing the other owned tracks. */ }
          }
          host.remove();
        }
      }
    }

    // Cleanup always settles the private gate, even if a scanner adapter throws.
    cameraGate = runCamera().catch(() => {});
    void cameraGate.then(() => {
      if (validAttempt(attempt) && attempt.code !== undefined) void lookupBarcode(attempt.code);
      if (cameraAttempt === attempt) {
        if (isLive()) scannerContainer.querySelector('.scanner-toolbar')?.remove();
        cameraAttempt = undefined;
      }
    });
  }

  on(find('scan-btn'), 'click', openScanner);
  on(find('scanner-close'), 'click', closeScanner);

  const searchInput = find('food-search') as HTMLInputElement;
  const content = find('tab-content')!;
  let activeTab = 'search';
  let tabRevision = 0;
  const session = createFoodSearchSession({
    search: query => foodsApi.search(query),
    loadDefault: async () => ({ foods: (await foodsApi.recent()).foods, external: [] }),
    onChange: snapshot => {
      if (!isLive()) return;
      searchInput.classList.toggle('searching', snapshot.status === 'debouncing' ||
        (snapshot.status === 'loading' && snapshot.source === 'search'));
      if (snapshot.status === 'inactive') return;
      content.innerHTML = '';
      if (snapshot.status === 'ready') {
        if (snapshot.source === 'default') {
          if (snapshot.result.foods.length) {
            content.innerHTML = '<h4 class="section-label">Recent</h4>';
            renderFoodList(content, snapshot.result.foods, { showSourceLabel: true });
          } else {
            content.innerHTML = '<p class="text-muted">Type to search for foods</p>';
          }
        } else {
          renderSearchResults(content, snapshot.result);
        }
      } else if (snapshot.status === 'error') {
        content.innerHTML = snapshot.source === 'default'
          ? '<p class="text-muted">Type to search for foods</p>'
          : '<p class="form-error">Search failed</p>';
      } else if (snapshot.status === 'loading' || snapshot.status === 'debouncing') {
        content.innerHTML = `<div class="loading-spinner">${snapshot.source === 'search' ? 'Searching...' : 'Loading...'}</div>`;
      }
    },
  });

  // Back button
  on(find('back-btn'), 'click', () => navigate('#/'));

  // Tab switching
  root.querySelectorAll('.tab').forEach((tab) => {
    on(tab, 'click', () => {
      root.querySelector('.tab.active')?.classList.remove('active');
      tab.classList.add('active');
      activeTab = (tab as HTMLElement).dataset.tab || 'search';
      const current = ++tabRevision;
      session.setActive(activeTab === 'search');
      if (activeTab !== 'search') {
        void loadTab(content, activeTab, () => isLive() && current === tabRevision);
      }
    });
  });

  // Search input
  on(searchInput, 'input', () => {
    ++tabRevision;
    activeTab = 'search';
    root.querySelector('.tab.active')?.classList.remove('active');
    root.querySelector('[data-tab="search"]')!.classList.add('active');
    session.setQuery(searchInput.value);
    session.setActive(true);
  });


  async function loadTab(content: HTMLElement, tab: string, isCurrent: () => boolean) {
    if (tab === 'recent') {
      content.innerHTML = '<div class="loading-spinner">Loading...</div>';
      try {
        const { foods } = await foodsApi.recent();
        if (!isCurrent()) return;
        if (foods.length === 0) {
          content.innerHTML = '<p class="text-muted">No recent foods</p>';
          return;
        }
        renderFoodList(content, foods);
      } catch {
        if (!isCurrent()) return;
        content.innerHTML = '<p class="form-error">Failed to load recent foods</p>';
      }
      return;
    }

    if (tab === 'custom') {
      content.innerHTML = '<div class="loading-spinner">Loading...</div>';
      try {
        const { foods } = await foodsApi.custom();
        if (!isCurrent()) return;
        let html = '<button id="create-food-btn" class="btn btn-outline btn-block" style="margin-bottom:12px">+ Create Custom Food</button>';
        if (foods.length === 0) {
          html += '<p class="text-muted">No custom foods yet</p>';
        }
        content.innerHTML = html;
        if (foods.length > 0) renderFoodList(content, foods, { append: true });
        on(find('create-food-btn'), 'click', () => showCreateFoodForm(() => {
          if (isCurrent()) void loadTab(content, tab, isCurrent);
        }));
      } catch {
        if (!isCurrent()) return;
        content.innerHTML = '<p class="form-error">Failed to load foods</p>';
      }
      return;
    }

    if (tab === 'recipes') {
      content.innerHTML = '<div class="loading-spinner">Loading...</div>';
      try {
        const { recipes } = await recipesApi.list();
        if (!isCurrent()) return;
        if (recipes.length === 0) {
          content.innerHTML = '<p class="text-muted">No recipes yet. <a href="#/recipes">Create one</a></p>';
          return;
        }
        content.innerHTML = '';
        renderRecipeList(content, recipes);
      } catch {
        if (!isCurrent()) return;
        content.innerHTML = '<p class="form-error">Failed to load recipes</p>';
      }
      return;
    }

    if (tab === 'quick') {
      showQuickAddForm(content);
      return;
    }
  }

  function renderSearchResults(content: HTMLElement, { foods, external }: FoodSearchResult) {
    let html = '';

    if (foods.length > 0) {
      html += '<h4 class="section-label">Saved Foods</h4>';
    }
    content.innerHTML = html;
    if (foods.length > 0) renderFoodList(content, foods, { showSourceLabel: true });

    if (external.length > 0) {
      const extHeader = document.createElement('h4');
      extHeader.className = 'section-label';
      extHeader.textContent = 'External Results';
      content.appendChild(extHeader);
      renderExternalList(content, external);

      if (external.some(f => f.source === 'fatsecret')) {
        const attr = document.createElement('div');
        attr.className = 'api-attribution';
        attr.innerHTML = '<a href="https://platform.fatsecret.com" target="_blank" rel="noopener">Powered by FatSecret Platform API</a>';
        content.appendChild(attr);
      }
    }

    if (foods.length === 0 && external.length === 0) {
      content.innerHTML = '<p class="text-muted">No results found</p>';
    }
  }

  async function lookupBarcode(code: string) {
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

  function renderFoodList(container: HTMLElement, foods: Food[], options: { append?: boolean; showSourceLabel?: boolean } = {}) {
    const append = options.append ?? false;
    const showSourceLabel = options.showSourceLabel ?? false;
    const list = document.createElement('div');
    list.className = 'food-list';

    for (const food of foods) {
      const info = document.createElement('div');
      info.className = 'food-item-info';
      const servingText = `${food.serving_size}${food.serving_unit}${savedMeasureSuffix(food.measures)}`;
      const serving = textSpan('food-serving', showSourceLabel ? `${servingText} · ` : servingText);
      if (showSourceLabel) serving.appendChild(sourceLabel(food.source));
      info.append(
        textSpan('food-item-name', food.name),
        ...(food.brand ? [textSpan('food-brand', food.brand)] : []),
        serving,
      );
      const item = document.createElement('div');
      item.className = 'food-item';
      item.append(info, macroChips({ calories: food.calories, carbs: food.carbs_g, protein: food.protein_g, fat: food.fat_g }));
      on(item, 'click', () => showAddModal(food));
      list.appendChild(item);
    }

    if (append) container.appendChild(list);
    else {
      const existing = container.querySelector('.food-list');
      if (existing) existing.replaceWith(list);
      else container.appendChild(list);
    }
  }

  function renderExternalList(container: HTMLElement, items: ExternalFood[]) {
    const list = document.createElement('div');
    list.className = 'food-list';

    for (const item of items) {
      const serving = textSpan('food-serving', `${item.servingSize}${item.servingUnit}${measureCountSuffix(item.measures?.length ?? 0)} · `);
      serving.appendChild(sourceLabel(item.source));
      const info = document.createElement('div');
      info.className = 'food-item-info';
      info.append(
        textSpan('food-item-name', item.name),
        ...(item.brand ? [textSpan('food-brand', item.brand)] : []),
        serving,
      );
      const el = document.createElement('div');
      el.className = 'food-item';
      el.append(info, macroChips({ calories: item.calories, carbs: item.carbsG, protein: item.proteinG, fat: item.fatG }));
      on(el, 'click', async () => {
        try {
          const { food } = await foodsApi.saveExternal(item);
          if (!isLive()) return;
          showAddModal(food);
        } catch {
          if (isLive()) alert('Failed to save food');
        }
      });
      list.appendChild(el);
    }

    container.appendChild(list);
  }

  function renderRecipeList(container: HTMLElement, recipeList: Recipe[]) {
    const list = document.createElement('div');
    list.className = 'food-list';

    for (const recipe of recipeList) {
      const el = document.createElement('div');
      el.className = 'food-item';
      el.innerHTML = `
        <div class="food-item-info">
          <span class="food-item-name">${recipe.name}</span>
          <span class="food-serving">${recipe.ingredientCount > 0 ? `${recipe.ingredientCount} ingredients` : 'Manual macros'} &middot; ${recipe.total_servings} ${recipe.serving_unit || 'serving'}${recipe.total_servings !== 1 ? 's' : ''}</span>
        </div>
        <div class="food-item-macros">
          <span class="macro-chip chip-calories">${recipe.perServing.calories}</span>
          <span class="macro-chip chip-carbs">${recipe.perServing.carbsG}c</span>
          <span class="macro-chip chip-protein">${recipe.perServing.proteinG}p</span>
          <span class="macro-chip chip-fat">${recipe.perServing.fatG}f</span>
        </div>
      `;
      on(el, 'click', () => showRecipeAddModal(recipe));
      list.appendChild(el);
    }

    container.appendChild(list);
  }

  function parseMeasures(food: Food): FoodMeasure[] {
    if (!food.measures) return [];
    try {
      return JSON.parse(food.measures);
    } catch {
      return [];
    }
  }

  function showAddModal(food: Food) {
    const modal = find('food-detail-modal')!;
    find('modal-food-name')!.textContent = food.name;

    const measures = parseMeasures(food);
    const hasMeasures = measures.length > 0;

    const measureOptions = hasMeasures
      ? `<div class="form-group">
          <label for="unit-select">Unit</label>
          <select id="unit-select">
            <option value="default"></option>
          </select>
        </div>`
      : '';

    const body = find('modal-body')!;
    body.innerHTML = `
      ${food.brand ? '<p class="food-brand"></p>' : ''}
      <div class="modal-macros" id="modal-per-unit"></div>
      <p class="text-muted" id="modal-per-label"></p>
      ${measureOptions}
      <div class="form-group">
        <label for="servings-input">Quantity</label>
        <div class="servings-control">
          <button id="serv-minus" class="btn-icon">-</button>
          <input type="number" id="servings-input" value="1" min="1" step="1" />
          <button id="serv-plus" class="btn-icon">+</button>
        </div>
      </div>
      <div class="modal-total" id="modal-total"></div>
      <button id="add-food-btn" class="btn btn-primary btn-block">Add to ${capitalize(mealType)}</button>
    `;
    assignFoodDetailText(
      body,
      food,
      find('modal-per-label')!,
      root.querySelector('#unit-select option[value="default"]'),
    );
    const perUnit = find('modal-per-unit')!;
    const total = find('modal-total')!;
    assignPerUnitMacros(perUnit, food);
    assignTotalMacros(total, food);

    // Named scale so it does not shadow the Nutrition unitScale function.
    let scale = 1;

    const servingsInput = find('servings-input') as HTMLInputElement;
    const perLabel = find('modal-per-label');
    const unitSelect = find('unit-select') as HTMLSelectElement | null;
    if (unitSelect) assignSavedMeasureOptions(unitSelect, measures);

    const updateTotal = () => {
      const qty = parseFloat(servingsInput.value) || 1;
      assignTotalMacros(total, food, scale * qty, 'rounded');
    };

    const updatePerUnit = () => {
      assignPerUnitMacros(perUnit, food, scale, 'rounded');
    };

    if (unitSelect) {
      on(unitSelect, 'change', () => {
        const val = unitSelect.value;
        if (val === 'default') {
          scale = 1;
          perLabel.textContent = `Per ${food.serving_size}${food.serving_unit}`;
        } else {
          const m = measures[parseInt(val)];
          scale = unitScale(m.gramWeight, food.serving_size);
          perLabel.textContent = `Per ${m.label} (${m.gramWeight}g)`;
        }
        updatePerUnit();
        updateTotal();
      });
    }

    on(servingsInput, 'input', updateTotal);
    on(find('serv-minus'), 'click', () => {
      servingsInput.value = String(Math.max(1, (parseFloat(servingsInput.value) || 1) - 1));
      updateTotal();
    });
    on(find('serv-plus'), 'click', () => {
      servingsInput.value = String((parseFloat(servingsInput.value) || 1) + 1);
      updateTotal();
    });

    on(find('add-food-btn'), 'click', async () => {
      const qty = parseFloat(servingsInput.value) || 1;
      const effectiveServings = qty * scale;
      const btn = find('add-food-btn') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Adding...';

      // Determine the unit label and scale if a non-default measure was selected
      let unitLabel: string | undefined;
      let savedUnitScale: number | undefined;
      if (unitSelect && unitSelect.value !== 'default') {
        const m = measures[parseInt(unitSelect.value)];
        unitLabel = m.label;
        savedUnitScale = scale;
      }

      try {
        await mealsApi.log({ date, mealType, foodId: food.id, servings: effectiveServings, unitLabel, unitScale: savedUnitScale });
        if (!isLive()) return;
        closeModal();
        navigate('#/');
      } catch {
        if (!isLive()) return;
        btn.disabled = false;
        btn.textContent = 'Failed - Retry';
      }
    });

    modal.classList.remove('hidden');
  }

  function showRecipeAddModal(recipe: Recipe) {
    const modal = find('food-detail-modal')!;
    find('modal-food-name')!.textContent = recipe.name;

    const perServing = recipe.perServing;
    const body = find('modal-body')!;
    body.innerHTML = `
      <div class="modal-macros">
        <div class="modal-macro"><strong>${perServing.calories}</strong> kcal</div>
        <div class="modal-macro"><strong>${perServing.carbsG}g</strong> carbs</div>
        <div class="modal-macro"><strong>${perServing.proteinG}g</strong> protein</div>
        <div class="modal-macro"><strong>${perServing.fatG}g</strong> fat</div>
      </div>
      <p class="text-muted">Per ${recipe.serving_unit || 'serving'} (${recipe.total_servings} total)</p>
      <div class="form-group">
        <label for="servings-input">Servings</label>
        <div class="servings-control">
          <button id="serv-minus" class="btn-icon">-</button>
          <input type="number" id="servings-input" value="1" min="1" step="1" />
          <button id="serv-plus" class="btn-icon">+</button>
        </div>
      </div>
      <div class="modal-total" id="modal-total">
        <span>${perServing.calories} kcal</span>
        <span>${perServing.carbsG}g C</span>
        <span>${perServing.proteinG}g P</span>
        <span>${perServing.fatG}g F</span>
      </div>
      <button id="add-food-btn" class="btn btn-primary btn-block">Add to ${capitalize(mealType)}</button>
    `;

    const servingsInput = find('servings-input') as HTMLInputElement;
    const totalElement = find('modal-total');
    const updateTotal = () => {
      const s = parseFloat(servingsInput.value) || 1;
      // Multiplies the display-rounded perServing the API sends (see #2)
      const total = roundMacros(scaleMacros(perServing, s), 'display');
      totalElement.innerHTML = `
        <span>${total.calories} kcal</span>
        <span>${total.carbsG}g C</span>
        <span>${total.proteinG}g P</span>
        <span>${total.fatG}g F</span>
      `;
    };

    on(servingsInput, 'input', updateTotal);
    on(find('serv-minus'), 'click', () => {
      const v = parseFloat(servingsInput.value) || 1;
      servingsInput.value = String(Math.max(1, v - 1));
      updateTotal();
    });
    on(find('serv-plus'), 'click', () => {
      const v = parseFloat(servingsInput.value) || 1;
      servingsInput.value = String(v + 1);
      updateTotal();
    });

    on(find('add-food-btn'), 'click', async () => {
      const servings = parseFloat(servingsInput.value) || 1;
      const btn = find('add-food-btn') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Adding...';

      try {
        await mealsApi.log({ date, mealType, recipeId: recipe.id, servings });
        if (!isLive()) return;
        closeModal();
        navigate('#/');
      } catch {
        if (!isLive()) return;
        btn.disabled = false;
        btn.textContent = 'Failed - Retry';
      }
    });

    modal.classList.remove('hidden');
  }

  function showQuickAddForm(container: HTMLElement) {
    container.innerHTML = `
      <form id="quick-form" class="quick-form">
        <div class="form-group">
          <label for="quick-name">Description (optional)</label>
          <input type="text" id="quick-name" placeholder="e.g. Handful of almonds" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="quick-carbs">Carbs (g)</label>
            <input type="number" id="quick-carbs" min="0" step="0.1" />
          </div>
          <div class="form-group">
            <label for="quick-protein">Protein (g)</label>
            <input type="number" id="quick-protein" min="0" step="0.1" />
          </div>
          <div class="form-group">
            <label for="quick-fat">Fat (g)</label>
            <input type="number" id="quick-fat" min="0" step="0.1" />
          </div>
        </div>
        <div class="form-group">
          <label for="quick-cal">Calories <span class="form-hint" id="quick-cal-hint">(auto-calculated)</span></label>
          <input type="number" id="quick-cal" min="0" step="1" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Add to ${capitalize(mealType)}</button>
      </form>
    `;

    // Auto-calc calories from macros
    const qCalInput = find('quick-cal') as HTMLInputElement;
    let qCalManual = false;
    on(qCalInput, 'input', () => { qCalManual = true; });
    const autoCalcQ = () => {
      if (qCalManual) return;
      const c = parseFloat((find('quick-carbs') as HTMLInputElement).value) || 0;
      const p = parseFloat((find('quick-protein') as HTMLInputElement).value) || 0;
      const f = parseFloat((find('quick-fat') as HTMLInputElement).value) || 0;
      qCalInput.value = String(caloriesFromMacros(c, p, f));
    };
    ['quick-carbs', 'quick-protein', 'quick-fat'].forEach(id =>
      on(find(id)!, 'input', autoCalcQ)
    );

    on(find('quick-form'), 'submit', async (e) => {
      e.preventDefault();
      const btn = (e.target as HTMLFormElement).querySelector('button')!;
      btn.disabled = true;

      try {
        await mealsApi.quickLog({
          date,
          mealType,
          name: (find('quick-name') as HTMLInputElement).value || undefined,
          calories: parseFloat((find('quick-cal') as HTMLInputElement).value) || 0,
          carbsG: parseFloat((find('quick-carbs') as HTMLInputElement).value) || 0,
          proteinG: parseFloat((find('quick-protein') as HTMLInputElement).value) || 0,
          fatG: parseFloat((find('quick-fat') as HTMLInputElement).value) || 0,
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
        <div class="form-row">
          <div class="form-group">
            <label for="cf-carbs">Carbs (g)</label>
            <input type="number" id="cf-carbs" min="0" step="0.1" />
          </div>
          <div class="form-group">
            <label for="cf-protein">Protein (g)</label>
            <input type="number" id="cf-protein" min="0" step="0.1" />
          </div>
          <div class="form-group">
            <label for="cf-fat">Fat (g)</label>
            <input type="number" id="cf-fat" min="0" step="0.1" />
          </div>
        </div>
        <div class="form-group">
          <label for="cf-cal">Calories <span class="form-hint" id="cf-cal-hint">(auto-calculated)</span></label>
          <input type="number" id="cf-cal" min="0" step="1" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Create & Add to ${capitalize(mealType)}</button>
        <button type="button" id="cancel-create" class="btn btn-outline btn-block">Cancel</button>
      </form>
    `;

    // Auto-calc calories from macros
    const cfCalInput = find('cf-cal') as HTMLInputElement;
    let cfCalManual = false;
    on(cfCalInput, 'input', () => { cfCalManual = true; });
    const autoCalcCf = () => {
      if (cfCalManual) return;
      const c = parseFloat((find('cf-carbs') as HTMLInputElement).value) || 0;
      const p = parseFloat((find('cf-protein') as HTMLInputElement).value) || 0;
      const f = parseFloat((find('cf-fat') as HTMLInputElement).value) || 0;
      cfCalInput.value = String(caloriesFromMacros(c, p, f));
    };
    ['cf-carbs', 'cf-protein', 'cf-fat'].forEach(id =>
      on(find(id)!, 'input', autoCalcCf)
    );

    on(find('cancel-create'), 'click', onCancel);

    on(find('create-food-form'), 'submit', async (e) => {
      e.preventDefault();
      const btn = (e.target as HTMLFormElement).querySelector('button[type=submit]') as HTMLButtonElement;
      btn.disabled = true;

      try {
        const { food } = await foodsApi.create({
          name: (find('cf-name') as HTMLInputElement).value,
          brand: (find('cf-brand') as HTMLInputElement).value || null,
          serving_size: parseFloat((find('cf-serving') as HTMLInputElement).value) || 1,
          serving_unit: (find('cf-unit') as HTMLInputElement).value || 'serving',
          calories: parseFloat((find('cf-cal') as HTMLInputElement).value) || 0,
          carbs_g: parseFloat((find('cf-carbs') as HTMLInputElement).value) || 0,
          protein_g: parseFloat((find('cf-protein') as HTMLInputElement).value) || 0,
          fat_g: parseFloat((find('cf-fat') as HTMLInputElement).value) || 0,
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
    find('food-detail-modal')?.classList.add('hidden');
  }

  on(find('modal-close'), 'click', closeModal);
  session.setActive(true);
  return () => {
    if (disposed) return;
    disposed = true;
    ++tabRevision;
    session.dispose();
    events.abort();
    closeScanner();
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

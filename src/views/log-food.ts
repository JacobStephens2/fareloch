import { foods as foodsApi, meals as mealsApi, recipes as recipesApi } from '../api';
import { navigate, getQueryParams, setCleanup } from '../router';
import { toLocalDateStr } from '../state';
import { createFoodSearchSession, type FoodSearchResult } from '../food-search-session';
import { macroChips, measureCountSuffix, savedMeasureSuffix, sourceLabel, textSpan } from './food-search-text';
import type { Food, ExternalFood, FoodMeasure, Recipe, MealType } from '../types';

export function logFoodView() {
  const params = getQueryParams();
  const mealType = (params.meal || 'snack') as MealType;
  const date = params.date || toLocalDateStr();

  return {
    html: `
      <div class="page log-page">
        <header class="page-header">
          <button id="back-btn" class="btn-icon">&larr;</button>
          <h1>Add to ${capitalize(mealType)}</h1>
        </header>

        <div class="search-bar">
          <input type="search" id="food-search" placeholder="Search foods..." autocomplete="off" />
          <button id="scan-btn" class="btn-icon btn-scan" title="Scan barcode">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/>
              <line x1="7" y1="8" x2="7" y2="16"/><line x1="11" y1="8" x2="11" y2="16"/>
              <line x1="15" y1="8" x2="15" y2="16"/><line x1="19" y1="8" x2="19" y2="16"/>
            </svg>
          </button>
        </div>

        <div id="scanner-container" class="scanner-container hidden">
          <div id="scanner-video"></div>
          <button id="scanner-close" class="btn btn-sm">Close Scanner</button>
        </div>

        <div class="tab-bar">
          <button class="tab active" data-tab="search">Search</button>
          <button class="tab" data-tab="recent">Recent</button>
          <button class="tab" data-tab="custom">My Foods</button>
          <button class="tab" data-tab="recipes">Recipes</button>
          <button class="tab" data-tab="quick">Quick Add</button>
        </div>

        <div id="tab-content" class="tab-content">
          <div class="loading-spinner">Search for a food above</div>
        </div>

        <div class="api-legend">
          <span class="legend-label">Sources:</span>
          <span class="legend-item"><span class="food-source source-fatsecret">FatSecret</span> FatSecret Platform</span>
          <span class="legend-item"><span class="food-source source-usda">USDA</span> USDA FoodData Central</span>
          <span class="legend-item"><span class="food-source source-openfoodfacts">OFF</span> Open Food Facts</span>
        </div>

        <div id="food-detail-modal" class="modal hidden">
          <div class="modal-content">
            <div class="modal-header">
              <h2 id="modal-food-name"></h2>
              <button id="modal-close" class="btn-icon">&times;</button>
            </div>
            <div id="modal-body"></div>
          </div>
        </div>
      </div>
    `,
    init: () => {
      let scannerInstance: any = null;
      const searchInput = document.getElementById('food-search') as HTMLInputElement;
      const content = document.getElementById('tab-content')!;
      let activeTab = 'search';
      let disposed = false;
      let tabRevision = 0;
      const session = createFoodSearchSession({
        search: query => foodsApi.search(query),
        loadDefault: async () => ({ foods: (await foodsApi.recent()).foods, external: [] }),
        onChange: snapshot => {
          searchInput.classList.toggle('searching', snapshot.status === 'debouncing' ||
            (snapshot.status === 'loading' && snapshot.source === 'search'));
          if (snapshot.status === 'inactive') return;
          content.innerHTML = '';
          if (snapshot.status === 'ready') {
            if (snapshot.source === 'default') {
              if (snapshot.result.foods.length) {
                content.innerHTML = '<h4 class="section-label">Recent</h4>';
                renderFoodList(content, snapshot.result.foods, mealType, date, { showSourceLabel: true });
              } else {
                content.innerHTML = '<p class="text-muted">Type to search for foods</p>';
              }
            } else {
              renderSearchResults(content, snapshot.result, mealType, date);
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
      document.getElementById('back-btn')!.addEventListener('click', () => navigate('#/'));

      // Tab switching
      document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          document.querySelector('.tab.active')?.classList.remove('active');
          tab.classList.add('active');
          activeTab = (tab as HTMLElement).dataset.tab || 'search';
          const current = ++tabRevision;
          session.setActive(activeTab === 'search');
          if (activeTab !== 'search') {
            void loadTab(content, activeTab, mealType, date, () => !disposed && current === tabRevision);
          }
        });
      });

      // Search input
      searchInput.addEventListener('input', () => {
        ++tabRevision;
        activeTab = 'search';
        document.querySelector('.tab.active')?.classList.remove('active');
        document.querySelector('[data-tab="search"]')!.classList.add('active');
        session.setQuery(searchInput.value);
        session.setActive(true);
      });

      // Barcode scanner
      document.getElementById('scan-btn')!.addEventListener('click', async () => {
        const container = document.getElementById('scanner-container')!;
        container.classList.toggle('hidden');

        if (!container.classList.contains('hidden') && !scannerInstance) {
          try {
            const { Html5Qrcode } = await import('html5-qrcode');
            scannerInstance = new Html5Qrcode('scanner-video');

            // Use wider scan region for barcodes
            const scanWidth = Math.min(window.innerWidth - 40, 300);

            await scannerInstance.start(
              { facingMode: 'environment' },
              {
                fps: 15,
                qrbox: { width: scanWidth, height: 150 },
                aspectRatio: 1.777778,
              },
              async (decodedText: string) => {
                await scannerInstance.stop();
                scannerInstance = null;
                container.classList.add('hidden');
                // Remove torch button on close
                container.querySelector('.scanner-toolbar')?.remove();
                lookupBarcode(decodedText, mealType, date);
              },
              () => {} // Ignore scan failures
            );

            // Apply continuous autofocus + higher resolution to help lock on barcodes
            try {
              const videoEl = document.querySelector('#scanner-video video') as HTMLVideoElement;
              const track = videoEl?.srcObject instanceof MediaStream
                ? videoEl.srcObject.getVideoTracks()[0]
                : null;
              if (track) {
                const caps = track.getCapabilities() as any;
                const advanced: any[] = [];
                if (caps.focusMode?.includes('continuous')) {
                  advanced.push({ focusMode: 'continuous' });
                }
                if (caps.zoom && caps.zoom.min < caps.zoom.max) {
                  // Slight zoom (1.5x or min viable) helps camera focus at close range
                  const targetZoom = Math.min(1.5, caps.zoom.max);
                  advanced.push({ zoom: targetZoom });
                }
                if (advanced.length > 0) {
                  await track.applyConstraints({ advanced });
                }

                // Add torch toggle if supported
                if (caps.torch) {
                  const toolbar = document.createElement('div');
                  toolbar.className = 'scanner-toolbar';
                  toolbar.innerHTML = `<button id="torch-btn" class="btn btn-sm btn-outline">Flashlight</button>`;
                  container.insertBefore(toolbar, container.querySelector('#scanner-close'));
                  let torchOn = false;
                  document.getElementById('torch-btn')!.addEventListener('click', async () => {
                    torchOn = !torchOn;
                    await track.applyConstraints({ advanced: [{ torch: torchOn } as any] });
                    document.getElementById('torch-btn')!.textContent = torchOn ? 'Flashlight Off' : 'Flashlight';
                  });
                }
              }
            } catch {
              // Focus/torch enhancement failed — scanner still works
            }
          } catch (err) {
            container.innerHTML = `<p class="form-error">Camera access denied or not available.</p>
              <button id="scanner-close" class="btn btn-sm">Close</button>`;
            document.getElementById('scanner-close')?.addEventListener('click', () => container.classList.add('hidden'));
          }
        } else if (scannerInstance) {
          scannerInstance.stop().catch(() => {});
          scannerInstance = null;
        }
      });

      document.getElementById('scanner-close')?.addEventListener('click', () => {
        document.getElementById('scanner-container')!.classList.add('hidden');
        if (scannerInstance) {
          scannerInstance.stop().catch(() => {});
          scannerInstance = null;
        }
      });

      // Modal close
      document.getElementById('modal-close')!.addEventListener('click', closeModal);

      // Cleanup
      setCleanup(() => {
        disposed = true;
        ++tabRevision;
        session.dispose();
        if (scannerInstance) {
          scannerInstance.stop().catch(() => {});
        }
      });

      // Initial load
      session.setActive(true);
    },
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function loadTab(content: HTMLElement, tab: string, mealType: MealType, date: string, isCurrent: () => boolean) {
  if (tab === 'recent') {
    content.innerHTML = '<div class="loading-spinner">Loading...</div>';
    try {
      const { foods } = await foodsApi.recent();
      if (!isCurrent()) return;
      if (foods.length === 0) {
        content.innerHTML = '<p class="text-muted">No recent foods</p>';
        return;
      }
      renderFoodList(content, foods, mealType, date);
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
      if (foods.length > 0) renderFoodList(content, foods, mealType, date, { append: true });
      document.getElementById('create-food-btn')!.addEventListener('click', () => showCreateFoodForm(mealType, date, () => {
        if (isCurrent()) void loadTab(content, tab, mealType, date, isCurrent);
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
      renderRecipeList(content, recipes, mealType, date);
    } catch {
      if (!isCurrent()) return;
      content.innerHTML = '<p class="form-error">Failed to load recipes</p>';
    }
    return;
  }

  if (tab === 'quick') {
    showQuickAddForm(content, mealType, date);
    return;
  }
}

function renderSearchResults(content: HTMLElement, { foods, external }: FoodSearchResult, mealType: MealType, date: string) {
  let html = '';

  if (foods.length > 0) {
    html += '<h4 class="section-label">Saved Foods</h4>';
  }
  content.innerHTML = html;
  if (foods.length > 0) renderFoodList(content, foods, mealType, date, { showSourceLabel: true });

  if (external.length > 0) {
    const extHeader = document.createElement('h4');
    extHeader.className = 'section-label';
    extHeader.textContent = 'External Results';
    content.appendChild(extHeader);
    renderExternalList(content, external, mealType, date);

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

async function lookupBarcode(code: string, mealType: MealType, date: string) {
  const content = document.getElementById('tab-content')!;
  content.innerHTML = '<div class="loading-spinner">Looking up barcode...</div>';

  try {
    const { food } = await foodsApi.barcode(code);
    showAddModal(food, mealType, date);
    const found = document.createElement('p');
    found.className = 'text-muted';
    found.append('Found: ', document.createTextNode(food.name));
    content.replaceChildren(found);
  } catch {
    const missing = document.createElement('p');
    missing.className = 'form-error';
    missing.append('No product found for barcode ', document.createTextNode(code));
    content.replaceChildren(missing);
  }
}

function renderFoodList(container: HTMLElement, foods: Food[], mealType: MealType, date: string, options: { append?: boolean; showSourceLabel?: boolean } = {}) {
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
    item.addEventListener('click', () => showAddModal(food, mealType, date));
    list.appendChild(item);
  }

  if (append) container.appendChild(list);
  else {
    const existing = container.querySelector('.food-list');
    if (existing) existing.replaceWith(list);
    else container.appendChild(list);
  }
}

function renderExternalList(container: HTMLElement, items: ExternalFood[], mealType: MealType, date: string) {
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
    el.addEventListener('click', async () => {
      try {
        const { food } = await foodsApi.saveExternal(item);
        showAddModal(food, mealType, date);
      } catch {
        alert('Failed to save food');
      }
    });
    list.appendChild(el);
  }

  container.appendChild(list);
}

function renderRecipeList(container: HTMLElement, recipeList: Recipe[], mealType: MealType, date: string) {
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
    el.addEventListener('click', () => showRecipeAddModal(recipe, mealType, date));
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

function showAddModal(food: Food, mealType: MealType, date: string) {
  const modal = document.getElementById('food-detail-modal')!;
  document.getElementById('modal-food-name')!.textContent = food.name;

  const measures = parseMeasures(food);
  const hasMeasures = measures.length > 0;

  // Base macros are per food.serving_size (in food.serving_unit, typically grams)
  // When a measure is selected, scale = measure.gramWeight / food.serving_size
  const baseCal = food.calories;
  const baseC = food.carbs_g;
  const baseP = food.protein_g;
  const baseF = food.fat_g;

  const measureOptions = hasMeasures
    ? `<div class="form-group">
        <label for="unit-select">Unit</label>
        <select id="unit-select">
          <option value="default">${food.serving_size}${food.serving_unit} (default)</option>
          ${measures.map((m, i) => `<option value="${i}">${m.label} (${m.gramWeight}g)</option>`).join('')}
        </select>
      </div>`
    : '';

  const body = document.getElementById('modal-body')!;
  body.innerHTML = `
    ${food.brand ? `<p class="food-brand">${food.brand}</p>` : ''}
    <div class="modal-macros" id="modal-per-unit">
      <div class="modal-macro"><strong>${baseCal}</strong> kcal</div>
      <div class="modal-macro"><strong>${baseC}g</strong> carbs</div>
      <div class="modal-macro"><strong>${baseP}g</strong> protein</div>
      <div class="modal-macro"><strong>${baseF}g</strong> fat</div>
    </div>
    <p class="text-muted" id="modal-per-label">Per ${food.serving_size}${food.serving_unit}</p>
    ${measureOptions}
    <div class="form-group">
      <label for="servings-input">Quantity</label>
      <div class="servings-control">
        <button id="serv-minus" class="btn-icon">-</button>
        <input type="number" id="servings-input" value="1" min="1" step="1" />
        <button id="serv-plus" class="btn-icon">+</button>
      </div>
    </div>
    <div class="modal-total" id="modal-total">
      <span>${baseCal} kcal</span>
      <span>${baseC}g C</span>
      <span>${baseP}g P</span>
      <span>${baseF}g F</span>
    </div>
    <button id="add-food-btn" class="btn btn-primary btn-block">Add to ${capitalize(mealType)}</button>
  `;

  let unitScale = 1; // multiplier for selected unit vs default serving

  const servingsInput = document.getElementById('servings-input') as HTMLInputElement;
  const unitSelect = document.getElementById('unit-select') as HTMLSelectElement | null;

  const updateTotal = () => {
    const qty = parseFloat(servingsInput.value) || 1;
    const cal = baseCal * unitScale * qty;
    const c = baseC * unitScale * qty;
    const p = baseP * unitScale * qty;
    const f = baseF * unitScale * qty;
    document.getElementById('modal-total')!.innerHTML = `
      <span>${Math.round(cal)} kcal</span>
      <span>${Math.round(c * 10) / 10}g C</span>
      <span>${Math.round(p * 10) / 10}g P</span>
      <span>${Math.round(f * 10) / 10}g F</span>
    `;
  };

  const updatePerUnit = () => {
    const cal = Math.round(baseCal * unitScale);
    const c = Math.round(baseC * unitScale * 10) / 10;
    const p = Math.round(baseP * unitScale * 10) / 10;
    const f = Math.round(baseF * unitScale * 10) / 10;
    document.getElementById('modal-per-unit')!.innerHTML = `
      <div class="modal-macro"><strong>${cal}</strong> kcal</div>
      <div class="modal-macro"><strong>${c}g</strong> carbs</div>
      <div class="modal-macro"><strong>${p}g</strong> protein</div>
      <div class="modal-macro"><strong>${f}g</strong> fat</div>
    `;
  };

  if (unitSelect) {
    unitSelect.addEventListener('change', () => {
      const val = unitSelect.value;
      if (val === 'default') {
        unitScale = 1;
        document.getElementById('modal-per-label')!.textContent = `Per ${food.serving_size}${food.serving_unit}`;
      } else {
        const m = measures[parseInt(val)];
        unitScale = m.gramWeight / food.serving_size;
        document.getElementById('modal-per-label')!.textContent = `Per ${m.label} (${m.gramWeight}g)`;
      }
      updatePerUnit();
      updateTotal();
    });
  }

  servingsInput.addEventListener('input', updateTotal);
  document.getElementById('serv-minus')!.addEventListener('click', () => {
    servingsInput.value = String(Math.max(1, (parseFloat(servingsInput.value) || 1) - 1));
    updateTotal();
  });
  document.getElementById('serv-plus')!.addEventListener('click', () => {
    servingsInput.value = String((parseFloat(servingsInput.value) || 1) + 1);
    updateTotal();
  });

  document.getElementById('add-food-btn')!.addEventListener('click', async () => {
    const qty = parseFloat(servingsInput.value) || 1;
    const effectiveServings = qty * unitScale;
    const btn = document.getElementById('add-food-btn') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Adding...';

    // Determine the unit label and scale if a non-default measure was selected
    let unitLabel: string | undefined;
    let savedUnitScale: number | undefined;
    if (unitSelect && unitSelect.value !== 'default') {
      const m = measures[parseInt(unitSelect.value)];
      unitLabel = m.label;
      savedUnitScale = unitScale;
    }

    try {
      await mealsApi.log({ date, mealType, foodId: food.id, servings: effectiveServings, unitLabel, unitScale: savedUnitScale });
      closeModal();
      navigate('#/');
    } catch {
      btn.disabled = false;
      btn.textContent = 'Failed - Retry';
    }
  });

  modal.classList.remove('hidden');
}

function showRecipeAddModal(recipe: Recipe, mealType: MealType, date: string) {
  const modal = document.getElementById('food-detail-modal')!;
  document.getElementById('modal-food-name')!.textContent = recipe.name;

  const ps = recipe.perServing;
  const body = document.getElementById('modal-body')!;
  body.innerHTML = `
    <div class="modal-macros">
      <div class="modal-macro"><strong>${ps.calories}</strong> kcal</div>
      <div class="modal-macro"><strong>${ps.carbsG}g</strong> carbs</div>
      <div class="modal-macro"><strong>${ps.proteinG}g</strong> protein</div>
      <div class="modal-macro"><strong>${ps.fatG}g</strong> fat</div>
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
      <span>${ps.calories} kcal</span>
      <span>${ps.carbsG}g C</span>
      <span>${ps.proteinG}g P</span>
      <span>${ps.fatG}g F</span>
    </div>
    <button id="add-food-btn" class="btn btn-primary btn-block">Add to ${capitalize(mealType)}</button>
  `;

  const servingsInput = document.getElementById('servings-input') as HTMLInputElement;
  const updateTotal = () => {
    const s = parseFloat(servingsInput.value) || 1;
    document.getElementById('modal-total')!.innerHTML = `
      <span>${Math.round(ps.calories * s)} kcal</span>
      <span>${Math.round(ps.carbsG * s * 10) / 10}g C</span>
      <span>${Math.round(ps.proteinG * s * 10) / 10}g P</span>
      <span>${Math.round(ps.fatG * s * 10) / 10}g F</span>
    `;
  };

  servingsInput.addEventListener('input', updateTotal);
  document.getElementById('serv-minus')!.addEventListener('click', () => {
    const v = parseFloat(servingsInput.value) || 1;
    servingsInput.value = String(Math.max(1, v - 1));
    updateTotal();
  });
  document.getElementById('serv-plus')!.addEventListener('click', () => {
    const v = parseFloat(servingsInput.value) || 1;
    servingsInput.value = String(v + 1);
    updateTotal();
  });

  document.getElementById('add-food-btn')!.addEventListener('click', async () => {
    const servings = parseFloat(servingsInput.value) || 1;
    const btn = document.getElementById('add-food-btn') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
      await mealsApi.log({ date, mealType, recipeId: recipe.id, servings });
      closeModal();
      navigate('#/');
    } catch {
      btn.disabled = false;
      btn.textContent = 'Failed - Retry';
    }
  });

  modal.classList.remove('hidden');
}

function showQuickAddForm(container: HTMLElement, mealType: MealType, date: string) {
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
  const qCalInput = document.getElementById('quick-cal') as HTMLInputElement;
  let qCalManual = false;
  qCalInput.addEventListener('input', () => { qCalManual = true; });
  const autoCalcQ = () => {
    if (qCalManual) return;
    const c = parseFloat((document.getElementById('quick-carbs') as HTMLInputElement).value) || 0;
    const p = parseFloat((document.getElementById('quick-protein') as HTMLInputElement).value) || 0;
    const f = parseFloat((document.getElementById('quick-fat') as HTMLInputElement).value) || 0;
    qCalInput.value = String(Math.round(c * 4 + p * 4 + f * 9));
  };
  ['quick-carbs', 'quick-protein', 'quick-fat'].forEach(id =>
    document.getElementById(id)!.addEventListener('input', autoCalcQ)
  );

  document.getElementById('quick-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = (e.target as HTMLFormElement).querySelector('button')!;
    btn.disabled = true;

    try {
      await mealsApi.quickLog({
        date,
        mealType,
        name: (document.getElementById('quick-name') as HTMLInputElement).value || undefined,
        calories: parseFloat((document.getElementById('quick-cal') as HTMLInputElement).value) || 0,
        carbsG: parseFloat((document.getElementById('quick-carbs') as HTMLInputElement).value) || 0,
        proteinG: parseFloat((document.getElementById('quick-protein') as HTMLInputElement).value) || 0,
        fatG: parseFloat((document.getElementById('quick-fat') as HTMLInputElement).value) || 0,
      });
      navigate('#/');
    } catch {
      btn.disabled = false;
      btn.textContent = 'Failed - Retry';
    }
  });
}

function showCreateFoodForm(mealType: MealType, date: string, onCancel: () => void) {
  const content = document.getElementById('tab-content')!;
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
  const cfCalInput = document.getElementById('cf-cal') as HTMLInputElement;
  let cfCalManual = false;
  cfCalInput.addEventListener('input', () => { cfCalManual = true; });
  const autoCalcCf = () => {
    if (cfCalManual) return;
    const c = parseFloat((document.getElementById('cf-carbs') as HTMLInputElement).value) || 0;
    const p = parseFloat((document.getElementById('cf-protein') as HTMLInputElement).value) || 0;
    const f = parseFloat((document.getElementById('cf-fat') as HTMLInputElement).value) || 0;
    cfCalInput.value = String(Math.round(c * 4 + p * 4 + f * 9));
  };
  ['cf-carbs', 'cf-protein', 'cf-fat'].forEach(id =>
    document.getElementById(id)!.addEventListener('input', autoCalcCf)
  );

  document.getElementById('cancel-create')!.addEventListener('click', onCancel);

  document.getElementById('create-food-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = (e.target as HTMLFormElement).querySelector('button[type=submit]') as HTMLButtonElement;
    btn.disabled = true;

    try {
      const { food } = await foodsApi.create({
        name: (document.getElementById('cf-name') as HTMLInputElement).value,
        brand: (document.getElementById('cf-brand') as HTMLInputElement).value || null,
        serving_size: parseFloat((document.getElementById('cf-serving') as HTMLInputElement).value) || 1,
        serving_unit: (document.getElementById('cf-unit') as HTMLInputElement).value || 'serving',
        calories: parseFloat((document.getElementById('cf-cal') as HTMLInputElement).value) || 0,
        carbs_g: parseFloat((document.getElementById('cf-carbs') as HTMLInputElement).value) || 0,
        protein_g: parseFloat((document.getElementById('cf-protein') as HTMLInputElement).value) || 0,
        fat_g: parseFloat((document.getElementById('cf-fat') as HTMLInputElement).value) || 0,
      } as any);

      showAddModal(food, mealType, date);
    } catch {
      btn.disabled = false;
      btn.textContent = 'Failed - Retry';
    }
  });
}

function closeModal() {
  document.getElementById('food-detail-modal')?.classList.add('hidden');
}

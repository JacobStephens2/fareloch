import { foods as foodsApi, meals as mealsApi, recipes as recipesApi } from '../api';
import { navigate } from '../router';
import { mountFoodSearch, mountSavedFoodList } from '../food-search-session';
import { mountFoodQuantitySelection } from './food-quantity-selection';
import { mountMacrosEntry } from './macros-entry';
import { mountRecipeList } from './recipe-list-session';
import type { Food, Recipe, MealType } from '../types';
import { scaleMacros, roundMacros } from '../../server/src/nutrition';

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
  let quantitySelection: ReturnType<typeof mountFoodQuantitySelection> | undefined;
  let macrosEntry: ReturnType<typeof mountMacrosEntry> | undefined;
  let disposeRecipeList: (() => void) | undefined;
  let disposeSavedFoodList: (() => void) | undefined;
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
      // html5-qrcode 2.3.8 applies its aspectRatio option before attaching srcObject.
      // Apply the preference after startup so a rejected constraint leaves owned tracks reachable.
      try { await cameraTrack.applyConstraints({ aspectRatio: 1.777778 }); } catch { /* Optional camera preference. */ }
      if (!validAttempt(attempt) || attempt.consumed) return;
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
          { fps: 15, qrbox: { width: Math.min(window.innerWidth - 40, 300), height: 150 } },
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
      // A later opening owns the controls, but does not cancel an already accepted barcode.
      if (isLive() && !attempt.cancelled && attempt.code !== undefined) void lookupBarcode(attempt.code);
      if (cameraAttempt === attempt) {
        if (isLive()) scannerContainer.querySelector('.scanner-toolbar')?.remove();
        cameraAttempt = undefined;
      }
    });
  }

  on(find('scan-btn'), 'click', openScanner);
  on(find('scanner-close'), 'click', closeScanner);

  const content = find('tab-content')!;
  let activeTab = 'search';
  let tabRevision = 0;
  const session = mountFoodSearch(root, {
    kind: 'meal',
    foods: foodsApi,
    onSelect: showAddModal,
    onQueryInput: () => {
      disposeRecipeList?.();
      disposeSavedFoodList?.();
      ++tabRevision;
      activeTab = 'search';
      root.querySelector('.tab.active')?.classList.remove('active');
      root.querySelector('[data-tab="search"]')!.classList.add('active');
      session.setActive(true);
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
      disposeRecipeList?.();
      disposeSavedFoodList?.();
      session.setActive(activeTab === 'search');
      if (activeTab === 'recipes') {
        const host = document.createElement('div');
        host.className = 'food-list';
        content.replaceChildren(host);
        disposeRecipeList = mountRecipeList(host, {
          kind: 'meal', read: recipesApi.list, onSelect: showRecipeAddModal,
        });
      } else if (activeTab === 'recent' || activeTab === 'custom') {
        showSavedFoodList(activeTab, current);
      } else if (activeTab === 'quick') showQuickAddForm(content);
    });
  });

  function showSavedFoodList(kind: 'recent' | 'custom', current: number) {
    disposeSavedFoodList?.();
    const host = document.createElement('div');
    content.replaceChildren(host);
    disposeSavedFoodList = mountSavedFoodList(host, kind === 'recent'
      ? { kind, read: foodsApi.recent, onSelect: showAddModal }
      : { kind, read: foodsApi.custom, onSelect: showAddModal, onCreate: () => showCreateFoodForm(() => {
        if (isLive() && current === tabRevision) showSavedFoodList(kind, current);
      }) });
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

  function showAddModal(food: Food) {
    const modal = find('food-detail-modal')!;
    find('modal-food-name')!.textContent = food.name;
    quantitySelection?.dispose();
    const body = find('modal-body')!;
    body.innerHTML = `
      <div id="food-quantity"></div>
      <button id="add-food-btn" class="btn btn-primary btn-block">Add to ${capitalize(mealType)}</button>
    `;
    const selection = mountFoodQuantitySelection(find('food-quantity'), food, { kind: 'meal' });
    quantitySelection = selection;
    on(find('add-food-btn'), 'click', async () => {
      const amount = selection.read();
      if (!amount) return;
      const btn = find('add-food-btn') as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Adding...';
      try {
        await mealsApi.log({ date, mealType, foodId: food.id, servings: amount.servings, unitLabel: amount.unitLabel, unitScale: amount.unitScale });
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
    quantitySelection?.dispose();
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
        <div id="quick-macros"></div>
        <button type="submit" class="btn btn-primary btn-block">Add to ${capitalize(mealType)}</button>
      </form>
    `;

    macrosEntry?.dispose();
    const entry = mountMacrosEntry(find('quick-macros'), 'quick');
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
    const entry = mountMacrosEntry(find('cf-macros'), 'custom');
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
    find('food-detail-modal')?.classList.add('hidden');
  }

  on(find('modal-close'), 'click', closeModal);
  session.setActive(true);
  return () => {
    if (disposed) return;
    disposed = true;
    disposeRecipeList?.();
    disposeSavedFoodList?.();
    macrosEntry?.dispose();
    quantitySelection?.dispose();
    ++tabRevision;
    session.dispose();
    events.abort();
    closeScanner();
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

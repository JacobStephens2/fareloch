import { getQueryParams, setCleanup } from '../router';
import { toLocalDateStr } from '../state';
import type { MealType } from '../types';
import { mountLogFood } from './log-food-session';

export function logFoodView() {
  const params = getQueryParams();
  const mealType = acceptedMealType(params.meal);
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
      const root = document.querySelector<HTMLElement>('.log-page')!;
      setCleanup(mountLogFood(root, date, mealType));
    },
  };
}

function acceptedMealType(value: string | undefined): MealType {
  if (value === 'breakfast' || value === 'lunch' || value === 'dinner' || value === 'snack') return value;
  return 'snack';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

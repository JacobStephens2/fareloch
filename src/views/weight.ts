import { todayStr } from '../state';
import { setCleanup } from '../router';
import { mountWeight } from './weight-session';

export function weightView() {
  return {
    html: `
      <div class="page">
        <header class="page-header">
          <h1>Weight</h1>
        </header>

        <form id="weight-form" class="weight-form">
          <div class="weight-form-row">
            <div class="form-group" style="flex:1">
              <label for="weight-date">Date</label>
              <input type="date" id="weight-date" value="${todayStr()}" />
            </div>
            <div class="form-group" style="flex:1">
              <label for="weight-time">Time</label>
              <input type="time" id="weight-time" value="${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}" />
            </div>
          </div>
          <div class="form-group">
            <label for="weight-lbs">Weight (lbs)</label>
            <input type="number" id="weight-lbs" step="0.1" min="50" max="500" required />
          </div>
          <div class="form-group">
            <label for="weight-waist">Waist (in) <span class="text-muted">(optional)</span></label>
            <input type="number" id="weight-waist" step="0.1" min="20" max="60" aria-describedby="weight-waist-hint" />
            <p id="weight-waist-hint" class="form-hint">Measure around your bare-skin navel.</p>
          </div>
          <button type="submit" class="btn btn-primary btn-block">Log Weight</button>
        </form>

        <form id="waist-ceiling-form" class="weight-form">
          <h3>Waist-Thermostat</h3>
          <div class="form-group">
            <label for="waist-ceiling">Waist ceiling (in) <span class="text-muted">(optional)</span></label>
            <input type="number" id="waist-ceiling" step="0.01" min="20" max="60" aria-describedby="waist-ceiling-hint" />
            <p id="waist-ceiling-hint" class="form-hint">Compare your latest navel waist with your ceiling. Clear and save to disable.</p>
          </div>
          <button type="submit" class="btn btn-primary btn-block">Save Ceiling</button>
          <p id="waist-ceiling-message" class="form-hint" role="status"></p>
        </form>

        <p id="waist-summary" class="waist-summary" role="status" hidden></p>
        <div id="weight-trend-summary" class="weight-trend-summary" role="status">
          <dl class="weight-trend-values">
            <div>
              <dt>7-Day Trend</dt>
              <dd id="weight-trend-value">Loading...</dd>
            </div>
            <div>
              <dt>Weekly Change</dt>
              <dd id="weight-weekly-change">Loading...</dd>
            </div>
          </dl>
          <p id="weight-trend-as-of" class="form-hint"></p>
        </div>
        <div class="chart-container">
          <canvas id="weight-chart"></canvas>
        </div>

        <div id="weight-history" class="weight-history">
          <div class="loading-spinner">Loading...</div>
        </div>
      </div>
    `,
    init: () => {
      const root = document.getElementById('weight-form')!.closest<HTMLElement>('.page')!;
      setCleanup(mountWeight(root));
    },
  };
}

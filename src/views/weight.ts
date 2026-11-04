import { auth, weight as weightApi } from '../api';
import { todayStr } from '../state';
import type { WeightLog } from '../types';
import { calculateWeightTrend } from '../../server/src/weight-trend';
import { Chart, LineController, LineElement, PointElement, LinearScale, Tooltip, Filler, Legend } from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Filler, Legend);

let chartInstance: Chart | null = null;

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
      document.getElementById('weight-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const date = (document.getElementById('weight-date') as HTMLInputElement).value;
        const time = (document.getElementById('weight-time') as HTMLInputElement).value;
        const lbs = parseFloat((document.getElementById('weight-lbs') as HTMLInputElement).value);
        const waistInput = document.getElementById('weight-waist') as HTMLInputElement;
        const waistInches = waistInput.value === '' ? null : waistInput.valueAsNumber;
        if (!date || !lbs) return;

        const btn = (e.target as HTMLFormElement).querySelector('button') as HTMLButtonElement;
        btn.disabled = true;
        try {
          await weightApi.log({ date, weightLbs: lbs, time, waistInches });
          (document.getElementById('weight-lbs') as HTMLInputElement).value = '';
          waistInput.value = '';
          await loadWeightData();
        } catch {
          alert('Failed to log weight');
        }
        btn.disabled = false;
      });

      document.getElementById('waist-ceiling-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('waist-ceiling') as HTMLInputElement;
        const targetWaistInches = input.value === '' ? null : input.valueAsNumber;
        const button = (e.target as HTMLFormElement).querySelector('button')!;
        const message = document.getElementById('waist-ceiling-message')!;
        button.disabled = true;
        try {
          await auth.updateProfile({ targetWaistInches });
          await loadWeightData();
          message.textContent = targetWaistInches == null ? 'Ceiling disabled.' : 'Ceiling saved.';
        } catch {
          message.textContent = 'Failed to save waist ceiling.';
        }
        button.disabled = false;
      });

      loadWeightData();
    },
  };
}

async function loadWeightData() {
  try {
    const [{ logs }, { user }] = await Promise.all([weightApi.list(90), auth.me()]);
    const ceiling = document.getElementById('waist-ceiling') as HTMLInputElement | null;
    if (ceiling) ceiling.value = user.targetWaistInches?.toString() ?? '';
    renderChart(logs, user.targetWaistInches);
    renderHistory(logs);
  } catch {
    const container = document.getElementById('weight-history');
    if (container) container.innerHTML = '<p class="form-error">Failed to load weight data</p>';
  }
}

function renderChart(logs: WeightLog[], targetWaistInches: number | null) {
  const canvas = document.getElementById('weight-chart') as HTMLCanvasElement;
  if (!canvas) return;

  // Sort chronologically
  const sorted = [...logs].sort((a, b) => {
    const cmp = a.date.localeCompare(b.date);
    if (cmp !== 0) return cmp;
    return (a.time || '').localeCompare(b.time || '');
  });
  renderWaistSummary(sorted, targetWaistInches);
  const trend = calculateWeightTrend(sorted);
  const trendValue = document.getElementById('weight-trend-value');
  const weeklyChange = document.getElementById('weight-weekly-change');
  const asOf = document.getElementById('weight-trend-as-of');
  if (trendValue) trendValue.textContent = trend.currentMeanLbs == null ? 'No logs yet' : `${trend.currentMeanLbs.toFixed(1)} lbs`;
  if (weeklyChange) {
    const delta = trend.weeklyChangeLbs;
    weeklyChange.textContent = delta == null ? 'Need 7+ days of logs' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)} lbs/wk`;
  }
  if (asOf) asOf.textContent = sorted.length ? `As of ${sorted[sorted.length - 1].date}` : '';

  // Plot entered calendar dates/times in UTC so timezone offsets cannot shift
  // dates, and use a linear axis so missing days retain their actual spacing.
  const data = sorted.map((log) => ({
    x: Date.parse(`${log.date}T${log.time || '12:00'}Z`),
    y: log.weight_lbs,
  }));

  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Weight (lbs)',
          data,
          borderColor: '#10B981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#10B981',
          tension: 0.3,
          fill: true,
        },
        {
          label: '7-Day Trend (lbs)',
          data: trend.points.map((point) => ({ x: Date.parse(`${point.date}T12:00:00Z`), y: point.weightLbs })),
          borderColor: '#3B82F6',
          borderWidth: 3,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => {
              const point = items[0];
              if (point.parsed.x == null) return '';
              const date = formatChartDate(point.parsed.x);
              const time = point.datasetIndex === 0 ? sorted[point.dataIndex].time : '';
              return time ? `${date} ${time}` : date;
            },
            label: (ctx) => ctx.parsed.y == null ? '' : `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} lbs`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: false,
          ticks: {
            callback: (val) => `${val} lbs`,
          },
        },
        x: {
          type: 'linear',
          ticks: {
            maxTicksLimit: 8,
            callback: (value) => formatChartDate(Number(value)),
          },
        },
      },
    },
  });
}

function formatChartDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

function renderWaistSummary(sorted: WeightLog[], ceiling: number | null) {
  const summary = document.getElementById('waist-summary');
  if (!summary) return;
  const latest = sorted.filter((log) => log.waist_inches != null).pop();
  const aboveCeiling = latest?.waist_inches != null && ceiling != null && latest.waist_inches > ceiling;
  summary.classList.toggle('above-ceiling', aboveCeiling);
  if (latest) {
    const comparison = ceiling == null ? '' : ` Waist-Thermostat: ${aboveCeiling ? 'Above ceiling' : 'At or below ceiling'} (${ceiling}").`;
    summary.textContent = `Latest waist: ${latest.waist_inches}" (${latest.date}${latest.time ? ` ${latest.time}` : ''}).${comparison}`;
  } else {
    summary.textContent = ceiling == null ? '' : `Waist-Thermostat: ceiling ${ceiling}". Log a waist measurement to compare.`;
  }
  summary.hidden = summary.textContent === '';
}

function renderHistory(logs: WeightLog[]) {
  const container = document.getElementById('weight-history');
  if (!container) return;

  if (logs.length === 0) {
    container.innerHTML = '<p class="text-muted">No weight entries yet. Log your first one above!</p>';
    return;
  }

  let html = '<h3>Recent Entries</h3>';
  for (const log of logs.slice(0, 14)) {
    const d = new Date(log.date + 'T12:00:00');
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = log.time ? ` at ${log.time}` : '';
    html += `
      <div class="weight-entry">
        <span class="weight-date">${dateStr}${timeStr}</span>
        <span class="weight-value">${log.weight_lbs} lbs${log.waist_inches != null ? ` <span class="weight-waist">Waist ${log.waist_inches}&quot;</span>` : ''}</span>
        <button class="btn-icon btn-delete-weight" data-id="${log.id}">&times;</button>
      </div>
    `;
  }
  container.innerHTML = html;

  container.querySelectorAll('.btn-delete-weight').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = parseInt((btn as HTMLElement).dataset.id || '0');
      if (id && confirm('Delete this entry?')) {
        try {
          await weightApi.delete(id);
          loadWeightData();
        } catch {
          // Ignore
        }
      }
    });
  });
}

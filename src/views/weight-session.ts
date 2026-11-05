import { auth, weight as weightApi } from '../api';
import type { WeightLog } from '../types';
import { calculateWeightTrend } from '../../server/src/weight-trend';
import { Chart, LineController, LineElement, PointElement, LinearScale, Tooltip, Filler, Legend } from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Filler, Legend);

export function mountWeight(root: HTMLElement): () => void {
  let disposed = false;
  let refreshRevision = 0;
  let chartInstance: Chart | null = null;
  const events = new AbortController();
  const isLive = () => !disposed && root.isConnected;
  const find = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  function on(element: Element, type: string, handler: (event: Event) => void) {
    element.addEventListener(type, event => {
      if (isLive() && root.contains(element)) handler(event);
    }, { signal: events.signal });
  }

  on(find('weight-form'), 'submit', async (e) => {
    e.preventDefault();
    const date = (find('weight-date') as HTMLInputElement).value;
    const time = (find('weight-time') as HTMLInputElement).value;
    const lbs = parseFloat((find('weight-lbs') as HTMLInputElement).value);
    const waistInput = find('weight-waist') as HTMLInputElement;
    const waistInches = waistInput.value === '' ? null : waistInput.valueAsNumber;
    if (!date || !lbs) return;

    const btn = (e.target as HTMLFormElement).querySelector('button') as HTMLButtonElement;
    btn.disabled = true;
    try {
      await weightApi.log({ date, weightLbs: lbs, time, waistInches });
      if (!isLive()) return;
      (find('weight-lbs') as HTMLInputElement).value = '';
      waistInput.value = '';
      await loadWeightData();
    } catch {
      if (isLive()) alert('Failed to log weight');
    } finally {
      if (isLive()) btn.disabled = false;
    }
  });

  on(find('waist-ceiling-form'), 'submit', async (e) => {
    e.preventDefault();
    const input = find('waist-ceiling') as HTMLInputElement;
    const targetWaistInches = input.value === '' ? null : input.valueAsNumber;
    const button = (e.target as HTMLFormElement).querySelector('button')!;
    const message = find('waist-ceiling-message')!;
    button.disabled = true;
    try {
      await auth.updateProfile({ targetWaistInches });
      if (!isLive()) return;
      await loadWeightData();
      if (!isLive()) return;
      message.textContent = targetWaistInches == null ? 'Ceiling disabled.' : 'Ceiling saved.';
    } catch {
      if (isLive()) message.textContent = 'Failed to save waist ceiling.';
    } finally {
      if (isLive()) button.disabled = false;
    }
  });

  void loadWeightData();

  return () => {
    if (disposed) return;
    disposed = true;
    ++refreshRevision;
    events.abort();
    const chart = chartInstance;
    chartInstance = null;
    chart?.destroy();
  };

  async function loadWeightData() {
    if (!isLive()) return;
    const revision = ++refreshRevision;
    try {
      const [{ logs }, { user }] = await Promise.all([weightApi.list(90), auth.me()]);
      if (!isLive() || revision !== refreshRevision) return;
      const ceiling = find('waist-ceiling') as HTMLInputElement | null;
      if (ceiling) ceiling.value = user.targetWaistInches?.toString() ?? '';
      renderChart(logs, user.targetWaistInches);
      renderHistory(logs);
    } catch {
      if (!isLive() || revision !== refreshRevision) return;
      const container = find('weight-history');
      if (container) container.innerHTML = '<p class="form-error">Failed to load weight data</p>';
    }
  }

  function renderChart(logs: WeightLog[], targetWaistInches: number | null) {
    const canvas = find('weight-chart') as HTMLCanvasElement;
    if (!canvas) return;

    // Sort chronologically
    const sorted = [...logs].sort((a, b) => {
      const cmp = a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      return (a.time || '').localeCompare(b.time || '');
    });
    renderWaistSummary(sorted, targetWaistInches);
    const trend = calculateWeightTrend(sorted);
    const trendValue = find('weight-trend-value');
    const weeklyChange = find('weight-weekly-change');
    const asOf = find('weight-trend-as-of');
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
    const summary = find('waist-summary');
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
    const container = find('weight-history');
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
      on(btn, 'click', async () => {
        const id = parseInt((btn as HTMLElement).dataset.id || '0');
        if (id && confirm('Delete this entry?')) {
          try {
            await weightApi.delete(id);
            if (!isLive()) return;
            await loadWeightData();
          } catch {
            // Ignore
          }
        }
      });
    });
  }
}

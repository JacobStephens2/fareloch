import { auth, API_BASE, getToken } from '../api';
import { state, setState } from '../state';
import { navigate } from '../router';
import { isGuestMode, clearGuestData } from '../local-db';
import { getTheme, setTheme, type ThemePref } from '../theme';
import { phaseTargetPresets } from '../../server/src/nutrition';

async function downloadCsv(path: string, filename: string) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function settingsView() {
  const user = state.user!;
  const guest = isGuestMode();
  const phases = [
    { phase: 'lean-gain', label: 'Lean Gain' },
    { phase: 'maintenance', label: 'Maintenance' },
    { phase: 'mini-cut', label: 'Mini-Cut' },
  ] as const;

  const guestBanner = guest
    ? `<div class="settings-section guest-banner">
        <p><strong>You're using guest mode.</strong> Your data is stored on this device only and won't sync across devices.</p>
        <a href="#/register" class="btn btn-primary btn-block">Create an Account</a>
        <a href="#/login" class="btn btn-outline btn-block" style="margin-top:8px">Sign In</a>
      </div>`
    : '';

  const passwordSection = guest
    ? ''
    : `<div class="settings-section">
        <h3>Change Password</h3>
        <form id="password-form">
          <div class="form-group">
            <label for="s-current-pw">Current Password</label>
            <input type="password" id="s-current-pw" autocomplete="current-password" />
          </div>
          <div class="form-group">
            <label for="s-new-pw">New Password</label>
            <input type="password" id="s-new-pw" minlength="8" autocomplete="new-password" />
          </div>
          <div id="pw-msg" class="hidden"></div>
          <button type="submit" class="btn btn-outline btn-block">Change Password</button>
        </form>
      </div>`;

  const exportSection = guest
    ? ''
    : `<div class="settings-section">
        <h3>Export Data</h3>
        <button id="export-meals-btn" class="btn btn-outline btn-block" style="margin-bottom:8px">Download Meal Log (CSV)</button>
        <button id="export-weight-btn" class="btn btn-outline btn-block">Download Weight Log (CSV)</button>
      </div>`;

  const logoutSection = guest
    ? `<div class="settings-section">
        <button id="logout-btn" class="btn btn-danger btn-block">Clear Data & Exit Guest Mode</button>
      </div>`
    : `<div class="settings-section">
        <p class="logout-email">Signed in as <strong>${user.email}</strong></p>
        <button id="logout-btn" class="btn btn-danger btn-block">Log Out</button>
      </div>`;

  const theme = getTheme();

  return {
    html: `
      <div class="page">
        <header class="page-header">
          <h1>Settings</h1>
        </header>

        ${guestBanner}

        <div class="settings-section">
          <h3>Appearance</h3>
          <div class="theme-toggle" role="radiogroup" aria-label="Theme">
            <button type="button" class="theme-option ${theme === 'light' ? 'active' : ''}" data-theme="light" role="radio" aria-checked="${theme === 'light'}">Light</button>
            <button type="button" class="theme-option ${theme === 'dark' ? 'active' : ''}" data-theme="dark" role="radio" aria-checked="${theme === 'dark'}">Dark</button>
            <button type="button" class="theme-option ${theme === 'system' ? 'active' : ''}" data-theme="system" role="radio" aria-checked="${theme === 'system'}">System</button>
          </div>
        </div>

        <div class="settings-section">
          <h3>Profile</h3>
          <form id="profile-form">
            <div class="form-group">
              <label for="s-name">First Name</label>
              <input type="text" id="s-name" value="${user.firstName}" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="s-height-ft">Height (ft)</label>
                <input type="number" id="s-height-ft" value="${Math.floor(user.heightInches / 12)}" min="3" max="8" />
              </div>
              <div class="form-group">
                <label for="s-height-in">Height (in)</label>
                <input type="number" id="s-height-in" value="${user.heightInches % 12}" min="0" max="11" />
              </div>
            </div>
            <div id="profile-msg" class="form-success hidden"></div>
            <button type="submit" class="btn btn-primary btn-block">Save Profile</button>
          </form>
        </div>

        <div class="settings-section">
          <h3>Phase Presets</h3>
          <p class="text-muted" style="margin-bottom:12px">Save rest-day and workout-day targets together using your saved weight (160 lbs if unset).</p>
          <div id="phase-presets" class="phase-presets" role="group" aria-label="Phase Presets">
            ${phases.map(({ phase, label }) => `<button type="button" id="phase-${phase}" class="btn btn-outline">${label}</button>`).join('')}
          </div>
          <div id="phase-presets-msg" class="hidden" role="status"></div>
        </div>

        <div class="settings-section">
          <h3>Daily Targets</h3>
          <p class="text-muted" style="margin-bottom:12px">Used on rest days. Workout-day targets are below.</p>
          <form id="targets-form">
            <div class="form-row">
              <div class="form-group">
                <label for="s-cal">Calories</label>
                <input type="number" id="s-cal" value="${user.targetCalories}" min="500" max="10000" />
              </div>
              <div class="form-group">
                <label for="s-carbs">Carbs (g)</label>
                <input type="number" id="s-carbs" value="${user.targetCarbsG}" min="0" max="1000" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="s-protein">Protein (g)</label>
                <input type="number" id="s-protein" value="${user.targetProteinG}" min="0" max="1000" />
              </div>
              <div class="form-group">
                <label for="s-fat">Fat (g)</label>
                <input type="number" id="s-fat" value="${user.targetFatG}" min="0" max="500" />
              </div>
            </div>
            <div id="targets-msg" class="form-success hidden"></div>
            <button type="submit" class="btn btn-primary btn-block">Save Targets</button>
          </form>
        </div>

        <div class="settings-section">
          <h3>Workout-Day Targets</h3>
          <p class="text-muted" style="margin-bottom:12px">Used when a day is marked as a workout day on the dashboard.</p>
          <form id="workout-targets-form">
            <div class="form-row">
              <div class="form-group">
                <label for="s-wcal">Calories</label>
                <input type="number" id="s-wcal" value="${user.workoutTargetCalories}" min="500" max="10000" />
              </div>
              <div class="form-group">
                <label for="s-wcarbs">Carbs (g)</label>
                <input type="number" id="s-wcarbs" value="${user.workoutTargetCarbsG}" min="0" max="1000" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="s-wprotein">Protein (g)</label>
                <input type="number" id="s-wprotein" value="${user.workoutTargetProteinG}" min="0" max="1000" />
              </div>
              <div class="form-group">
                <label for="s-wfat">Fat (g)</label>
                <input type="number" id="s-wfat" value="${user.workoutTargetFatG}" min="0" max="500" />
              </div>
            </div>
            <div id="workout-targets-msg" class="form-success hidden"></div>
            <button type="submit" class="btn btn-primary btn-block">Save Workout Targets</button>
          </form>
        </div>

        ${passwordSection}
        ${exportSection}
        ${logoutSection}
      </div>
    `,
    init: () => {
      // Theme toggle
      document.querySelectorAll('.theme-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pref = (btn as HTMLElement).dataset.theme as ThemePref;
          setTheme(pref);
          document.querySelectorAll('.theme-option').forEach((b) => {
            const active = (b as HTMLElement).dataset.theme === pref;
            b.classList.toggle('active', active);
            b.setAttribute('aria-checked', String(active));
          });
        });
      });

      // Profile form
      document.getElementById('profile-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const firstName = (document.getElementById('s-name') as HTMLInputElement).value;
        const ft = parseInt((document.getElementById('s-height-ft') as HTMLInputElement).value) || 5;
        const inches = parseInt((document.getElementById('s-height-in') as HTMLInputElement).value) || 0;
        const heightInches = ft * 12 + inches;

        try {
          const { user: updated } = await auth.updateProfile({ firstName, heightInches } as any);
          setState({ user: updated });
          showMsg('profile-msg', 'Profile saved!', 'success');
        } catch (err: any) {
          showMsg('profile-msg', err.message, 'error');
        }
      });

      // Phase presets save both days in one profile update.
      for (const { phase, label } of phases) {
        document.getElementById(`phase-${phase}`)!.addEventListener('click', async () => {
          const { rest, workout } = phaseTargetPresets(state.user!.currentWeightLbs, phase);
          const message = document.getElementById('phase-presets-msg')!;
          const saveButtons = document.querySelectorAll<HTMLButtonElement>('#phase-presets button, #targets-form button, #workout-targets-form button');
          saveButtons.forEach(button => { button.disabled = true; });
          try {
            const { user: updated } = await auth.updateProfile({
              targetCalories: rest.calories,
              targetCarbsG: rest.carbsG,
              targetProteinG: rest.proteinG,
              targetFatG: rest.fatG,
              workoutTargetCalories: workout.calories,
              workoutTargetCarbsG: workout.carbsG,
              workoutTargetProteinG: workout.proteinG,
              workoutTargetFatG: workout.fatG,
            });
            setState({ user: updated });
            if (!message.isConnected) return;
            for (const [id, value] of [
              ['s-cal', updated.targetCalories], ['s-carbs', updated.targetCarbsG],
              ['s-protein', updated.targetProteinG], ['s-fat', updated.targetFatG],
              ['s-wcal', updated.workoutTargetCalories], ['s-wcarbs', updated.workoutTargetCarbsG],
              ['s-wprotein', updated.workoutTargetProteinG], ['s-wfat', updated.workoutTargetFatG],
            ] as const) {
              (document.getElementById(id) as HTMLInputElement).value = String(value);
            }
            showMsg('phase-presets-msg', `${label} targets saved for rest and workout days!`, 'success');
          } catch (err) {
            if (message.isConnected) {
              showMsg('phase-presets-msg', err instanceof Error ? err.message : 'Unable to save phase targets.', 'error');
            }
          } finally {
            saveButtons.forEach(button => { button.disabled = false; });
          }
        });
      }

      // Targets form
      document.getElementById('targets-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const targetCalories = parseInt((document.getElementById('s-cal') as HTMLInputElement).value);
        const targetCarbsG = parseInt((document.getElementById('s-carbs') as HTMLInputElement).value);
        const targetProteinG = parseInt((document.getElementById('s-protein') as HTMLInputElement).value);
        const targetFatG = parseInt((document.getElementById('s-fat') as HTMLInputElement).value);

        try {
          const { user: updated } = await auth.updateProfile({ targetCalories, targetCarbsG, targetProteinG, targetFatG } as any);
          setState({ user: updated });
          showMsg('targets-msg', 'Targets saved!', 'success');
        } catch (err: any) {
          showMsg('targets-msg', err.message, 'error');
        }
      });

      // Workout targets form
      document.getElementById('workout-targets-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const workoutTargetCalories = parseInt((document.getElementById('s-wcal') as HTMLInputElement).value);
        const workoutTargetCarbsG = parseInt((document.getElementById('s-wcarbs') as HTMLInputElement).value);
        const workoutTargetProteinG = parseInt((document.getElementById('s-wprotein') as HTMLInputElement).value);
        const workoutTargetFatG = parseInt((document.getElementById('s-wfat') as HTMLInputElement).value);

        try {
          const { user: updated } = await auth.updateProfile({
            workoutTargetCalories, workoutTargetCarbsG, workoutTargetProteinG, workoutTargetFatG,
          } as any);
          setState({ user: updated });
          showMsg('workout-targets-msg', 'Workout targets saved!', 'success');
        } catch (err: any) {
          showMsg('workout-targets-msg', err.message, 'error');
        }
      });

      // Password form (only for real users)
      if (!guest) {
        document.getElementById('password-form')!.addEventListener('submit', async (e) => {
          e.preventDefault();
          const current = (document.getElementById('s-current-pw') as HTMLInputElement).value;
          const newPw = (document.getElementById('s-new-pw') as HTMLInputElement).value;

          try {
            await auth.changePassword(current, newPw);
            showMsg('pw-msg', 'Password changed!', 'success');
            (document.getElementById('s-current-pw') as HTMLInputElement).value = '';
            (document.getElementById('s-new-pw') as HTMLInputElement).value = '';
          } catch (err: any) {
            showMsg('pw-msg', err.message, 'error');
          }
        });

        // Export buttons
        document.getElementById('export-meals-btn')!.addEventListener('click', async () => {
          try {
            await downloadCsv('/meals/export/csv', 'meals.csv');
          } catch (err: any) {
            alert(err.message);
          }
        });
        document.getElementById('export-weight-btn')!.addEventListener('click', async () => {
          try {
            await downloadCsv('/weight/export/csv', 'weight.csv');
          } catch (err: any) {
            alert(err.message);
          }
        });
      }

      // Logout
      document.getElementById('logout-btn')!.addEventListener('click', async () => {
        if (guest) {
          if (!confirm('This will clear all your guest data. Continue?')) return;
          clearGuestData();
        } else {
          await auth.logout();
        }
        setState({ user: null });
        navigate('#/login');
      });
    },
  };
}

function showMsg(id: string, text: string, type: 'success' | 'error') {
  const el = document.getElementById(id)!;
  el.textContent = text;
  el.className = type === 'success' ? 'form-success' : 'form-error';
  setTimeout(() => el.classList.add('hidden'), 3000);
}

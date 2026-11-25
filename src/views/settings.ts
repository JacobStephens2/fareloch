import { state } from '../state';
import { setCleanup } from '../router';
import { isGuestMode } from '../local-db';
import { getTheme } from '../theme';
import { mountSettingsSession } from './settings-session';

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
      const root = document.getElementById('app')!.querySelector<HTMLElement>('.page')!;
      setCleanup(mountSettingsSession(root, guest));
    },
  };
}

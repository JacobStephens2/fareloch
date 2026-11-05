import { auth } from '../api';
import { setState } from '../state';
import { navigate, getQueryParams, setCleanup } from '../router';
import { setGuestMode, getGuestUser, seedSampleData } from '../local-db';
import { mountPasswordRecovery } from './password-recovery-session';

export function loginView() {
  return {
    html: `
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-logo">
            <img class="logo-icon" src="/logo.svg" alt="Fareloch" />
            <h1>Fareloch</h1>
          </div>
          <form id="login-form">
            <div class="form-group">
              <label for="email">Email</label>
              <input type="email" id="email" name="email" required autocomplete="email" />
            </div>
            <div class="form-group">
              <label for="password">Password</label>
              <input type="password" id="password" name="password" required autocomplete="current-password" />
            </div>
            <div id="login-error" class="form-error hidden"></div>
            <button type="submit" class="btn btn-primary btn-block">Log In</button>
          </form>
          <div class="auth-links">
            <a href="#/forgot-password">Forgot password?</a>
            <a href="#/register">Create account</a>
          </div>
          <div class="auth-divider"><span>or</span></div>
          <button id="guest-btn" class="btn btn-outline btn-block">Continue without an account</button>
          <p class="auth-hint">Your data will be stored on this device only</p>
        </div>
      </div>
    `,
    init: () => {
      const form = document.getElementById('login-form') as HTMLFormElement;
      const errorEl = document.getElementById('login-error')!;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.classList.add('hidden');
        const email = (form.querySelector('#email') as HTMLInputElement).value;
        const password = (form.querySelector('#password') as HTMLInputElement).value;
        const btn = form.querySelector('button')!;
        btn.disabled = true;
        btn.textContent = 'Logging in...';

        try {
          const { user } = await auth.login(email, password);
          setState({ user });
          navigate('#/');
        } catch (err: any) {
          errorEl.textContent = err.message;
          errorEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Log In';
        }
      });

      document.getElementById('guest-btn')!.addEventListener('click', () => {
        setGuestMode(true);
        seedSampleData();
        setState({ user: getGuestUser() });
        navigate('#/');
      });
    },
  };
}

export function registerView() {
  return {
    html: `
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-logo">
            <img class="logo-icon" src="/logo.svg" alt="Fareloch" />
            <h1>Create Account</h1>
          </div>
          <form id="register-form">
            <div class="form-group">
              <label for="firstName">First Name</label>
              <input type="text" id="firstName" name="firstName" required autocomplete="given-name" />
            </div>
            <div class="form-group">
              <label for="email">Email</label>
              <input type="email" id="email" name="email" required autocomplete="email" />
            </div>
            <div class="form-group">
              <label for="password">Password</label>
              <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password" />
              <span class="form-hint">At least 8 characters</span>
            </div>
            <div id="register-error" class="form-error hidden"></div>
            <button type="submit" class="btn btn-primary btn-block">Create Account</button>
          </form>
          <div class="auth-links">
            <a href="#/login">Already have an account? Log in</a>
          </div>
        </div>
      </div>
    `,
    init: () => {
      const form = document.getElementById('register-form') as HTMLFormElement;
      const errorEl = document.getElementById('register-error')!;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.classList.add('hidden');
        const firstName = (form.querySelector('#firstName') as HTMLInputElement).value;
        const email = (form.querySelector('#email') as HTMLInputElement).value;
        const password = (form.querySelector('#password') as HTMLInputElement).value;
        const btn = form.querySelector('button')!;
        btn.disabled = true;

        try {
          const { user } = await auth.register(email, password, firstName);
          setState({ user });
          navigate('#/');
        } catch (err: any) {
          errorEl.textContent = err.message;
          errorEl.classList.remove('hidden');
          btn.disabled = false;
        }
      });
    },
  };
}

export function forgotPasswordView() {
  return {
    html: `
      <div class="auth-container">
        <div class="auth-card">
          <h1>Reset Password</h1>
          <p class="auth-subtitle">Enter your email and we'll send you a reset link.</p>
          <form id="forgot-form">
            <div class="form-group">
              <label for="email">Email</label>
              <input type="email" id="email" name="email" required autocomplete="email" />
            </div>
            <div id="forgot-msg" class="form-success hidden"></div>
            <div id="forgot-error" class="form-error hidden"></div>
            <button type="submit" class="btn btn-primary btn-block">Send Reset Link</button>
          </form>
          <div class="auth-links">
            <a href="#/login">Back to login</a>
          </div>
        </div>
      </div>
    `,
    init: () => {
      const root = document.querySelector<HTMLElement>('#app .auth-container')!;
      setCleanup(mountPasswordRecovery(root, { kind: 'forgot' }));
    },
  };
}

export function resetPasswordView() {
  return {
    html: `
      <div class="auth-container">
        <div class="auth-card">
          <h1>Set New Password</h1>
          <form id="reset-form">
            <div class="form-group">
              <label for="password">New Password</label>
              <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password" />
              <span class="form-hint">At least 8 characters</span>
            </div>
            <div id="reset-msg" class="form-success hidden"></div>
            <div id="reset-error" class="form-error hidden"></div>
            <button type="submit" class="btn btn-primary btn-block">Reset Password</button>
          </form>
          <div class="auth-links">
            <a href="#/login">Back to login</a>
          </div>
        </div>
      </div>
    `,
    init: () => {
      const root = document.querySelector<HTMLElement>('#app .auth-container')!;
      const params = getQueryParams();
      setCleanup(mountPasswordRecovery(root, { kind: 'reset', token: params.token || '' }));
    },
  };
}

export function verifyEmailView() {
  return {
    html: `
      <div class="auth-container">
        <div class="auth-card">
          <h1>Verifying Email...</h1>
          <div id="verify-msg"></div>
        </div>
      </div>
    `,
    init: async () => {
      const params = getQueryParams();
      const msgEl = document.getElementById('verify-msg')!;

      try {
        await auth.verifyEmail(params.token || '');
        msgEl.innerHTML = '<p class="form-success">Email verified! <a href="#/">Go to dashboard</a></p>';
      } catch (err: any) {
        msgEl.innerHTML = `<p class="form-error">${err.message}</p><a href="#/">Go to dashboard</a>`;
      }
    },
  };
}

import { auth } from '../api';
import { navigate } from '../router';

type RecoveryMode = { kind: 'forgot' } | { kind: 'reset'; token: string };

export function mountPasswordRecovery(root: HTMLElement, mode: RecoveryMode): () => void {
  const kind = mode.kind;
  const token = mode.kind === 'reset' ? mode.token : '';
  let disposed = false;
  let pending = false;
  let resetSucceeded = false;
  let redirect: ReturnType<typeof setTimeout> | undefined;
  const events = new AbortController();
  const form = root.querySelector<HTMLFormElement>(`#${kind}-form`)!;
  const input = form.querySelector<HTMLInputElement>(kind === 'forgot' ? '#email' : '#password')!;
  const button = form.querySelector<HTMLButtonElement>('button')!;
  const message = form.querySelector<HTMLElement>(`#${kind}-msg`)!;
  const error = form.querySelector<HTMLElement>(`#${kind}-error`)!;
  const isLive = () => !disposed && root.isConnected && root.contains(form);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!isLive() || event.target !== form || pending || resetSucceeded) return;
    const value = input.value;
    pending = true;
    button.disabled = true;

    try {
      if (kind === 'forgot') await auth.forgotPassword(value);
      else await auth.resetPassword(token, value);
      if (!isLive()) return;
      message.textContent = kind === 'forgot'
        ? 'If that email exists, a reset link has been sent.'
        : 'Password reset! You can now log in.';
      message.classList.remove('hidden');
      if (kind === 'reset') {
        resetSucceeded = true;
        error.classList.add('hidden');
        redirect = setTimeout(() => {
          if (isLive()) navigate('#/login');
        }, 2000);
      }
    } catch (err) {
      if (!isLive()) return;
      error.textContent = err instanceof Error ? err.message
        : kind === 'forgot' ? 'Unable to send reset link.' : 'Unable to reset password.';
      error.classList.remove('hidden');
    } finally {
      if (isLive()) {
        pending = false;
        button.disabled = resetSucceeded;
      }
    }
  }, { signal: events.signal });

  return () => {
    if (disposed) return;
    disposed = true;
    events.abort();
    clearTimeout(redirect);
  };
}

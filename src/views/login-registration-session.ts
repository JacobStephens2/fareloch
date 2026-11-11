import { auth } from '../api';
import { getGuestUser, seedSampleData, setGuestMode } from '../local-db';
import { navigate } from '../router';
import { setState } from '../state';

export function mountLoginRegistration(root: HTMLElement, kind: 'login' | 'register'): () => void {
  let disposed = false;
  let pending = false;
  let completed = false;
  const events = new AbortController();
  const form = root.querySelector<HTMLFormElement>(`#${kind}-form`)!;
  const email = form.querySelector<HTMLInputElement>('#email')!;
  const password = form.querySelector<HTMLInputElement>('#password')!;
  const firstName = form.querySelector<HTMLInputElement>('#firstName');
  const button = form.querySelector<HTMLButtonElement>('button')!;
  const error = form.querySelector<HTMLElement>(`#${kind}-error`)!;
  const guest = root.querySelector<HTMLButtonElement>('#guest-btn');
  const isLive = () => !disposed && !completed && root.isConnected;
  const isFormLive = () => isLive() && root.contains(form);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!isFormLive() || event.target !== form || pending) return;
    const submittedEmail = email.value;
    const submittedPassword = password.value;
    const submittedName = firstName?.value ?? '';
    pending = true;
    error.classList.add('hidden');
    button.disabled = true;
    if (kind === 'login') button.textContent = 'Logging in...';

    try {
      const { user } = kind === 'login'
        ? await auth.login(submittedEmail, submittedPassword)
        : await auth.register(submittedEmail, submittedPassword, submittedName);
      // Accepted authentication publishes its application result even after departure.
      setState({ user });
      if (!isFormLive()) return;
      completed = true;
      navigate('#/');
    } catch (err) {
      if (!isFormLive()) return;
      error.textContent = err instanceof Error ? err.message
        : kind === 'login' ? 'Unable to log in.' : 'Unable to create account.';
      error.classList.remove('hidden');
    } finally {
      if (isFormLive()) {
        pending = false;
        button.disabled = false;
        if (kind === 'login') button.textContent = 'Log In';
      }
    }
  }, { signal: events.signal });

  guest?.addEventListener('click', () => {
    if (!isLive() || !root.contains(guest)) return;
    completed = true;
    setGuestMode(true);
    seedSampleData();
    setState({ user: getGuestUser() });
    navigate('#/');
  }, { signal: events.signal });

  return () => {
    if (disposed) return;
    disposed = true;
    events.abort();
  };
}

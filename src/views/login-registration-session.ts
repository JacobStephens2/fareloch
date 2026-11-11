import { auth } from '../api';
import { getGuestUser, seedSampleData, setGuestMode } from '../local-db';
import { navigate } from '../router';
import { setState } from '../state';
import { createMountedLifetime } from '../mounted-lifetime';

export function mountLoginRegistration(root: HTMLElement, kind: 'login' | 'register'): () => void {
  let pending = false;
  let completed = false;
  const form = root.querySelector<HTMLFormElement>(`#${kind}-form`)!;
  const email = form.querySelector<HTMLInputElement>('#email')!;
  const password = form.querySelector<HTMLInputElement>('#password')!;
  const firstName = form.querySelector<HTMLInputElement>('#firstName');
  const button = form.querySelector<HTMLButtonElement>('button')!;
  const error = form.querySelector<HTMLElement>(`#${kind}-error`)!;
  const guest = root.querySelector<HTMLButtonElement>('#guest-btn');
  const lifetime = createMountedLifetime(root, {
    ownedNodes: [form, email, password, button, error, ...(firstName ? [firstName] : []), ...(guest ? [guest] : [])],
  });
  const isLive = () => lifetime.isLive() && !completed;
  if (!lifetime.isLive()) return lifetime.dispose;

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!isLive() || event.target !== form || pending) return;
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
      if (!isLive()) return;
      completed = true;
      navigate('#/');
    } catch (err) {
      if (!isLive()) return;
      error.textContent = err instanceof Error ? err.message
        : kind === 'login' ? 'Unable to log in.' : 'Unable to create account.';
      error.classList.remove('hidden');
    } finally {
      if (isLive()) {
        pending = false;
        button.disabled = false;
        if (kind === 'login') button.textContent = 'Log In';
      }
    }
  }, { signal: lifetime.signal });

  guest?.addEventListener('click', () => {
    if (!isLive()) return;
    completed = true;
    setGuestMode(true);
    seedSampleData();
    setState({ user: getGuestUser() });
    navigate('#/');
  }, { signal: lifetime.signal });

  return lifetime.dispose;
}

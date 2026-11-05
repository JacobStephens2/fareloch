import { afterEach, expect, it, vi } from 'vitest';
import { loginView } from './auth';
import html from '../../index.html?raw';

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('shows a readable login error when the server returns the app HTML', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  })));
  const view = loginView();
  document.body.innerHTML = view.html;
  view.init();
  document.querySelector<HTMLInputElement>('#email')!.value = 'test@example.invalid';
  document.querySelector<HTMLInputElement>('#password')!.value = 'test-only-password';
  document.querySelector('#login-form')!.dispatchEvent(new Event('submit', { cancelable: true }));

  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#login-form button')!.disabled).toBe(false));
  const error = document.querySelector('#login-error')!;
  expect(error.classList.contains('hidden')).toBe(false);
  expect(error.textContent).toBe('The server returned an unexpected response (HTTP 200). Please try again.');
});

import { afterEach, expect, it, vi } from 'vitest';

const eventSpy = vi.spyOn(window, 'addEventListener');

afterEach(() => {
  for (const [type, listener, options] of eventSpy.mock.calls) {
    window.removeEventListener(type, listener, options);
  }
  eventSpy.mockClear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  document.body.innerHTML = '';
  localStorage.clear();
});

it('removes native service workers and cached bundles before checking authentication', async () => {
  vi.stubGlobal('androidBridge', {});
  vi.stubEnv('PROD', true);
  vi.stubEnv('MODE', 'production');
  const registrations = new Set(['https://localhost/']);
  const cacheNames = new Set(['workbox-precache-v2-https://localhost/', 'api-cache']);
  let finishUnregister!: () => void;
  const unregistering = new Promise<boolean>(resolve => {
    finishUnregister = () => { registrations.clear(); resolve(true); };
  });
  const register = vi.fn();
  vi.stubGlobal('navigator', {
    serviceWorker: { register, getRegistrations: async () => [{ unregister: () => unregistering }] },
  });
  vi.stubGlobal('caches', {
    keys: async () => [...cacheNames],
    delete: async (name: string) => cacheNames.delete(name),
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {} }));
  const requestState: { registrations: string[]; caches: string[] }[] = [];
  const fetchMock = vi.fn().mockImplementation(async () => {
    requestState.push({ registrations: [...registrations], caches: [...cacheNames] });
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
  });
  vi.stubGlobal('fetch', fetchMock);
  document.body.innerHTML = '<div id="app"></div>';

  await import('./main');
  expect(fetchMock).not.toHaveBeenCalled();
  finishUnregister();
  await vi.waitFor(() => expect(document.querySelector('#login-form')).not.toBeNull());
  expect(requestState).toEqual([{ registrations: [], caches: [] }]);
  expect(fetchMock).toHaveBeenCalledWith('https://fareloch.app/api/auth/me', expect.anything());
  expect(register).not.toHaveBeenCalled();
});

it('registers the PWA worker on the production web app without clearing its offline caches', async () => {
  vi.stubEnv('PROD', true);
  vi.stubEnv('MODE', 'production');
  const register = vi.fn().mockResolvedValue({});
  const getRegistrations = vi.fn();
  const keys = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: { register, getRegistrations } });
  vi.stubGlobal('caches', { keys });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {} }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
  document.body.innerHTML = '<div id="app"></div>';

  await import('./main');
  await vi.waitFor(() => expect(document.querySelector('#login-form')).not.toBeNull());

  expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  expect(getRegistrations).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});

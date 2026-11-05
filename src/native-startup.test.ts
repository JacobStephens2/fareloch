import { afterEach, expect, it, vi } from 'vitest';
import { clearNativeWebCaches } from './native-startup';
import { auth, getToken, setToken } from './api';
import { setGuestMode } from './local-db';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

it('supports native platforms without service workers or CacheStorage', async () => {
  vi.stubGlobal('androidBridge', {});
  vi.stubGlobal('navigator', {});
  await expect(clearNativeWebCaches()).resolves.toBeUndefined();
});

it('still clears every cache if service worker access is unavailable', async () => {
  vi.stubGlobal('androidBridge', {});
  vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => { throw new Error('Unavailable'); } } });
  const names = new Set(['workbox-precache-v2-https://localhost/', 'api-cache']);
  vi.stubGlobal('caches', {
    keys: async () => [...names],
    delete: async (name: string) => names.delete(name),
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await clearNativeWebCaches();

  expect([...names]).toEqual([]);
  expect(warn).toHaveBeenCalled();
});

it('preserves the guest profile and login token during native cache cleanup', async () => {
  vi.stubGlobal('androidBridge', {});
  vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => [] } });
  vi.stubGlobal('caches', { keys: async () => ['api-cache'], delete: async () => true });
  setGuestMode(true);
  const saved = await auth.updateProfile({ firstName: 'Guest', currentWeightLbs: 180 });
  setToken('test-token');

  await clearNativeWebCaches();

  expect(await auth.me()).toEqual(saved);
  expect(getToken()).toBe('test-token');
});

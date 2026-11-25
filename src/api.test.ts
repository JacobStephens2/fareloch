import { afterEach, expect, it, vi } from 'vitest';
import { setGuestMode } from './local-db';
import { deferred, externalFood, food } from './test/food-search-fixtures';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

it.each([
  { native: false, override: '', expected: '/api' },
  { native: true, override: '', expected: 'https://fareloch.app/api' },
  { native: false, override: 'https://example.invalid/api', expected: 'https://example.invalid/api' },
  { native: true, override: 'https://example.invalid/api', expected: 'https://example.invalid/api' },
])('resolves the API base with native=$native and override="$override"', async ({ native, override, expected }) => {
  vi.stubEnv('VITE_API_BASE', override);
  vi.stubGlobal('androidBridge', native ? {} : undefined);
  vi.resetModules();
  const { API_BASE } = await import('./api');
  expect(API_BASE).toBe(expected);
});

it.each([200, 502])('rejects an HTML response with HTTP %i through both request paths', async status => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('<!DOCTYPE html><h1>Fallback</h1>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  })));
  const { auth, foods } = await import('./api');
  await expect(auth.login('test@example.invalid', 'test-only-password')).rejects.toThrow(
    `The server returned an unexpected response (HTTP ${status}). Please try again.`,
  );
  setGuestMode(true);
  await expect(foods.barcode('123456789012')).rejects.toThrow(
    `The server returned an unexpected response (HTTP ${status}). Please try again.`,
  );
});

it.each([
  { body: { error: 'Invalid email or password' }, expected: 'Invalid email or password' },
  { body: null, expected: 'Request failed (HTTP 400). Please try again.' },
  { body: { error: { message: 'Internal detail' } }, expected: 'Request failed (HTTP 400). Please try again.' },
])('keeps a readable JSON error through both request paths: $expected', async ({ body, expected }) => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 400 })));
  const { auth, foods } = await import('./api');
  await expect(auth.login('test@example.invalid', 'test-only-password')).rejects.toThrow(expected);
  setGuestMode(true);
  await expect(foods.barcode('123456789012')).rejects.toThrow(expected);
});

it('still stores the native login token from a JSON success response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 1 }, token: 'test-token' }))));
  const { auth, getToken } = await import('./api');
  await expect(auth.login('test@example.invalid', 'test-only-password')).resolves.toEqual({ user: { id: 1 }, token: 'test-token' });
  expect(getToken()).toBe('test-token');
});

it('preserves the auth redirect while optional-auth errors stay on the current page', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401 })));
  const { auth, foods } = await import('./api');
  window.location.hash = '#/log';
  await expect(auth.me()).rejects.toThrow('Not authenticated');
  expect(window.location.hash).toBe('#/login');
  window.location.hash = '#/log';
  setGuestMode(true);
  await expect(foods.barcode('123456789012')).rejects.toThrow('Sign in required');
  expect(window.location.hash).toBe('#/log');
});

it('sends native login to Fareloch when the build has no API override', async () => {
  vi.stubEnv('VITE_API_BASE', '');
  vi.stubGlobal('androidBridge', {});
  vi.resetModules();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 1 } })));
  vi.stubGlobal('fetch', fetchMock);
  const { auth } = await import('./api');

  await auth.login('test@example.invalid', 'test-only-password');

  expect(fetchMock).toHaveBeenCalledWith('https://fareloch.app/api/auth/login', expect.anything());
});

it('keeps saved food usable if the external search fails', async () => {
  const remote = deferred<Response>();
  const banana = food('Banana');
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('savedOnly=true')
    ? Promise.resolve(Response.json({ foods: [banana], external: [] })) : remote.promise));
  const { foods } = await import('./api');
  const matches = deferred<void>();
  const search = foods.search('banana', saved => {
    expect(saved).toEqual([banana]);
    matches.resolve();
  });
  await matches.promise;
  remote.reject(new Error('offline'));
  await expect(search).resolves.toEqual({ foods: [banana], external: [] });
});

it('a late saved response cannot replace completed external results', async () => {
  const saved = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('savedOnly=true')
    ? saved.promise : Promise.resolve(Response.json({ foods: [], external: [externalFood('Banana online')] }))));
  const { foods } = await import('./api');
  const onSaved = vi.fn();
  await expect(foods.search('banana', onSaved)).resolves.toMatchObject({ external: [{ name: 'Banana online' }] });
  saved.resolve(Response.json({ foods: [food('Banana')], external: [] }));
  await saved.promise;
  // Drain delivery through Response.json(), then verify no late publication.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(onSaved).not.toHaveBeenCalled();
});

it.each([true, false])('saved lookup failure preserves external success=%s', async success => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('savedOnly=true') || !success) return Promise.reject(new Error('offline'));
    return Promise.resolve(Response.json({ foods: [], external: [externalFood('Banana online')] }));
  }));
  const { foods } = await import('./api');
  if (success) {
    await expect(foods.search('banana', () => {})).resolves.toMatchObject({ external: [{ name: 'Banana online' }] });
  } else {
    await expect(foods.search('banana', () => {})).rejects.toThrow('offline');
  }
});

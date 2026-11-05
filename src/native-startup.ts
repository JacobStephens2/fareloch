import { Capacitor } from '@capacitor/core';

// WebView storage survives APK upgrades. The native app must use its bundled assets.
export async function clearNativeWebCaches(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const results = await Promise.allSettled([
    (async () => {
      if (!('serviceWorker' in navigator)) return;
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    })(),
    (async () => {
      if (!('caches' in globalThis)) return;
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    })(),
  ]);
  if (results.some(result => result.status === 'rejected')) {
    console.warn('Could not clear all native web caches. Restart the app if it shows an older version.');
  }
}

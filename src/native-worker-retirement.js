// Update endpoint for workers left by older APKs. Native startup never registers it.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    const names = await caches.keys();
    await Promise.all(names.map(name => caches.delete(name)));
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map(client => client.navigate(client.url)));
  })());
});

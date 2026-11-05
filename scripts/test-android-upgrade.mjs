import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { generateSW } from 'workbox-build';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = await mkdtemp(join(tmpdir(), 'fareloch-android-upgrade-'));
let browser;
let server;

try {
  // A legacy shell has no cleanup code and still registers its caching worker.
  const legacy = join(stage, 'legacy');
  await mkdir(legacy);
  await writeFile(join(legacy, 'index.html'), '<!DOCTYPE html><div id="legacy-app">Legacy Fareloch</div><script type="module" src="/legacy.js"></script>');
  await writeFile(join(legacy, 'legacy.js'), "window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { scope: '/' }));");
  await generateSW({
    globDirectory: legacy,
    globPatterns: ['*.html', '*.js'],
    swDest: join(legacy, 'sw.js'),
    navigateFallback: '/index.html',
    skipWaiting: true,
    clientsClaim: true,
  });

  const latest = join(stage, 'android');
  await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    mode: 'android',
    logLevel: 'silent',
    build: { outDir: latest, emptyOutDir: true },
  });

  let assets = legacy;
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = join(assets, pathname === '/' ? 'index.html' : pathname);
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end(await readFile(join(assets, 'index.html')));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chrome' }),
  });
  const context = await browser.newContext();
  await context.addInitScript(() => { window.androidBridge = {}; });
  await context.route('**/*', route => route.request().url().startsWith(origin)
    ? route.continue()
    : route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  let page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(async () => {
    localStorage.setItem('upgrade-sentinel', 'preserved');
    localStorage.setItem('mt_token', 'test-only-token');
    const cache = await caches.open('api-cache');
    await cache.put('/api/old', new Response('{}'));
  });
  const readState = () => page.evaluate(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    caches: await caches.keys(),
    legacy: !!document.querySelector('#legacy-app'),
    login: !!document.querySelector('#login-form'),
    sentinel: localStorage.getItem('upgrade-sentinel'),
    token: localStorage.getItem('mt_token'),
  }));
  const before = await readState();
  assert.equal(before.registrations, 1);
  assert.equal(before.legacy, true);
  assert.equal(before.caches.length, 2);

  // An APK upgrade replaces assets but retains origin storage and registrations.
  await page.close();
  assets = latest;
  page = await context.newPage();
  await page.goto(origin);
  try {
    await page.waitForFunction(() => (
      !document.querySelector('#legacy-app') && !!document.querySelector('#login-form')
    ), undefined, { timeout: 15_000 });
  } catch (error) {
    console.log(JSON.stringify({ before, after: await readState() }, null, 2));
    throw error;
  }
  const after = await readState();
  assert.deepEqual(after, {
    registrations: 0, caches: [], legacy: false, login: true,
    sentinel: 'preserved', token: 'test-only-token',
  });

  await page.close();
  page = await context.newPage();
  await page.goto(origin);
  await page.waitForSelector('#login-form');
  const relaunched = await readState();
  assert.deepEqual(relaunched, after);
  console.log(JSON.stringify({ before, after, relaunched }, null, 2));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(stage, { recursive: true, force: true });
}

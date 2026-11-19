// Service workers provide these globals even though a page does not.
/* global self, caches */

const CACHE_NAME = 'asteroids-game-shell-v1'; // Update this name when the cached shell changes.
const SHELL_FILES = [
  '/',
  '/manifest.webmanifest',
  '/pwa-icon.svg',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/assets/manifest.json',
  '/assets/hero.png',
  '/assets/asteroid.png',
  '/assets/bullets.png',
  '/assets/laser.mp3',
  '/assets/explosion.mp3',
  '/assets/arena.json',
]; // Cache the app shell, install icons, and the assets used by the game.

// Read the production HTML to find Vite's generated JavaScript bundle.
async function cacheShell() {
  const cache = await caches.open(CACHE_NAME); // Open the new version's cache before activation.
  const page = await fetch('/'); // Fetch the current production entry page.
  if (!page.ok) throw new Error('Could not cache the application shell'); // Do not activate an incomplete offline version.
  const html = await page.clone().text(); // Inspect a copy while the original response remains available to cache.
  await cache.put('/', page); // Keep the entry point available when offline.
  const bundlePaths = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((path) => typeof path === 'string' && path.startsWith('/assets/')); // Keep only same-origin built asset URLs.
  await cache.addAll([...new Set([...SHELL_FILES.slice(1), ...bundlePaths])]); // Precache unique core files and the current hashed bundle.
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell()); // Prepare HTML, bundles, icons, and game assets before activation.
  self.skipWaiting(); // Activate the new worker without waiting for old tabs to close.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  ); // Delete stale versions of this app's cache.
  self.clients.claim(); // Control open pages after activation.
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/ws' || url.pathname === '/health' || url.pathname === '/ready' || url.pathname === '/metrics')
    return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/'))); // Load new HTML online and show the shell when offline.
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); // Cache same-origin assets, never API data.
        }
        return response;
      });
    }),
  );
});

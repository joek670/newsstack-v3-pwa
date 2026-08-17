/* News Stack v3 (PWA) service worker.
 *
 * Caches the app shell only. Feed and article responses are never cached here:
 * the worker already caches them at the edge, the archive is in IndexedDB, and
 * caching them twice would make "Refresh now" lie to you.
 *
 * Network-first for the shell so a redeploy is picked up on the next launch,
 * cache as the fallback so the app opens with no signal — the archive is
 * local, so an offline launch is a working app, not an error page.
 */
const CACHE = 'news-stack-v3-shell-1';
const ASSETS = [
  './', './index.html', './app.js', './engine.js', './feeds.js', './config.js',
  './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e =>
  e.waitUntil(
    caches.open(CACHE)
      // One missing icon must not fail the whole install.
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  )
);

self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
);

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Let proxy fetches go straight to the network; they are not app shell.
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});

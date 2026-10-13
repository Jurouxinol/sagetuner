// Network-first so updates show up on the next open; the cache keeps it working
// offline and covers slow connections after a short wait.
const CACHE = 'tuner-v30';
// Only what the app needs to run offline. The large install icons (512px, Apple touch)
// are fetched by the OS once at install time, so keeping them here would just use space.
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/favicon-32.png',
];
const CACHED_PATHS = new Set(ASSETS.map((a) => new URL(a, self.location).pathname));
const NETWORK_WAIT_MS = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Leave everything else (other sites, analytics, large icons) to the browser
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode !== 'navigate' && !CACHED_PATHS.has(url.pathname)) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cachedP = cache.match(req, { ignoreSearch: true })
        .then(async (hit) => hit || (req.mode === 'navigate'
          ? (await cache.match('./')) || cache.match('./index.html')
          : undefined));
      const network = fetch(req).then((res) => {
        // One copy per file: links with ?query suffixes must not pile up extra pages
        if (res.ok) cache.put(req.mode === 'navigate' ? './' : url.pathname, res.clone());
        return res;
      });
      // Prefer the network; fall back to the cache if it fails or takes too long
      const slow = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS)).then(() => cachedP);
      try {
        return (await Promise.race([network, slow])) || (await network);
      } catch {
        return (await cachedP) || Response.error();
      }
    })
  );
});

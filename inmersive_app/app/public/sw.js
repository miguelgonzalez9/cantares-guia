// Cantares service worker — offline app shell + data, runtime-cache map tiles.
const VERSION = 'cantares-v2';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-tiles`;

const SHELL_ASSETS = [
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/game.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'vendor/pmtiles.js',
  'data/zones.geojson',
  'data/trails.geojson',
  'data/waypoints.geojson',
  'data/routes.json',
  'data/species.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Map raster tiles: cache-first, cap the tile cache so a walked area stays offline.
  if (url.hostname.includes('arcgisonline.com')) {
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // Same-origin shell/data: stale-while-revalidate.
  // Serve cache immediately (offline-first), but refresh the cache from the
  // network in the background so app/data updates propagate on the next load.
  // (Plain cache-first would pin the first version forever.)
  if (url.origin === location.origin && e.request.method === 'GET') {
    e.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const cached = await cache.match(e.request);
        const network = fetch(e.request).then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => null);
        return cached || (await network) || cache.match('index.html');
      })
    );
  }
});

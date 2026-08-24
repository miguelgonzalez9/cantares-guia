// Cantares service worker — offline app shell + data, runtime-cache map tiles + fotos.
const VERSION = 'cantares-v77';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-tiles`;
const IMAGES = `${VERSION}-img`;
const IMAGES_MAX = 350;   // tope de fotos en caché (especies + puntos) — evita crecer sin límite

// NÚCLEO: sin esto la app no arranca sin señal. Se precachea de forma atómica —
// si falla, el service worker no se instala y se reintenta en la próxima visita.
const CORE_ASSETS = [
  'index.html',
  'css/style.css',
  'js/app.js',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'data/trails.geojson',
  'data/waypoints.geojson',
  'data/routes.json',
];

// El RESTO se precachea uno por uno y en paralelo, tolerando fallos: antes iba
// todo en un solo addAll y un único timeout (species.json pesa 546 KB) tumbaba
// la instalación entera — en silencio y sin dejar NADA cacheado.
const SHELL_ASSETS = [
  ...CORE_ASSETS,
  'js/game.js',
  'js/cloud.js',
  'data/carbon.json',
  'js/auth-ui.js',
  'js/admin.js',
  'js/guide.js',
  'js/recorder.js',
  'js/sync.js',
  'js/idengine.js',
  'js/archive-intake.js',
  'js/dropbox.js',
  'js/wakelock.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable.png',
  'img/brand/cantares-icon.png',
  'img/brand/cantares-logo.png',
  'img/brand/cantares-logo-white.png',
  'fonts/meroche.otf',
  'vendor/pmtiles.js',
  'data/boundary.geojson',
  'data/zones.geojson',
  'data/trees.geojson',
  'data/species.json',
  'data/species_groups.json',
  'data/reserve_info.json',
  'data/media.json',
  'data/historia.json',
  'data/comercial.json',
];

// Recorta un caché a `max` entradas (FIFO): borra las más viejas.
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
}

// 'no-cache': revalidar contra el servidor al precachear — sin esto, la caché
// HTTP del navegador puede colar archivos viejos en un SW nuevo.
const req = (u) => new Request(u, { cache: 'no-cache' });

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(CORE_ASSETS.map(req));            // atómico: o arranca sin señal, o no hay SW
    const rest = SHELL_ASSETS.filter((u) => !CORE_ASSETS.includes(u));
    const done = await Promise.allSettled(rest.map((u) => c.add(req(u))));   // tolerante
    const failed = done.filter((r) => r.status === 'rejected').length;
    if (failed) console.warn(`[sw] ${failed} archivo(s) no se precachearon; se pedirán a la red`);
    await self.skipWaiting();
  })());
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
  // OJO: cubre AMBOS hosts de Esri — server.arcgisonline.com y
  // wayback.maptiles.arcgis.com (las 3 capas base 2015/2020/2024 vienen del
  // segundo; con el filtro viejo los tiles nunca se cacheaban y el mapa
  // quedaba gris sin señal).
  if (url.hostname.includes('arcgisonline.com') || url.hostname.includes('arcgis.com')) {
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          // ok (CORS) u opaca (no-cors): ambas sirven para re-mostrar el tile offline
          if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // SDK de Supabase (esm.sh): cache-first, para que la sesión y la cola offline
  // funcionen sin señal (la sesión vive en localStorage; los cambios esperan en
  // IndexedDB y se suben al volver el internet).
  if (url.hostname === 'esm.sh') {
    e.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // Fotos curadas (img/…): cache-first con caché propio y tope. Se guardan a
  // medida que se ven; con wifi en la entrada, quedan disponibles en el sendero.
  if (url.origin === location.origin && /\/img\//.test(url.pathname)) {
    e.respondWith(
      caches.open(IMAGES).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          if (res.ok) { cache.put(e.request, res.clone()); trimCache(IMAGES, IMAGES_MAX); }
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
        const res = cached || (await network);
        if (res) return res;
        // El index.html SOLO vale como respuesta para una navegación. Devolverlo
        // para un data/*.json que no se alcanzó a cachear daba un 200 con HTML
        // dentro, y el error que veía el visitante era «Unexpected token '<'»
        // en vez de «este archivo no está descargado».
        if (e.request.mode === 'navigate') return cache.match('index.html');
        return new Response('', { status: 504, statusText: 'sin conexión y sin copia local' });
      })
    );
  }
});

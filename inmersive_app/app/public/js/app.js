// Cantares — Guía interactiva de la reserva
// Minimal-vanilla PWA. Globals `maplibregl` and `pmtiles` come from vendored scripts.

const CONFIG = {
  center: [-75.4503, 5.0818],
  zoom: 15.5,
  maxBounds: [[-75.462, 5.072], [-75.439, 5.092]], // reserve + margin
  proximityMeters: 25,          // trigger a waypoint card within this distance
  reTriggerMeters: 60,          // must leave this radius before it can retrigger
  inatProjectUrl: 'https://www.inaturalist.org/projects/reserva-natural-cantares',
  data: {
    boundary: 'data/zones.geojson',   // currently the reserve boundary (zonificación pendiente)
    trails: 'data/trails.geojson',
    waypoints: 'data/waypoints.geojson',
    routes: 'data/routes.json',
    species: 'data/species.json',
  },
};

const state = {
  map: null,
  routes: [],
  routesById: {},
  species: [],
  waypoints: [],
  activeRoute: null,
  userPos: null,
  watchId: null,
  lastTriggered: {},   // waypointId -> true while user is still within reTrigger radius
};

// ---------- utilities ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function haversine(a, b) { // [lon,lat] -> meters
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad, dLon = (b[0] - a[0]) * toRad;
  const la1 = a[1] * toRad, la2 = b[1] * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// ---------- map ----------
// Resolve as soon as the style is usable, via whichever signal fires first.
// The 'load' event can be delayed indefinitely if raster tiles stall, so we
// also listen to 'styledata' and poll isStyleLoaded() as a fallback.
function onStyleReady(map, cb) {
  let done = false;
  const run = () => {
    if (done) return;
    if (map.isStyleLoaded()) { done = true; clearInterval(iv); cb(); }
  };
  map.on('load', run);
  map.on('styledata', run);
  const iv = setInterval(run, 200);
  setTimeout(() => clearInterval(iv), 10000);
  run();
}

function buildStyle() {
  return {
    version: 8,
    sources: {
      esri: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        maxzoom: 19,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#c9d3c6' } },
      { id: 'esri', type: 'raster', source: 'esri' },
    ],
  };
}

async function initMap() {
  // Load geo data BEFORE creating the map so layers can be added the instant
  // the style is ready (avoids racing the render loop).
  const [boundary, trails, waypointsFC] = await Promise.all([
    loadJSON(CONFIG.data.boundary),
    loadJSON(CONFIG.data.trails),
    loadJSON(CONFIG.data.waypoints),
  ]);
  state.waypoints = waypointsFC.features;

  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(),
    center: CONFIG.center,
    zoom: CONFIG.zoom,
    maxBounds: CONFIG.maxBounds,
    attributionControl: { compact: true },
  });
  state.map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(finish, 11000); // never block the rest of the app if the style stalls
    onStyleReady(map, () => {
      // Reserve boundary
      map.addSource('boundary', { type: 'geojson', data: boundary });
      map.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundary',
        paint: { 'fill-color': '#40916c', 'fill-opacity': 0.10 } });
      map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
        paint: { 'line-color': '#1b4332', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });

      // Trails (casing under line)
      map.addSource('trails', { type: 'geojson', data: trails });
      map.addLayer({ id: 'trails-casing', type: 'line', source: 'trails',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2d6a4f', 'line-width': 6 } });
      map.addLayer({ id: 'trails-line', type: 'line', source: 'trails',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f5f7f4', 'line-width': 4, 'line-opacity': 0.9 } });

      // Waypoints (labels live in the cards, so no glyph dependency = offline-safe)
      map.addSource('waypoints', { type: 'geojson', data: waypointsFC });
      map.addLayer({ id: 'waypoints-pt', type: 'circle', source: 'waypoints',
        paint: { 'circle-radius': 7, 'circle-color': '#e07a1f',
          'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });

      // User location
      map.addSource('user', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'user-halo', type: 'circle', source: 'user',
        paint: { 'circle-radius': 16, 'circle-color': '#2b8cbe', 'circle-opacity': 0.18 } });
      map.addLayer({ id: 'user-dot', type: 'circle', source: 'user',
        paint: { 'circle-radius': 7, 'circle-color': '#2b8cbe', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });

      map.on('click', 'waypoints-pt', (e) => {
        const f = e.features[0];
        showWaypoint(state.waypoints.find((w) => w.properties.id === f.properties.id));
      });
      map.on('mouseenter', 'waypoints-pt', () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', 'waypoints-pt', () => map.getCanvas().style.cursor = '');

      finish();
    });
  });
}

// ---------- routes ----------
function renderRouteBar() {
  const bar = $('#route-bar');
  bar.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'route-chip active';
  all.innerHTML = '<span class="emoji">🗺️</span>Todos';
  all.onclick = () => selectRoute(null);
  bar.appendChild(all);

  state.routes.forEach((r) => {
    const chip = document.createElement('button');
    chip.className = 'route-chip';
    chip.dataset.route = r.id;
    chip.innerHTML = `<span class="emoji">${r.emoji}</span>${r.name.replace('Sendero de ', '').replace('Sendero del ', '').replace('Sendero ', '')}`;
    chip.onclick = () => selectRoute(r.id);
    bar.appendChild(chip);
  });
}

function selectRoute(id) {
  state.activeRoute = id;
  const route = id ? state.routesById[id] : null;

  $$('.route-chip').forEach((c) => {
    const isActive = (id === null && c.textContent.includes('Todos')) || c.dataset.route === id;
    c.classList.toggle('active', isActive);
    c.style.background = (isActive && route) ? route.color : '';
    if (isActive && route) c.style.color = '#fff';
  });

  const map = state.map;
  // Show a waypoint if its themes array contains the active route's theme.
  // Guard on layer presence in case the map style is still loading.
  if (map && map.getLayer && map.getLayer('waypoints-pt')) {
    if (id) {
      map.setFilter('waypoints-pt', ['in', route.theme, ['get', 'themes']]);
      map.setPaintProperty('trails-line', 'line-color', route.color);
    } else {
      map.setFilter('waypoints-pt', null);
      map.setPaintProperty('trails-line', 'line-color', '#f5f7f4');
    }
  }

  const info = $('#route-info');
  if (route) {
    info.classList.remove('hidden');
    info.style.borderLeftColor = route.color;
    info.innerHTML = `<h3>${route.emoji} ${route.name}</h3><p>${route.summary}</p>`;
  } else {
    info.classList.add('hidden');
  }
}

// ---------- waypoint card ----------
const THEME_COLORS = { agua: '#2b8cbe', arboles: '#238b45', aves: '#d94801', restauracion: '#88419d', info: '#5b6b60' };
const THEME_LABEL = { agua: 'Agua', arboles: 'Árboles', aves: 'Aves', restauracion: 'Restauración', info: 'Info' };

function showWaypoint(wp) {
  if (!wp) return;
  const p = wp.properties;
  const badges = (p.themes || []).map((t) =>
    `<span class="badge" style="background:${THEME_COLORS[t] || '#5b6b60'}">${THEME_LABEL[t] || t}</span>`).join('');
  const speciesChips = (p.species_ids || []).map((sid) => {
    const s = state.species.find((x) => x.id === sid);
    if (!s) return '';
    return `<span class="chip" data-species="${sid}">${s.common_name}</span>`;
  }).join('');

  $('#wp-content').innerHTML = `
    <div class="wp-theme-badges">${badges}</div>
    <h2 class="wp-title">${p.title || p.name}</h2>
    ${p.photo ? `<img class="wp-photo" src="${p.photo}" alt="${p.name}">` : ''}
    <p class="wp-desc">${p.description || ''}</p>
    ${speciesChips ? `<div class="wp-species">${speciesChips}</div>` : ''}
    ${p.sample ? '<p class="tiny muted" style="margin-top:10px">Punto de muestra — se reemplaza con el punto real del propietario.</p>' : ''}
  `;
  $('#waypoint-card').classList.remove('hidden');
  $$('#wp-content .chip').forEach((chip) => {
    chip.onclick = () => { switchView('especies'); highlightSpecies(chip.dataset.species); };
  });
}

// ---------- geolocation ----------
function setGps(status, label) {
  const chip = $('#gps-chip');
  chip.className = `gps-chip gps-${status}`;
  $('#gps-label').textContent = label || 'GPS';
}

function toggleTracking() {
  if (state.watchId != null) { stopTracking(); return; }
  if (!('geolocation' in navigator)) { setGps('error', 'Sin GPS'); return; }
  setGps('searching', 'Buscando…');
  $('#locate-btn').classList.add('tracking');
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
}

function stopTracking() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $('#locate-btn').classList.remove('tracking');
  setGps('off', 'GPS');
}

function onPosition(pos) {
  const { longitude, latitude, accuracy } = pos.coords;
  state.userPos = [longitude, latitude];
  setGps('on', `±${Math.round(accuracy)} m`);
  const src = state.map && state.map.getSource('user');
  if (src) src.setData({ type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: state.userPos }, properties: {} }] });
  if (state.map) state.map.easeTo({ center: state.userPos, duration: 600 });
  checkProximity();
}

function onGeoError(err) {
  setGps('error', 'GPS ⚠');
  console.warn('Geolocation error', err.message);
}

function checkProximity() {
  if (!state.userPos) return;
  state.waypoints.forEach((wp) => {
    const id = wp.properties.id;
    // respect active route theme filter
    if (state.activeRoute) {
      const route = state.routesById[state.activeRoute];
      if (!(wp.properties.themes || []).includes(route.theme)) return;
    }
    const d = haversine(state.userPos, wp.geometry.coordinates);
    if (d <= CONFIG.proximityMeters && !state.lastTriggered[id]) {
      state.lastTriggered[id] = true;
      toast(`📍 ${wp.properties.name}`);
      showWaypoint(wp);
    } else if (d > CONFIG.reTriggerMeters && state.lastTriggered[id]) {
      state.lastTriggered[id] = false;
    }
  });
}

let toastTimer = null;
function toast(msg) {
  const t = $('#proximity-toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- species ----------
const GROUP_LABEL = { flora: 'Flora', ave: 'Aves', mamifero: 'Mamíferos' };
let speciesFilter = 'all';

function renderSpeciesFilters() {
  const wrap = $('#species-filters');
  const opts = [['all', 'Todas'], ['flagship', '★ Destacadas'], ['flora', '🌳 Flora'], ['ave', '🐦 Aves'], ['mamifero', '🐾 Mamíferos']];
  wrap.innerHTML = '';
  opts.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.className = 'filter-chip' + (key === speciesFilter ? ' active' : '');
    b.textContent = label;
    b.onclick = () => { speciesFilter = key; renderSpeciesFilters(); renderSpeciesGrid(); };
    wrap.appendChild(b);
  });
}

function filteredSpecies() {
  return state.species.filter((s) => {
    if (speciesFilter === 'all') return true;
    if (speciesFilter === 'flagship') return s.flagship;
    return s.group === speciesFilter;
  });
}

function renderSpeciesGrid(highlightId) {
  const grid = $('#species-grid');
  const list = filteredSpecies();
  $('#species-count').textContent = `${list.length} especies · el inventario crece con cada avistamiento`;
  grid.innerHTML = '';
  list.forEach((s) => {
    const card = document.createElement('div');
    card.className = `species-card ${s.flagship ? 'flagship' : ''} ${s.status === 'possible' ? 'status-possible' : ''}`;
    card.id = `sp-${s.id}`;
    card.innerHTML = `
      ${s.flagship ? '<span class="star">★</span>' : ''}
      <p class="species-common">${s.common_name}</p>
      <p class="species-sci">${s.scientific_name}</p>
      <p class="species-meta">${s.family}${s.status === 'possible' ? ' · posible' : ''}</p>
      <span class="species-group-tag g-${s.group}">${GROUP_LABEL[s.group]}</span>
    `;
    grid.appendChild(card);
  });
  if (highlightId) {
    const el = $(`#sp-${highlightId}`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.outline = '2px solid var(--sun)';
      setTimeout(() => el.style.outline = '', 2000); }
  }
}

function highlightSpecies(id) {
  const s = state.species.find((x) => x.id === id);
  if (!s) return;
  speciesFilter = 'all';
  renderSpeciesFilters();
  renderSpeciesGrid(id);
}

// ---------- navigation ----------
function switchView(name) {
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  $(`#view-${name}`).classList.add('is-active');
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  if (name === 'recorridos' && state.map) setTimeout(() => state.map.resize(), 60);
}

// ---------- restoration: carbon card ----------
async function renderCarbon() {
  try {
    const c = await loadJSON('data/carbon.json');
    const isDemo = /DEMO/i.test(c.note || '');
    $('#carbon-panel').innerHTML = `
      <h2>🌳 Carbono capturado</h2>
      <div class="carbon-figure">${c.co2e_total_t} t <span>CO₂e</span></div>
      <p class="muted">${c.n_trees} árboles clave · IC 95% ${c.co2e_ci_t[0]}–${c.co2e_ci_t[1]} t · biomasa aérea ${(c.agb_total_kg/1000).toFixed(1)} t</p>
      <p class="tiny muted">${c.method}</p>
      ${isDemo ? '<div class="placeholder">Cifras de DEMOSTRACIÓN. Reemplaza <code>inputs/inventory/key_trees.csv</code> y corre <code>data_prep/05_carbon_allometry.R</code>.</div>' : ''}
    `;
  } catch (e) { /* leave the placeholder if carbon.json isn't generated yet */ }
}

// ---------- offline / SW ----------
function renderOfflineStatus() {
  const el = $('#offline-status');
  const online = navigator.onLine;
  el.innerHTML = online
    ? '🟢 En línea. Abre el mapa aquí (wifi) para guardar los tiles y luego funciona sin señal en el sendero.'
    : '⚪ Sin conexión. La app y el contenido guardado siguen disponibles.';
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW', e); }
}

// ---------- init ----------
async function main() {
  // wire tabs
  $$('.tab').forEach((t) => t.onclick = () => switchView(t.dataset.view));
  $('#wp-close').onclick = () => $('#waypoint-card').classList.add('hidden');
  $('#locate-btn').onclick = toggleTracking;
  $('#inat-link').href = CONFIG.inatProjectUrl;
  window.addEventListener('online', renderOfflineStatus);
  window.addEventListener('offline', renderOfflineStatus);

  // load light data (routes + species) first so other tabs work even if map is slow
  const [routesDoc, speciesDoc] = await Promise.all([
    loadJSON(CONFIG.data.routes),
    loadJSON(CONFIG.data.species),
  ]);
  state.routes = routesDoc.routes;
  state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
  state.species = speciesDoc.species;

  renderRouteBar();
  renderSpeciesFilters();
  renderSpeciesGrid();
  renderOfflineStatus();
  renderCarbon();

  // ?nomap skips WebGL map init (fallback for devices without WebGL, and for testing)
  if (!new URLSearchParams(location.search).has('nomap')) {
    await initMap();
    selectRoute(null);
  }
  registerSW();
}

main().catch((e) => { console.error(e); toast('Error cargando la app: ' + e.message); });

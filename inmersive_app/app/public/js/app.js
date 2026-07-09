// Cantares — Guía interactiva de la reserva / Interactive reserve guide
// Minimal-vanilla PWA. Globals `maplibregl` and `pmtiles` come from vendored scripts.

const CONFIG = {
  center: [-75.4503, 5.0818],
  zoom: 15.5,
  maxBounds: [[-75.462, 5.072], [-75.439, 5.092]],
  proximityMeters: 25,
  reTriggerMeters: 60,
  inatProjectUrl: 'https://www.inaturalist.org/projects/reserva-natural-cantares',
  data: {
    boundary: 'data/boundary.geojson',
    zones: 'data/zones.geojson',
    caminos: 'data/caminos.geojson',
    waypoints: 'data/waypoints.geojson',
    routes: 'data/routes.json',
    species: 'data/species.json',
  },
};

const state = {
  map: null, routes: [], routesById: {}, species: [], waypoints: [],
  activeRoute: null, userPos: null, watchId: null, firstFix: false,
  lastTriggered: {}, openWaypointId: null,
};

// ---------- i18n ----------
const I18N = {
  es: {
    subtitle: 'Reserva Natural', tab_recorridos: 'Recorridos', tab_restauracion: 'Restauración',
    tab_especies: 'Especies', tab_info: 'Info', all_routes: 'Todos',
    gps: 'GPS', gps_searching: 'Buscando…', gps_denied: 'Permiso denegado', gps_unavailable: 'Sin señal',
    gps_timeout: 'Sin respuesta', gps_unsupported: 'GPS no disponible', gps_insecure: 'El GPS requiere HTTPS',
    gps_hint_denied: 'Activa el permiso de ubicación para este sitio en el navegador.',
    approx_note: 'Posición aproximada — se reemplaza con el punto GPS real.',
    rest_title: 'Restauración',
    rest_lead: 'De potrero de kikuyo a bosque. La reserva tiene <strong>16,4 ha en restauración</strong>, donde el ganado salió hacia ~2019 y hoy crecen especies nativas.',
    ndvi_h: '🌿 Reverdecimiento (NDVI)', ndvi_p: 'Serie temporal Sentinel-2 2019 → hoy en la zona de restauración vs. la de conservación (control).',
    ndvi_pending: 'Pendiente: correr <code>data_prep/03_ndvi_timeseries.R</code> (requiere Earth Engine).',
    ortho_h: '🛰️ Antes / después (ortofoto)', ortho_p: 'Ortofoto fotogramétrica de la reserva (~4,4 cm/píxel).',
    carbon_h: '🌳 Carbono capturado',
    especies_h: 'Especies', especies_lead: 'Reconoce la fauna y flora de Cantares. Cada avistamiento alimenta el inventario de la reserva.',
    id_plant: 'Identificar planta', id_bird: 'Identificar ave', id_inat: 'Sumar al inventario',
    f_all: 'Todas', f_flagship: '★ Destacadas', f_flora: '🌳 Flora', f_aves: '🐦 Aves', f_mam: '🐾 Mamíferos',
    count_suffix: 'especies · el inventario crece con cada avistamiento', possible: 'posible',
    info_h: 'La Reserva',
    info_lead: 'Reserva Natural de la Sociedad Civil <strong>Cantares</strong> (RNSC 112-20), 31,07 ha en la vereda Las Palomas, ~5 km de Manizales.',
    fact_eco: 'Ecosistema', fact_eco_v: 'Bosque muy húmedo montano bajo, 1.800–3.000 msnm',
    fact_cli: 'Clima', fact_cli_v: '6–12 °C, 1.000–2.000 mm de lluvia al año',
    fact_rest: 'Restauración', fact_rest_v: '16,4 ha · Conservación 10,5 ha',
    fact_water: 'Agua', fact_water_v: 'Quebradas La Peña y La Arenosa → Río Blanco → Río Chinchiná',
    fact_reg: 'Registro', fact_reg_v: 'Parques Nacionales Naturales, Res. 201 de 2021',
    map_illus: 'Mapa ilustrado de senderos', zones_h: 'Zonas de manejo',
    grp_flora: 'Flora', grp_ave: 'Aves', grp_mamifero: 'Mamíferos',
    online: '🟢 En línea. Abre el mapa aquí (wifi) para guardar los tiles y luego funciona sin señal en el sendero.',
    offline: '⚪ Sin conexión. La app y el contenido guardado siguen disponibles.',
    demo_note: 'Cifras de DEMOSTRACIÓN. Reemplaza <code>inputs/inventory/key_trees.csv</code> y corre <code>data_prep/05_carbon_allometry.R</code>.',
    key_trees: 'árboles clave', agb: 'biomasa aérea',
  },
  en: {
    subtitle: 'Nature Reserve', tab_recorridos: 'Trails', tab_restauracion: 'Restoration',
    tab_especies: 'Species', tab_info: 'Info', all_routes: 'All',
    gps: 'GPS', gps_searching: 'Locating…', gps_denied: 'Permission denied', gps_unavailable: 'No signal',
    gps_timeout: 'Timed out', gps_unsupported: 'GPS unavailable', gps_insecure: 'GPS needs HTTPS',
    gps_hint_denied: 'Enable location permission for this site in your browser.',
    approx_note: 'Approximate position — to be replaced by the real GPS point.',
    rest_title: 'Restoration',
    rest_lead: 'From kikuyu pasture to forest. The reserve has <strong>16.4 ha under restoration</strong>, where cattle left around 2019 and native species now grow.',
    ndvi_h: '🌿 Greening (NDVI)', ndvi_p: 'Sentinel-2 time series 2019 → today in the restoration zone vs. the conservation zone (control).',
    ndvi_pending: 'Pending: run <code>data_prep/03_ndvi_timeseries.R</code> (needs Earth Engine).',
    ortho_h: '🛰️ Before / after (orthophoto)', ortho_p: 'Photogrammetric orthophoto of the reserve (~4.4 cm/pixel).',
    carbon_h: '🌳 Carbon captured',
    especies_h: 'Species', especies_lead: 'Get to know the wildlife and plants of Cantares. Every sighting feeds the reserve inventory.',
    id_plant: 'Identify plant', id_bird: 'Identify bird', id_inat: 'Add to inventory',
    f_all: 'All', f_flagship: '★ Flagship', f_flora: '🌳 Plants', f_aves: '🐦 Birds', f_mam: '🐾 Mammals',
    count_suffix: 'species · the inventory grows with every sighting', possible: 'possible',
    info_h: 'The Reserve',
    info_lead: 'Civil Society Nature Reserve <strong>Cantares</strong> (RNSC 112-20), 31.07 ha in vereda Las Palomas, ~5 km from Manizales.',
    fact_eco: 'Ecosystem', fact_eco_v: 'Very humid lower montane forest, 1,800–3,000 masl',
    fact_cli: 'Climate', fact_cli_v: '6–12 °C, 1,000–2,000 mm rain per year',
    fact_rest: 'Restoration', fact_rest_v: '16.4 ha · Conservation 10.5 ha',
    fact_water: 'Water', fact_water_v: 'La Peña & La Arenosa creeks → Río Blanco → Río Chinchiná',
    fact_reg: 'Registry', fact_reg_v: 'National Natural Parks, Resolution 201 of 2021',
    map_illus: 'Illustrated trail map', zones_h: 'Management zones',
    grp_flora: 'Plants', grp_ave: 'Birds', grp_mamifero: 'Mammals',
    online: '🟢 Online. Open the map here (wifi) to cache tiles, then it works with no signal on the trail.',
    offline: '⚪ Offline. The app and cached content are still available.',
    demo_note: 'DEMO figures. Replace <code>inputs/inventory/key_trees.csv</code> and run <code>data_prep/05_carbon_allometry.R</code>.',
    key_trees: 'key trees', agb: 'above-ground biomass',
  },
};
let LANG = localStorage.getItem('cantares_lang') || 'es';
const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.es[k] || k;
// bilingual data field: prefer <field>_en in English, fall back to base field
const L = (obj, field) => (LANG === 'en' && obj[field + '_en']) ? obj[field + '_en'] : obj[field];

// ---------- utilities ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function haversine(a, b) {
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
function onStyleReady(map, cb) {
  let done = false;
  const run = () => { if (!done && map.isStyleLoaded()) { done = true; clearInterval(iv); cb(); } };
  map.on('load', run); map.on('styledata', run);
  const iv = setInterval(run, 200);
  setTimeout(() => clearInterval(iv), 10000);
  run();
}
function buildStyle() {
  return {
    version: 8,
    sources: { esri: { type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxzoom: 19 } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#c9d3c6' } },
      { id: 'esri', type: 'raster', source: 'esri' },
    ],
  };
}

const ZONE_COLORS = {
  conservacion: '#1b4332', uso_intensivo: '#b5651d',
  agroecosistema: '#a3b18a', transicion: '#52796f',
};

async function initMap() {
  const [boundary, zones, caminos, waypointsFC] = await Promise.all([
    loadJSON(CONFIG.data.boundary), loadJSON(CONFIG.data.zones),
    loadJSON(CONFIG.data.caminos), loadJSON(CONFIG.data.waypoints),
  ]);
  state.waypoints = waypointsFC.features;

  const map = new maplibregl.Map({
    container: 'map', style: buildStyle(), center: CONFIG.center, zoom: CONFIG.zoom,
    maxBounds: CONFIG.maxBounds, attributionControl: { compact: true },
  });
  state.map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(finish, 11000);
    onStyleReady(map, () => {
      // Management zones (colored fills)
      map.addSource('zones', { type: 'geojson', data: zones });
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones',
        paint: { 'fill-color': ['match', ['get', 'zona'],
          'conservacion', ZONE_COLORS.conservacion, 'uso_intensivo', ZONE_COLORS.uso_intensivo,
          'agroecosistema', ZONE_COLORS.agroecosistema, 'transicion', ZONE_COLORS.transicion, '#888'],
          'fill-opacity': 0.22 } });
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
        paint: { 'line-color': ['match', ['get', 'zona'],
          'conservacion', ZONE_COLORS.conservacion, 'uso_intensivo', ZONE_COLORS.uso_intensivo,
          'agroecosistema', ZONE_COLORS.agroecosistema, 'transicion', ZONE_COLORS.transicion, '#888'],
          'line-width': 1, 'line-opacity': 0.5 } });

      // Reserve boundary outline
      map.addSource('boundary', { type: 'geojson', data: boundary });
      map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
        paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-dasharray': [2, 1.4] } });

      // Trail network (path footprint)
      map.addSource('caminos', { type: 'geojson', data: caminos });
      map.addLayer({ id: 'caminos-fill', type: 'fill', source: 'caminos',
        paint: { 'fill-color': '#f4a259', 'fill-opacity': 0.85 } });
      map.addLayer({ id: 'caminos-line', type: 'line', source: 'caminos',
        paint: { 'line-color': '#8a5a24', 'line-width': 1 } });

      // Waypoints
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

      map.on('click', 'waypoints-pt', (e) =>
        showWaypoint(state.waypoints.find((w) => w.properties.id === e.features[0].properties.id)));
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
  all.className = 'route-chip' + (state.activeRoute === null ? ' active' : '');
  all.dataset.route = '';
  all.innerHTML = `<span class="emoji">🗺️</span>${t('all_routes')}`;
  all.onclick = () => selectRoute(null);
  bar.appendChild(all);

  state.routes.forEach((r) => {
    const chip = document.createElement('button');
    chip.className = 'route-chip' + (state.activeRoute === r.id ? ' active' : '');
    chip.dataset.route = r.id;
    // Full name, never truncated.
    chip.innerHTML = `<span class="emoji">${r.emoji}</span>${L(r, 'name')}`;
    if (state.activeRoute === r.id) { chip.style.background = r.color; chip.style.color = '#fff'; }
    chip.onclick = () => selectRoute(r.id);
    bar.appendChild(chip);
  });
}

function selectRoute(id) {
  state.activeRoute = id;
  const route = id ? state.routesById[id] : null;
  renderRouteBar();

  const map = state.map;
  if (map && map.getLayer && map.getLayer('waypoints-pt')) {
    map.setFilter('waypoints-pt', id ? ['in', route.theme, ['get', 'themes']] : null);
  }

  const info = $('#route-info');
  if (route) {
    info.classList.remove('hidden');
    info.style.borderLeftColor = route.color;
    info.innerHTML = `<h3>${route.emoji} ${L(route, 'name')}</h3><p>${L(route, 'summary')}</p>`;
  } else {
    info.classList.add('hidden');
  }
}

// ---------- waypoint card ----------
const THEME_COLORS = { agua: '#2b8cbe', arboles: '#238b45', aves: '#d94801', restauracion: '#88419d', info: '#5b6b60' };
function themeLabel(th) {
  const map = { agua: { es: 'Agua', en: 'Water' }, arboles: { es: 'Árboles', en: 'Trees' },
    aves: { es: 'Aves', en: 'Birds' }, restauracion: { es: 'Restauración', en: 'Restoration' },
    info: { es: 'Info', en: 'Info' } };
  return (map[th] && map[th][LANG]) || th;
}

function showWaypoint(wp) {
  if (!wp) return;
  const p = wp.properties;
  state.openWaypointId = p.id;
  const badges = (p.themes || []).map((th) =>
    `<span class="badge" style="background:${THEME_COLORS[th] || '#5b6b60'}">${themeLabel(th)}</span>`).join('');
  const speciesChips = (p.species_ids || []).map((sid) => {
    const s = state.species.find((x) => x.id === sid);
    return s ? `<span class="chip" data-species="${sid}">${L(s, 'common_name')}</span>` : '';
  }).join('');

  $('#wp-content').innerHTML = `
    <div class="wp-theme-badges">${badges}</div>
    <h2 class="wp-title">${L(p, 'title') || p.name}</h2>
    ${p.photo ? `<img class="wp-photo" src="${p.photo}" alt="${p.name}">` : ''}
    <p class="wp-desc">${L(p, 'description') || ''}</p>
    ${speciesChips ? `<div class="wp-species">${speciesChips}</div>` : ''}
    ${p.approx ? `<p class="tiny muted" style="margin-top:10px">${t('approx_note')}</p>` : ''}
  `;
  $('#waypoint-card').classList.remove('hidden');
  $$('#wp-content .chip').forEach((chip) => {
    chip.onclick = () => { switchView('especies'); highlightSpecies(chip.dataset.species); };
  });
}
function closeWaypoint() { $('#waypoint-card').classList.add('hidden'); state.openWaypointId = null; }

// ---------- geolocation ----------
function setGps(status, label) {
  $('#gps-chip').className = `gps-chip gps-${status}`;
  $('#gps-label').textContent = label || t('gps');
}
function locate() {
  if (state.watchId != null) { stopTracking(); return; }
  if (!('geolocation' in navigator)) { setGps('error', t('gps_unsupported')); toast(t('gps_unsupported')); return; }
  const localhost = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!window.isSecureContext && !localhost) { toast(t('gps_insecure')); }
  state.firstFix = false;
  setGps('searching', t('gps_searching'));
  $('#locate-btn').classList.add('tracking');
  const opts = { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 };
  navigator.geolocation.getCurrentPosition(onPosition, onGeoError, opts); // quick first fix
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError,
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 });
}
function stopTracking() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $('#locate-btn').classList.remove('tracking');
  setGps('off', t('gps'));
}
function onPosition(pos) {
  const { longitude, latitude, accuracy } = pos.coords;
  state.userPos = [longitude, latitude];
  setGps('on', `±${Math.round(accuracy)} m`);
  const src = state.map && state.map.getSource('user');
  if (src) src.setData({ type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: state.userPos }, properties: {} }] });
  if (state.map) {
    if (!state.firstFix) { state.map.flyTo({ center: state.userPos, zoom: 17, duration: 900 }); state.firstFix = true; }
    else state.map.easeTo({ center: state.userPos, duration: 600 });
  }
  checkProximity();
}
function onGeoError(err) {
  const msg = err.code === 1 ? t('gps_denied') : err.code === 2 ? t('gps_unavailable') : t('gps_timeout');
  setGps('error', msg);
  if (err.code === 1) { stopTracking(); toast(t('gps_hint_denied')); }
  else toast(msg);
}
function checkProximity() {
  if (!state.userPos) return;
  state.waypoints.forEach((wp) => {
    const id = wp.properties.id;
    if (state.activeRoute) {
      const route = state.routesById[state.activeRoute];
      if (!(wp.properties.themes || []).includes(route.theme)) return;
    }
    const d = haversine(state.userPos, wp.geometry.coordinates);
    if (d <= CONFIG.proximityMeters && !state.lastTriggered[id]) {
      state.lastTriggered[id] = true;
      toast('📍 ' + (L(wp.properties, 'title') || wp.properties.name));
      showWaypoint(wp);
    } else if (d > CONFIG.reTriggerMeters && state.lastTriggered[id]) {
      state.lastTriggered[id] = false;
    }
  });
}
let toastTimer = null;
function toast(msg) {
  const el = $('#proximity-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3400);
}

// ---------- species ----------
let speciesFilter = 'all';
function renderSpeciesFilters() {
  const wrap = $('#species-filters');
  const opts = [['all', t('f_all')], ['flagship', t('f_flagship')], ['flora', t('f_flora')], ['ave', t('f_aves')], ['mamifero', t('f_mam')]];
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
  return state.species.filter((s) =>
    speciesFilter === 'all' ? true : speciesFilter === 'flagship' ? s.flagship : s.group === speciesFilter);
}
function renderSpeciesGrid(highlightId) {
  const grid = $('#species-grid');
  const list = filteredSpecies();
  $('#species-count').textContent = `${list.length} ${t('count_suffix')}`;
  grid.innerHTML = '';
  list.forEach((s) => {
    const card = document.createElement('div');
    card.className = `species-card ${s.flagship ? 'flagship' : ''} ${s.status === 'possible' ? 'status-possible' : ''}`;
    card.id = `sp-${s.id}`;
    card.innerHTML = `
      ${s.flagship ? '<span class="star">★</span>' : ''}
      <p class="species-common">${L(s, 'common_name')}</p>
      <p class="species-sci">${s.scientific_name}</p>
      <p class="species-meta">${s.family}${s.status === 'possible' ? ' · ' + t('possible') : ''}</p>
      <span class="species-group-tag g-${s.group}">${t('grp_' + s.group)}</span>`;
    grid.appendChild(card);
  });
  if (highlightId) {
    const el = $(`#sp-${highlightId}`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.outline = '2px solid var(--sun)'; setTimeout(() => el.style.outline = '', 2000); }
  }
}
function highlightSpecies(id) {
  if (!state.species.find((x) => x.id === id)) return;
  speciesFilter = 'all'; renderSpeciesFilters(); renderSpeciesGrid(id);
}

// ---------- navigation ----------
function switchView(name) {
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  $(`#view-${name}`).classList.add('is-active');
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === name));
  if (name === 'recorridos' && state.map) setTimeout(() => state.map.resize(), 60);
}

// ---------- restoration: carbon card ----------
async function renderCarbon() {
  try {
    const c = await loadJSON('data/carbon.json');
    const isDemo = /DEMO/i.test(c.note || '');
    $('#carbon-panel').innerHTML = `
      <h2>${t('carbon_h')}</h2>
      <div class="carbon-figure">${c.co2e_total_t} t <span>CO₂e</span></div>
      <p class="muted">${c.n_trees} ${t('key_trees')} · IC 95% ${c.co2e_ci_t[0]}–${c.co2e_ci_t[1]} t · ${t('agb')} ${(c.agb_total_kg / 1000).toFixed(1)} t</p>
      <p class="tiny muted">${c.method}</p>
      ${isDemo ? `<div class="placeholder">${t('demo_note')}</div>` : ''}`;
  } catch (e) { /* keep placeholder */ }
}

// ---------- offline / SW ----------
function renderOfflineStatus() {
  $('#offline-status').innerHTML = navigator.onLine ? t('online') : t('offline');
}
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW', e); }
}

// ---------- language ----------
function applyStaticI18n() {
  document.documentElement.lang = LANG;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  $('#lang-toggle').textContent = LANG === 'es' ? 'EN' : 'ES';
}
function renderDynamic() {
  renderRouteBar();
  if (state.activeRoute !== null || $('#route-info')) selectRoute(state.activeRoute);
  renderSpeciesFilters();
  renderSpeciesGrid();
  renderCarbon();
  renderOfflineStatus();
  if (state.openWaypointId) {
    const wp = state.waypoints.find((w) => w.properties.id === state.openWaypointId);
    if (wp) showWaypoint(wp);
  }
}
function setLang(lang) {
  LANG = lang;
  localStorage.setItem('cantares_lang', lang);
  applyStaticI18n();
  renderDynamic();
  if (state.watchId == null) setGps('off', t('gps'));
}

// ---------- init ----------
async function main() {
  $$('.tab').forEach((tab) => tab.onclick = () => switchView(tab.dataset.view));
  $('#wp-close').onclick = closeWaypoint;
  $('#locate-btn').onclick = locate;
  $('#inat-link').href = CONFIG.inatProjectUrl;
  $('#lang-toggle').onclick = () => setLang(LANG === 'es' ? 'en' : 'es');
  window.addEventListener('online', renderOfflineStatus);
  window.addEventListener('offline', renderOfflineStatus);

  const [routesDoc, speciesDoc] = await Promise.all([
    loadJSON(CONFIG.data.routes), loadJSON(CONFIG.data.species),
  ]);
  state.routes = routesDoc.routes;
  state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
  state.species = speciesDoc.species;

  applyStaticI18n();
  renderRouteBar();
  renderSpeciesFilters();
  renderSpeciesGrid();
  renderOfflineStatus();
  renderCarbon();

  if (!new URLSearchParams(location.search).has('nomap')) {
    await initMap();
    selectRoute(null);
  }
  registerSW();
}
main().catch((e) => { console.error(e); toast('Error: ' + e.message); });

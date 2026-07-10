// Cantares — Guía interactiva de la reserva / Interactive reserve guide
// Minimal-vanilla PWA. Globals `maplibregl` and `pmtiles` come from vendored scripts.

import { GAME_I18N, initGame, refreshGameUI, capturedBadge, gameAddMapLayer } from './game.js';
import * as Cloud from './cloud.js';
import { initAuthGate } from './auth-ui.js';
import { initAdmin } from './admin.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const CONFIG = {
  center: [-75.4503, 5.0818], zoom: 15.6,
  maxBounds: [[-75.462, 5.072], [-75.439, 5.092]],
  proximityMeters: 25, reTriggerMeters: 60,
  inatProjectUrl: 'https://www.inaturalist.org/projects/reserva-natural-cantares',
  data: {
    boundary: 'data/boundary.geojson', zones: 'data/zones.geojson',
    trails: 'data/trails.geojson', waypoints: 'data/waypoints.geojson',
    routes: 'data/routes.json', species: 'data/species.json',
    reserveInfo: 'data/reserve_info.json', media: 'data/media.json',
  },
  // Base imagery time-slider stops. Esri Wayback = free, keyless, sub-meter.
  // Labeled by the REAL acquisition date over the reserve (from the Wayback
  // metadata service), NOT the release date. Over Cantares only 3 high-res
  // captures exist (Manizales is cloudy, rarely re-flown): 2015, 2020, 2024.
  baseStops: [
    { key: '2015', tiles: wayback(18691) },  // WorldView-2, 0.5 m — feb 2015
    { key: '2020', tiles: wayback(64776) },  // WorldView-3, 0.31 m — feb 2020
    { key: '2024', tiles: wayback(51127) },  // WorldView-3, 0.31 m — ene 2024 (la más actual)
  ],
};
// Esri Wayback WMTS: /{release}/{level}/{row}/{col} = /{release}/{z}/{y}/{x}.
function wayback(rel) { return `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${rel}/{z}/{y}/{x}`; }

const state = {
  map: null, routes: [], routesById: {}, species: [], waypoints: [], trails: [],
  activeRoute: null, userPos: null, watchId: null, firstFix: false,
  lastTriggered: {}, openWaypointId: null, baseIndex: 2, zonesVisible: false,
  reserveInfo: null, media: { bySubject: {} },
  hiddenTypes: new Set(),   // tipos de punto ocultados por el usuario
  guiding: null,            // id del recorrido en modo "seguir" (GPS)
  flowTimer: null,          // animación de flechas/flujo sobre el recorrido
};

// ---------- tipos de punto (legend filter) ----------
// Data-driven: the app reads the distinct `tipo` values present in
// waypoints.geojson and renders a toggle per type. This map only supplies the
// label/emoji/color; unknown types fall back to a neutral pin.
const TYPE_META = {
  mirador:      { emoji: '🔭', color: '#1098ad', es: 'Miradores',    en: 'Lookouts' },
  avistamiento: { emoji: '🐾', color: '#d94801', es: 'Avistamientos', en: 'Wildlife' },
  agua:         { emoji: '💧', color: '#2b8cbe', es: 'Agua',          en: 'Water' },
  flora:        { emoji: '🌿', color: '#2f9e44', es: 'Flora',         en: 'Plants' },
  servicio:     { emoji: '🏠', color: '#6a4c93', es: 'Servicios',     en: 'Facilities' },
  punto:        { emoji: '📍', color: '#5b6b60', es: 'Otros puntos',  en: 'Other points' },
};
const typeMeta = (tp) => TYPE_META[tp] || TYPE_META.punto;
const typeLabel = (tp) => { const m = typeMeta(tp); return LANG === 'en' ? m.en : m.es; };
// Distinct tipos present in the loaded waypoints, in a stable, meaningful order.
function presentTypes() {
  const order = Object.keys(TYPE_META);
  const seen = new Set(state.waypoints.map((w) => w.properties.tipo || 'punto'));
  return order.filter((t) => seen.has(t));
}

// ---------- media (fotos curadas de especies y puntos, desde media.json) ----------
function indexMedia(doc) {
  const bySubject = {};
  (doc && doc.photos || []).forEach((p) => {
    const key = `${p.subject_type}:${p.subject_id}`;
    (bySubject[key] = bySubject[key] || []).push(p);
  });
  // la principal primero
  Object.values(bySubject).forEach((arr) => arr.sort((a, b) => (b.is_primary === true) - (a.is_primary === true)));
  return { bySubject };
}
function photosFor(type, id) { return state.media.bySubject[`${type}:${id}`] || []; }
function primaryPhoto(type, id) { const a = photosFor(type, id); return a[0] || null; }
// <picture> WebP + respaldo JPEG. `cls` para estilo, `alt` texto alternativo.
function pictureTag(ph, cls, alt) {
  if (!ph) return '';
  const src = ph.thumb || ph.file;
  return `<picture class="${cls}"><source srcset="${src}" type="image/webp">` +
    `<img src="${ph.jpg || ph.file}" alt="${(alt || '').replace(/"/g, '&quot;')}" loading="lazy"></picture>`;
}

// ---------- i18n ----------
const I18N = {
  es: {
    subtitle: 'Reserva Natural', tab_recorridos: 'Recorridos', tab_restauracion: 'Restauración',
    tab_especies: 'Especies', tab_info: 'Info', all_routes: 'Todos',
    gps: 'GPS', gps_searching: 'Buscando…', gps_denied: 'Permiso denegado', gps_unavailable: 'Sin señal',
    gps_timeout: 'Sin respuesta', gps_unsupported: 'GPS no disponible', gps_insecure: 'El GPS requiere HTTPS',
    gps_hint_denied: 'Activa el permiso de ubicación para este sitio en el navegador.',
    approx_note: 'Posición aproximada — se reemplaza con el punto GPS real.',
    more_info: 'Más información', sample_photo: 'foto de muestra',
    legend: 'Leyenda', lg_trails: 'Senderos', lg_route: 'Recorrido activo', lg_start: 'Inicio', lg_end: 'Fin',
    lg_point: 'Punto clave', lg_zones: 'Zonas de manejo', lg_zones_toggle: 'Mostrar/ocultar zonas',
    lg_points_head: 'Tipos de punto',
    z_conservacion: 'Conservación', z_uso_intensivo: 'Uso intensivo', z_agroecosistema: 'Agrosistema', z_transicion: 'Transición',
    base_label: 'Imagen satelital', base_hd: 'Actual (HD)', base_ortho: 'Ortofoto',
    base_forest_title: 'El bosque en el tiempo', base_forest_hint: 'Desliza para ver crecer el bosque',
    base_toggle: 'Bosque',
    ri_points: 'Puntos del recorrido', ri_start_walk: '▶ Comenzar recorrido', ri_stop_walk: '■ Terminar recorrido',
    guiding_on: 'Siguiendo tu ubicación en el sendero…', guiding_off: 'Recorrido terminado',
    no_points: 'No hay puntos visibles con los filtros activos.',
    rest_title: 'Restauración',
    rest_lead: 'De potrero de kikuyo a bosque. La reserva tiene <strong>16,4 ha en restauración</strong>, donde el ganado salió hacia ~2019 y hoy crecen especies nativas.',
    ndvi_h: '🌿 Reverdecimiento (NDVI)', ndvi_p: 'Serie temporal Sentinel-2 2019 → hoy en la zona de restauración vs. la de conservación (control).',
    ndvi_pending: 'Pendiente: correr <code>data_prep/03_ndvi_timeseries.R</code> (requiere Earth Engine).',
    ortho_h: '🛰️ Antes / después (ortofoto)', ortho_p: 'Ortofoto fotogramétrica de la reserva (~4,4 cm/píxel).',
    carbon_h: '🌳 Carbono capturado',
    especies_h: 'Especies', especies_lead: 'Reconoce la fauna y flora de Cantares. Cada avistamiento alimenta el inventario de la reserva.',
    id_plant: 'Identificar planta', id_bird: 'Identificar ave', id_inat: 'Sumar al inventario',
    f_all: 'Todas', f_flagship: '★ Destacadas', f_flora: '🌳 Flora', f_aves: '🐦 Aves', f_mam: '🐾 Mamíferos', f_anf: '🐸 Anfibios',
    grp_anfibio: 'Anfibios',
    count_suffix: 'especies · el inventario crece con cada avistamiento', possible: 'posible',
    info_h: 'La Reserva',
    info_lead: 'Reserva Natural de la Sociedad Civil <strong>Cantares</strong> (RNSC 112-20), 31,07 ha en la vereda Las Palomas, ~5 km de Manizales.',
    fact_eco: 'Ecosistema', fact_eco_v: 'Bosque muy húmedo montano bajo, 1.800–3.000 msnm',
    fact_cli: 'Clima', fact_cli_v: '6–12 °C, 1.000–2.000 mm de lluvia al año',
    fact_rest: 'Restauración', fact_rest_v: '16,4 ha · Conservación 10,5 ha',
    fact_water: 'Agua', fact_water_v: 'Quebradas La Peña y La Arenosa → Río Blanco → Río Chinchiná',
    fact_reg: 'Registro', fact_reg_v: 'Parques Nacionales Naturales, Res. 201 de 2021',
    map_illus: 'Mapa ilustrado de senderos',
    grp_flora: 'Flora', grp_ave: 'Aves', grp_mamifero: 'Mamíferos',
    online: '🟢 En línea. Abre el mapa aquí (wifi) para guardar los tiles y luego funciona sin señal en el sendero.',
    offline: '⚪ Sin conexión. La app y el contenido guardado siguen disponibles.',
    ob_title: 'Bienvenido a Cantares',
    ob_p_map: 'Mapa con tu ubicación en vivo en el sendero',
    ob_p_species: 'Especies, avistamientos y un juego de exploración',
    ob_p_offline: 'Funciona sin señal una vez cargada',
    ob_tip: 'Consejo: abre el mapa ahora con wifi para guardarlo y usarlo sin conexión.',
    ob_go: 'Explorar la reserva →',
    visit_h: 'Planea tu visita', v_hours: '🕑 Horarios', v_contact: '📞 Contacto',
    v_arrive: '🚗 Cómo llegar', v_parking: '🅿️ Parqueo', v_entry: '🎟️ Entrada',
    v_rules_h: '📋 Normas de la reserva', v_safety_h: '🛟 Seguridad',
    v_lost: 'Si te pierdes', v_emergency: 'Emergencias', v_call: 'Llamar',
    v_pending: 'Por completar', v_whatsapp: 'WhatsApp',
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
    more_info: 'More info', sample_photo: 'sample photo',
    legend: 'Legend', lg_trails: 'Trails', lg_route: 'Active route', lg_start: 'Start', lg_end: 'End',
    lg_point: 'Key point', lg_zones: 'Management zones', lg_zones_toggle: 'Show/hide zones',
    lg_points_head: 'Point types',
    z_conservacion: 'Conservation', z_uso_intensivo: 'Intensive use', z_agroecosistema: 'Agrosystem', z_transicion: 'Transition',
    base_label: 'Satellite image', base_hd: 'Current (HD)', base_ortho: 'Orthophoto',
    base_forest_title: 'The forest over time', base_forest_hint: 'Slide to watch the forest grow',
    base_toggle: 'Forest',
    ri_points: 'Route points', ri_start_walk: '▶ Start route', ri_stop_walk: '■ End route',
    guiding_on: 'Following your location on the trail…', guiding_off: 'Route ended',
    no_points: 'No points visible with the active filters.',
    rest_title: 'Restoration',
    rest_lead: 'From kikuyu pasture to forest. The reserve has <strong>16.4 ha under restoration</strong>, where cattle left around 2019 and native species now grow.',
    ndvi_h: '🌿 Greening (NDVI)', ndvi_p: 'Sentinel-2 time series 2019 → today in the restoration zone vs. the conservation zone (control).',
    ndvi_pending: 'Pending: run <code>data_prep/03_ndvi_timeseries.R</code> (needs Earth Engine).',
    ortho_h: '🛰️ Before / after (orthophoto)', ortho_p: 'Photogrammetric orthophoto of the reserve (~4.4 cm/pixel).',
    carbon_h: '🌳 Carbon captured',
    especies_h: 'Species', especies_lead: 'Get to know the wildlife and plants of Cantares. Every sighting feeds the reserve inventory.',
    id_plant: 'Identify plant', id_bird: 'Identify bird', id_inat: 'Add to inventory',
    f_all: 'All', f_flagship: '★ Flagship', f_flora: '🌳 Plants', f_aves: '🐦 Birds', f_mam: '🐾 Mammals', f_anf: '🐸 Amphibians',
    grp_anfibio: 'Amphibians',
    count_suffix: 'species · the inventory grows with every sighting', possible: 'possible',
    info_h: 'The Reserve',
    info_lead: 'Civil Society Nature Reserve <strong>Cantares</strong> (RNSC 112-20), 31.07 ha in vereda Las Palomas, ~5 km from Manizales.',
    fact_eco: 'Ecosystem', fact_eco_v: 'Very humid lower montane forest, 1,800–3,000 masl',
    fact_cli: 'Climate', fact_cli_v: '6–12 °C, 1,000–2,000 mm rain per year',
    fact_rest: 'Restoration', fact_rest_v: '16.4 ha · Conservation 10.5 ha',
    fact_water: 'Water', fact_water_v: 'La Peña & La Arenosa creeks → Río Blanco → Río Chinchiná',
    fact_reg: 'Registry', fact_reg_v: 'National Natural Parks, Resolution 201 of 2021',
    map_illus: 'Illustrated trail map',
    grp_flora: 'Plants', grp_ave: 'Birds', grp_mamifero: 'Mammals',
    online: '🟢 Online. Open the map here (wifi) to cache tiles, then it works with no signal on the trail.',
    offline: '⚪ Offline. The app and cached content are still available.',
    ob_title: 'Welcome to Cantares',
    ob_p_map: 'A map with your live position on the trail',
    ob_p_species: 'Species, sightings and an exploration game',
    ob_p_offline: 'Works with no signal once loaded',
    ob_tip: 'Tip: open the map now on wifi to save it and use it offline.',
    ob_go: 'Explore the reserve →',
    visit_h: 'Plan your visit', v_hours: '🕑 Hours', v_contact: '📞 Contact',
    v_arrive: '🚗 Getting there', v_parking: '🅿️ Parking', v_entry: '🎟️ Entry',
    v_rules_h: '📋 Reserve rules', v_safety_h: '🛟 Safety',
    v_lost: 'If you get lost', v_emergency: 'Emergencies', v_call: 'Call',
    v_pending: 'To be filled in', v_whatsapp: 'WhatsApp',
    demo_note: 'DEMO figures. Replace <code>inputs/inventory/key_trees.csv</code> and run <code>data_prep/05_carbon_allometry.R</code>.',
    key_trees: 'key trees', agb: 'above-ground biomass',
  },
};
// Merge the game's strings into the app dictionary (game.js owns its own keys).
Object.keys(GAME_I18N).forEach((lang) => Object.assign(I18N[lang] = I18N[lang] || {}, GAME_I18N[lang]));

let LANG = localStorage.getItem('cantares_lang') || 'es';
const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.es[k] || k;
const L = (obj, field) => (LANG === 'en' && obj[field + '_en']) ? obj[field + '_en'] : obj[field];

// ---------- utilities ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// Accept a field as a JSON array OR a QGIS "a,b" text field OR null/empty → array.
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
// Normalize QGIS-authored properties so the map filters and JS always see arrays/bools.
function normalizeFeatures(fc) {
  (fc.features || []).forEach((f) => {
    const p = f.properties || (f.properties = {});
    p.routes = toArray(p.routes);
    if ('species_ids' in p) p.species_ids = toArray(p.species_ids);
    if ('keypoint' in p) p.keypoint = (p.keypoint === true || p.keypoint === 'true');
  });
  return fc;
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
function baseSourceDef(stop) {
  if (stop.pmtiles) return { type: 'raster', url: 'pmtiles://tiles/ortho.pmtiles',
    tileSize: 512, attribution: 'Ortofoto Cantares' };
  // All stops are Esri (Wayback historical or current) — sub-meter, high zoom.
  return { type: 'raster', tiles: [stop.tiles], tileSize: 256, maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' };
}
function baseLabel(stop) { return stop.hd ? t('base_hd') : stop.pmtiles ? t('base_ortho') : stop.key; }
function renderBaseTicks() {
  const el = document.querySelector('#base-ticks');
  if (!el) return;
  el.innerHTML = CONFIG.baseStops.map((s) =>
    `<span>${s.hd ? 'HD' : s.pmtiles ? 'Orto' : s.key}</span>`).join('');
}
function buildStyle() {
  return { version: 8, sources: { base: baseSourceDef(CONFIG.baseStops[state.baseIndex]) },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#c9d3c6' } },
      { id: 'base', type: 'raster', source: 'base' },
    ] };
}
function setBaseLayer(i) {
  state.baseIndex = i;
  const stop = CONFIG.baseStops[i];
  $('#base-year').textContent = baseLabel(stop);   // always reflect the year, even if map not ready
  const map = state.map;
  if (!map || !map.getSource('base')) return;
  if (map.getLayer('base')) map.removeLayer('base');
  map.removeSource('base');
  map.addSource('base', baseSourceDef(stop));
  const before = map.getLayer('zones-fill') ? 'zones-fill' : undefined;
  map.addLayer({ id: 'base', type: 'raster', source: 'base' }, before);
}
function makeArrowIcon(map) {
  if (map.hasImage('arrow')) return;
  const s = 22, c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.strokeStyle = '#1b4332'; x.lineWidth = 2.5;
  x.beginPath(); x.moveTo(5, 4); x.lineTo(18, 11); x.lineTo(5, 18); x.lineTo(9, 11); x.closePath();
  x.fill(); x.stroke();
  map.addImage('arrow', x.getImageData(0, 0, s, s));
}

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
// MapLibre `match` expression coloring a point by its `tipo` (legend parity).
function typeColorMatch() {
  const pairs = [];
  Object.keys(TYPE_META).forEach((tp) => { if (tp !== 'punto') pairs.push(tp, TYPE_META[tp].color); });
  return ['match', ['get', 'tipo'], ...pairs, TYPE_META.punto.color];
}

const ZONE_COLORS = { conservacion: '#1b4332', uso_intensivo: '#b5651d', agroecosistema: '#a3b18a', transicion: '#52796f' };
const zoneMatch = (prop) => ['match', ['get', 'zona'],
  'conservacion', ZONE_COLORS.conservacion, 'uso_intensivo', ZONE_COLORS.uso_intensivo,
  'agroecosistema', ZONE_COLORS.agroecosistema, 'transicion', ZONE_COLORS.transicion, '#888'];

async function initMap() {
  const [boundary, zones] = await Promise.all([
    loadJSON(CONFIG.data.boundary), loadJSON(CONFIG.data.zones),
  ]);
  // Trails/waypoints pueden venir ya cargados desde la nube (ediciones del admin);
  // si no, se cargan de los archivos estáticos (offline / sin nube).
  let trails, waypointsFC;
  if (state.trails.length) { trails = { type: 'FeatureCollection', features: state.trails }; }
  else { trails = await loadJSON(CONFIG.data.trails); normalizeFeatures(trails); state.trails = trails.features; }
  if (state.waypoints.length) { waypointsFC = { type: 'FeatureCollection', features: state.waypoints }; }
  else { waypointsFC = await loadJSON(CONFIG.data.waypoints); normalizeFeatures(waypointsFC); state.waypoints = waypointsFC.features; }

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
      makeArrowIcon(map);
      // zones
      map.addSource('zones', { type: 'geojson', data: zones });
      const zv = state.zonesVisible ? 'visible' : 'none';   // apagadas por defecto
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones',
        layout: { visibility: zv },
        paint: { 'fill-color': zoneMatch(), 'fill-opacity': 0.22 } });
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
        layout: { visibility: zv },
        paint: { 'line-color': zoneMatch(), 'line-width': 1, 'line-opacity': 0.5 } });
      // boundary
      map.addSource('boundary', { type: 'geojson', data: boundary });
      map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
        paint: { 'line-color': '#fff', 'line-width': 3, 'line-dasharray': [2, 1.4] } });
      // trails — all as neutral lines, plus a highlighted layer for the active route
      map.addSource('trails', { type: 'geojson', data: trails });
      map.addLayer({ id: 'trails-all', type: 'line', source: 'trails',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f4f1de', 'line-width': 2.2, 'line-opacity': 0.85 } });
      map.addLayer({ id: 'trails-hl', type: 'line', source: 'trails', filter: ['==', 'id', '___none___'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#e07a1f', 'line-width': 6, 'line-opacity': 0.9 } });
      // ordered route path (a single start→end LineString) for the directional
      // flow: a marching-dash line + arrows, both oriented start→end.
      map.addSource('route-path', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'route-flow', type: 'line', source: 'route-path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fff', 'line-width': 3, 'line-opacity': 0.95, 'line-dasharray': [0, 4, 3] } });
      map.addLayer({ id: 'route-arrows', type: 'symbol', source: 'route-path',
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'arrow',
          'icon-size': 0.85, 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
      // route start/end markers
      map.addSource('route-ends', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'route-ends', type: 'circle', source: 'route-ends',
        paint: { 'circle-radius': 7,
          'circle-color': ['match', ['get', 'kind'], 'start', '#2f9e44', 'end', '#e03131', '#888'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
      // waypoints — colored by tipo so they match the legend's type toggles (small dots)
      map.addSource('waypoints', { type: 'geojson', data: waypointsFC });
      map.addLayer({ id: 'waypoints-pt', type: 'circle', source: 'waypoints',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3.5, 17, 5, 19, 6.5],
          'circle-color': typeColorMatch(), 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
      // user
      map.addSource('user', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'user-halo', type: 'circle', source: 'user',
        paint: { 'circle-radius': 16, 'circle-color': '#2b8cbe', 'circle-opacity': 0.18 } });
      map.addLayer({ id: 'user-dot', type: 'circle', source: 'user',
        paint: { 'circle-radius': 7, 'circle-color': '#2b8cbe', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });

      const wpAt = (e) => state.waypoints.find((w) => w.properties.id === e.features[0].properties.id);
      // Hover (desktop) and tap (mobile) both open the anchored mini-popup.
      map.on('mouseenter', 'waypoints-pt', (e) => { map.getCanvas().style.cursor = 'pointer'; cancelClosePopup(); miniPopup(wpAt(e)); });
      map.on('mouseleave', 'waypoints-pt', () => { map.getCanvas().style.cursor = ''; scheduleClosePopup(); });
      map.on('click', 'waypoints-pt', (e) => { state._wpClick = true; miniPopup(wpAt(e)); });
      // Click on empty map closes the mini-popup.
      map.on('click', () => { if (state._wpClick) { state._wpClick = false; return; } removePopup(); });
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
  all.innerHTML = `<span class="emoji">🗺️</span>${t('all_routes')}`;
  all.onclick = () => selectRoute(null);
  bar.appendChild(all);
  state.routes.forEach((r) => {
    const chip = document.createElement('button');
    chip.className = 'route-chip' + (state.activeRoute === r.id ? ' active' : '');
    chip.dataset.route = r.id;
    chip.innerHTML = `<span class="emoji">${r.emoji}</span>${L(r, 'name')}`;   // full name, never truncated
    if (state.activeRoute === r.id) { chip.style.background = r.color; chip.style.color = '#fff'; }
    chip.onclick = () => selectRoute(r.id);
    bar.appendChild(chip);
  });
}

const wpById = (id) => state.waypoints.find((w) => w.properties.id === id);
const routeSegments = (id) => state.trails
  .filter((tr) => (tr.properties.routes || []).includes(id))
  .map((tr) => tr.geometry.coordinates.slice());

// Resolve start/end coordinates for a route: honor explicit start_id/end_id from
// routes.json, snap them to the nearest segment endpoint, fill any missing side
// from the geometrically farthest endpoint pair.
function routeStartEnd(id) {
  const route = state.routesById[id];
  const segs = routeSegments(id);
  if (!segs.length) return null;
  const endpts = [];
  segs.forEach((cs) => { endpts.push(cs[0], cs[cs.length - 1]); });
  let best = [endpts[0], endpts[0]], bestD = -1;
  for (let i = 0; i < endpts.length; i++)
    for (let j = i + 1; j < endpts.length; j++) {
      const d = haversine(endpts[i], endpts[j]);
      if (d > bestD) { bestD = d; best = [endpts[i], endpts[j]]; }
    }
  const snap = (coord) => endpts.reduce((a, p) => haversine(coord, p) < haversine(coord, a) ? p : a, endpts[0]);
  const startWp = route && route.start_id ? wpById(route.start_id) : null;
  const endWp   = route && route.end_id   ? wpById(route.end_id)   : null;
  let startCoord = startWp ? snap(startWp.geometry.coordinates) : null;
  let endCoord   = endWp   ? snap(endWp.geometry.coordinates)   : null;
  if (startCoord && !endCoord)
    endCoord = haversine(startCoord, best[0]) > haversine(startCoord, best[1]) ? best[0] : best[1];
  else if (!startCoord && endCoord)
    startCoord = haversine(endCoord, best[0]) > haversine(endCoord, best[1]) ? best[0] : best[1];
  else if (!startCoord && !endCoord) {
    const entrada = wpById('punto_1');   // Casa ≈ reserve entrance
    const [a, b] = best;
    const startFirst = entrada
      ? haversine(a, entrada.geometry.coordinates) <= haversine(b, entrada.geometry.coordinates)
      : a[1] < b[1];
    startCoord = startFirst ? a : b; endCoord = startFirst ? b : a;
  }
  return { segs, startCoord, endCoord, startWp, endWp };
}

// Greedily chain a route's segments into ONE ordered polyline start→end, so the
// direction arrows and the marching-dash flow all run the same, correct way.
function buildRoutePath(id) {
  const info = routeStartEnd(id);
  if (!info) return null;
  const { segs, startCoord, endCoord } = info;
  const used = new Array(segs.length).fill(false);
  let path = null, tail = startCoord;
  for (let step = 0; step < segs.length; step++) {
    let bi = -1, rev = false, bd = Infinity;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const cs = segs[i];
      const dHead = haversine(tail, cs[0]);
      const dTail = haversine(tail, cs[cs.length - 1]);
      if (dHead < bd) { bd = dHead; bi = i; rev = false; }
      if (dTail < bd) { bd = dTail; bi = i; rev = true; }
    }
    if (bi < 0) break;
    if (path && bd > 60) break;   // next piece is disconnected — stop chaining
    used[bi] = true;
    const seg = rev ? segs[bi].slice().reverse() : segs[bi].slice();
    path = path ? path.concat(seg.slice(1)) : seg;
    tail = path[path.length - 1];
  }
  if (!path || path.length < 2) return null;
  if (endCoord && haversine(path[0], endCoord) < haversine(path[path.length - 1], endCoord)) path.reverse();
  info.path = path;
  return info;
}

// Label for a route endpoint: explicit waypoint title, else nearest route waypoint.
function endLabel(coord, explicitWp, id) {
  if (explicitWp) return L(explicitWp.properties, 'title') || explicitWp.properties.title;
  let best = null, bd = Infinity;
  state.waypoints.forEach((w) => {
    const rts = w.properties.routes || [];
    if (rts.length && !rts.includes(id)) return;
    const d = haversine(coord, w.geometry.coordinates);
    if (d < bd) { bd = d; best = w; }
  });
  return best ? (L(best.properties, 'title') || best.properties.title) : null;
}

// ----- directional flow (marching-ants dash animation on the ordered path) -----
// Cycling the line-dasharray gives motion in the coordinate direction (start→end).
const DASH_SEQ = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5],
  [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2],
  [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];
function stopFlow() { if (state.flowTimer) { clearInterval(state.flowTimer); state.flowTimer = null; } }
function startFlow() {
  stopFlow();
  const map = state.map;
  if (!map || !map.getLayer('route-flow')) return;
  let i = 0;
  state.flowTimer = setInterval(() => {
    i = (i + 1) % DASH_SEQ.length;
    if (map.getLayer('route-flow')) map.setPaintProperty('route-flow', 'line-dasharray', DASH_SEQ[i]);
    else stopFlow();
  }, 90);
}

// Combined waypoint filter: active route (if any) AND tipo not hidden.
function applyWaypointFilter() {
  const map = state.map;
  if (!map || !map.getLayer('waypoints-pt')) return;
  const parts = ['all'];
  if (state.activeRoute)
    parts.push(['any', ['in', state.activeRoute, ['get', 'routes']], ['==', ['length', ['get', 'routes']], 0]]);
  const hidden = [...state.hiddenTypes];
  if (hidden.length) parts.push(['!', ['in', ['get', 'tipo'], ['literal', hidden]]]);
  map.setFilter('waypoints-pt', parts.length > 1 ? parts : null);
}
function waypointVisible(wp) {
  const p = wp.properties;
  if (state.hiddenTypes.has(p.tipo || 'punto')) return false;
  if (state.activeRoute) {
    const rts = p.routes || [];
    if (rts.length && !rts.includes(state.activeRoute)) return false;
  }
  return true;
}

function selectRoute(id) {
  state.activeRoute = id;
  const route = id ? state.routesById[id] : null;
  renderRouteBar();
  if (state.guiding && state.guiding !== id) stopGuiding();

  const map = state.map;
  const built = (id && route) ? buildRoutePath(id) : null;
  if (map && map.getLayer && map.getLayer('trails-hl')) {
    if (id) {
      map.setFilter('trails-hl', ['in', id, ['get', 'routes']]);
      map.setPaintProperty('trails-hl', 'line-color', route.color);
      const pathFC = built ? { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: built.path } }] } : emptyFC();
      map.getSource('route-path').setData(pathFC);
      const ends = built ? { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: built.path[0] } },
        { type: 'Feature', properties: { kind: 'end' }, geometry: { type: 'Point', coordinates: built.path[built.path.length - 1] } },
      ] } : emptyFC();
      map.getSource('route-ends').setData(ends);
      if (built) startFlow(); else stopFlow();
    } else {
      map.setFilter('trails-hl', ['==', 'id', '___none___']);
      map.getSource('route-path').setData(emptyFC());
      map.getSource('route-ends').setData(emptyFC());
      stopFlow();
    }
    applyWaypointFilter();
  }
  renderRouteInfo(route, built);
}

// Right-side vertical panel: summary, start/end, key-point list, start button.
function renderRouteInfo(route, built) {
  const info = $('#route-info');
  if (!route) { info.classList.add('hidden'); return; }
  const id = route.id;
  const sLbl = built ? endLabel(built.path[0], built.startWp, id) : null;
  const eLbl = built ? endLabel(built.path[built.path.length - 1], built.endWp, id) : null;
  const pts = state.waypoints.filter((w) => {
    const rts = w.properties.routes || [];
    return rts.includes(id) && waypointVisible(w);
  });
  const guiding = state.guiding === id;
  info.classList.remove('hidden');
  info.style.borderTopColor = route.color;
  info.innerHTML = `
    <button class="ri-close" id="ri-close" aria-label="Cerrar">×</button>
    <div class="ri-scroll">
      <h3>${route.emoji} ${L(route, 'name')}</h3>
      <p>${L(route, 'summary')}</p>
      ${(sLbl || eLbl) ? `<div class="ri-ends">
        ${sLbl ? `<span class="ri-end-item"><span class="ri-dot start"></span>${t('lg_start')}: ${escapeHtml(sLbl)}</span>` : ''}
        ${eLbl ? `<span class="ri-end-item"><span class="ri-dot end"></span>${t('lg_end')}: ${escapeHtml(eLbl)}</span>` : ''}
      </div>` : ''}
      <button class="ri-start ${guiding ? 'active' : ''}" id="ri-start" style="${guiding ? '' : `background:${route.color}`}">
        ${guiding ? t('ri_stop_walk') : t('ri_start_walk')}</button>
      <div class="ri-points-head">${t('ri_points')} <span class="ri-count">${pts.length}</span></div>
      ${pts.length ? `<ul class="ri-points">${pts.map((w) => {
        const m = typeMeta(w.properties.tipo);
        return `<li data-wp="${w.properties.id}"><span class="ri-pdot" style="background:${m.color}"></span>${escapeHtml(L(w.properties, 'title') || w.properties.title)}</li>`;
      }).join('')}</ul>` : `<p class="ri-empty">${t('no_points')}</p>`}
    </div>`;
  $('#ri-close').onclick = () => { info.classList.add('hidden'); if (state.guiding) stopGuiding(); };
  $('#ri-start').onclick = () => (state.guiding === id ? stopGuiding() : startGuiding(id));
  $$('#route-info .ri-points li').forEach((li) => li.onclick = () => {
    const w = wpById(li.dataset.wp);
    if (!w) return;
    state.map.easeTo({ center: w.geometry.coordinates, zoom: Math.max(state.map.getZoom(), 17), duration: 600 });
    miniPopup(w);
  });
}

// ---------- waypoint card ----------
const ROUTE_COLORS = { agua: '#2b8cbe', aves: '#d94801', arboles: '#238b45',
  flora: '#c2255c', paisaje: '#1098ad', regeneracion: '#6a4c93', nocturno: '#3b5bdb' };
function routeLabel(rid) {
  const r = state.routesById[rid];
  return r ? L(r, 'name') : rid;
}
// Real curated photo for a point, or null. No placeholder: popups adapt to the
// content they actually have (title-only if there's nothing else).
function realPhoto(wp) {
  if (wp.properties.photo) return wp.properties.photo;
  const mp = primaryPhoto('waypoint', wp.properties.id);   // foto curada real (media.json)
  return mp ? (mp.jpg || mp.file) : null;                  // jpg: universal en background-image
}

// Sticky-hover close: on hover devices the popup closes when the pointer leaves
// the point AND the popup (small grace period so the user can reach the button).
const canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
let popupCloseTimer = null;
function removePopup() { if (state.popup) { state.popup.remove(); state.popup = null; } }
function scheduleClosePopup() { if (!canHover) return; clearTimeout(popupCloseTimer); popupCloseTimer = setTimeout(removePopup, 260); }
function cancelClosePopup() { clearTimeout(popupCloseTimer); }

// Small popup anchored to the point (hover on desktop, tap on mobile). Adapts to
// content: title alone if bare; photo + text + "more info" when there's more.
function miniPopup(wp) {
  if (!wp || !state.map) return;
  cancelClosePopup();
  if (state.popup) state.popup.remove();
  const p = wp.properties;
  const tm = typeMeta(p.tipo);
  const badge = `<span class="mp-badge" style="background:${tm.color}">${tm.emoji} ${typeLabel(p.tipo)}</span>`;
  const photo = realPhoto(wp);
  const full = L(p, 'description') || '';
  const desc = full ? (full.length > 110 ? full.slice(0, 110) + '…' : full) : '';
  const hasMore = !!(full || (p.species_ids || []).length || photo);
  const html = `<div class="mini-pop${photo ? '' : ' no-photo'}">
    ${photo ? `<div class="mp-photo" style="background-image:url('${photo}')"></div>` : ''}
    <div class="mp-body">${badge}
      <strong>${escapeHtml(L(p, 'title') || p.title)}</strong>
      ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
      ${hasMore ? `<button class="mp-more" type="button">${t('more_info')} ›</button>` : ''}
    </div></div>`;
  state.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '240px', offset: 12, className: 'cantares-popup' })
    .setLngLat(wp.geometry.coordinates).setHTML(html).addTo(state.map);
  const el = state.popup.getElement();
  if (el) {
    el.addEventListener('mouseenter', cancelClosePopup);
    el.addEventListener('mouseleave', scheduleClosePopup);
    const btn = el.querySelector('.mp-more');
    if (btn) btn.onclick = () => { removePopup(); showWaypoint(wp); };
  }
}

// Full detail "page" overlaid on the map (opened from the mini-popup's More button).
function showWaypoint(wp) {
  if (!wp) return;
  const p = wp.properties;
  state.openWaypointId = p.id;
  const badges = (p.routes || []).map((rid) =>
    `<span class="badge" style="background:${ROUTE_COLORS[rid] || '#5b6b60'}">${routeLabel(rid)}</span>`).join('');
  const speciesChips = (p.species_ids || []).map((sid) => {
    const key = String(sid).trim().toLowerCase();   // waypoints may use id OR scientific name
    const s = state.species.find((x) => x.id === key || x.scientific_name.toLowerCase() === key);
    return s ? `<span class="chip" data-species="${s.id}">${L(s, 'common_name')}</span>` : '';
  }).join('');
  const photo = realPhoto(wp);
  const tm = typeMeta(p.tipo);
  const desc = L(p, 'description');
  $('#wp-content').innerHTML = `
    ${photo
      ? `<div class="wp-photo-hdr" style="background-image:url('${photo}')"></div>`
      : `<div class="wp-photo-hdr wp-no-photo" style="background:linear-gradient(135deg, ${tm.color}, var(--forest))"><span class="wp-hdr-emoji">${tm.emoji}</span></div>`}
    <div class="wp-inner">
      <div class="wp-theme-badges">${badges}</div>
      <h2 class="wp-title">${escapeHtml(L(p, 'title') || p.title)}</h2>
      ${desc ? `<p class="wp-desc">${escapeHtml(desc)}</p>` : ''}
      ${speciesChips ? `<div class="wp-species">${speciesChips}</div>` : ''}
      ${p.approx ? `<p class="tiny muted" style="margin-top:10px">${t('approx_note')}</p>` : ''}
    </div>`;
  $('#waypoint-card').classList.remove('hidden');
  $$('#wp-content .chip').forEach((chip) =>
    chip.onclick = () => { switchView('especies'); highlightSpecies(chip.dataset.species); });
}
function closeWaypoint() { $('#waypoint-card').classList.add('hidden'); state.openWaypointId = null; }

// ---------- geolocation ----------
function setGps(status, label) {
  const chip = $('#gps-chip'); if (!chip) return;   // header chip removed; button color is the cue
  chip.className = `gps-chip gps-${status}`; $('#gps-label').textContent = label || t('gps');
}
function locate() {
  if (state.watchId != null) { stopTracking(); return; }
  if (!('geolocation' in navigator)) { setGps('error', t('gps_unsupported')); toast(t('gps_unsupported')); return; }
  const localhost = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!window.isSecureContext && !localhost) toast(t('gps_insecure'));
  state.firstFix = false;
  setGps('searching', t('gps_searching'));
  $('#locate-btn').classList.add('tracking');
  navigator.geolocation.getCurrentPosition(onPosition, onGeoError, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 });
}
function stopTracking() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null; $('#locate-btn').classList.remove('tracking'); setGps('off', t('gps'));
}
function onPosition(pos) {
  const { longitude, latitude, accuracy } = pos.coords;
  state.userPos = [longitude, latitude];
  setGps('on', `±${Math.round(accuracy)} m`);
  const src = state.map && state.map.getSource('user');
  if (src) src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: state.userPos }, properties: {} }] });
  if (state.map) {
    if (!state.firstFix) { state.map.flyTo({ center: state.userPos, zoom: 17, duration: 900 }); state.firstFix = true; }
    else state.map.easeTo({ center: state.userPos, duration: 600 });
  }
  checkProximity();
}
function onGeoError(err) {
  const msg = err.code === 1 ? t('gps_denied') : err.code === 2 ? t('gps_unavailable') : t('gps_timeout');
  setGps('error', msg);
  if (err.code === 1) { stopTracking(); toast(t('gps_hint_denied')); } else toast(msg);
}
// ----- guided mode: follow the visitor and surface points as they approach -----
function startGuiding(id) {
  state.guiding = id;
  const built = buildRoutePath(id);
  if (built && state.map) state.map.easeTo({ center: built.path[0], zoom: 17.5, duration: 800 });
  if (state.watchId == null) locate();   // begin GPS follow (google-maps style)
  toast(t('guiding_on'));
  renderRouteInfo(state.routesById[id], built);
}
function stopGuiding() {
  const wasId = state.guiding;
  state.guiding = null;
  if (wasId) toast(t('guiding_off'));
  if (state.activeRoute) renderRouteInfo(state.routesById[state.activeRoute], buildRoutePath(state.activeRoute));
}

function checkProximity() {
  if (!state.userPos || !state.guiding) return;   // sólo durante un recorrido iniciado
  state.waypoints.forEach((wp) => {
    const id = wp.properties.id;
    if (!waypointVisible(wp)) return;   // only trigger points currently shown
    const d = haversine(state.userPos, wp.geometry.coordinates);
    if (d <= CONFIG.proximityMeters && !state.lastTriggered[id]) {
      state.lastTriggered[id] = true;
      toast('📍 ' + (L(wp.properties, 'title') || wp.properties.name));
      miniPopup(wp);   // arriving shows the small popup; visitor taps "Más info" to expand
    } else if (d > CONFIG.reTriggerMeters && state.lastTriggered[id]) state.lastTriggered[id] = false;
  });
}
let toastTimer = null;
function toast(msg) {
  const el = $('#proximity-toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3400);
}

// ---------- species ----------
let speciesFilter = 'all';
function renderSpeciesFilters() {
  const wrap = $('#species-filters');
  const opts = [['all', t('f_all')], ['flagship', t('f_flagship')], ['flora', t('f_flora')], ['ave', t('f_aves')], ['mamifero', t('f_mam')], ['anfibio', t('f_anf')]];
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
  return state.species.filter((s) => speciesFilter === 'all' ? true : speciesFilter === 'flagship' ? s.flagship : s.group === speciesFilter);
}
function renderSpeciesGrid(highlightId) {
  const grid = $('#species-grid'), list = filteredSpecies();
  $('#species-count').textContent = `${list.length} ${t('count_suffix')}`;
  grid.innerHTML = '';
  list.forEach((s) => {
    const card = document.createElement('div');
    card.className = `species-card ${s.flagship ? 'flagship' : ''} ${s.status === 'possible' ? 'status-possible' : ''}`;
    card.id = `sp-${s.id}`;
    const ph = primaryPhoto('species', s.id);
    card.classList.toggle('has-thumb', !!ph);
    card.innerHTML = `
      ${ph ? pictureTag(ph, 'sp-thumb', L(s, 'common_name')) : ''}
      ${s.flagship ? '<span class="star">★</span>' : ''}
      <p class="species-common">${L(s, 'common_name')}</p>
      <p class="species-sci">${s.scientific_name}</p>
      <p class="species-meta">${s.family}${s.status === 'possible' ? ' · ' + t('possible') : ''}</p>
      <span class="species-group-tag g-${s.group}">${t('grp_' + s.group)}</span>
      ${capturedBadge(s.id)}`;
    grid.appendChild(card);
  });
  if (highlightId) {
    const el = $(`#sp-${highlightId}`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid var(--sun)'; setTimeout(() => el.style.outline = '', 2000); }
  }
}
function highlightSpecies(id) {
  if (!state.species.find((x) => x.id === id)) return;
  speciesFilter = 'all'; renderSpeciesFilters(); renderSpeciesGrid(id);
}

// ---------- onboarding (primer arranque) ----------
function renderOnboarding() {
  $('#ob-title').textContent = t('ob_title');
  $('#ob-go').textContent = t('ob_go');
  $('#ob-tip').textContent = t('ob_tip');
  $('#ob-points').innerHTML = [
    ['🗺️', t('ob_p_map')], ['🦋', t('ob_p_species')], ['📶', t('ob_p_offline')],
  ].map(([e, txt]) => `<li><span class="ob-e">${e}</span>${txt}</li>`).join('');
  $$('#onboarding .ob-lang').forEach((b) => b.classList.toggle('sel', b.dataset.lang === LANG));
}
function showOnboarding() {
  const ob = $('#onboarding');
  renderOnboarding();
  ob.classList.remove('hidden');
  $$('#onboarding .ob-lang').forEach((b) => b.onclick = () => { setLang(b.dataset.lang); renderOnboarding(); });
  $('#ob-go').onclick = () => {
    localStorage.setItem('cantares_onboarded', '1');
    ob.classList.add('hidden');
    switchView('recorridos');
  };
}

// ---------- planea tu visita ----------
function renderVisitInfo() {
  const el = $('#visit-info');
  if (!el) return;
  const info = state.reserveInfo;
  if (!info) { el.innerHTML = ''; return; }
  const pending = `<span class="v-pending">${t('v_pending')}</span>`;
  const val = (field) => { const v = L(info, field); return v ? escapeHtml(v) : pending; };
  const phone = info.phone || '';
  const wa = (info.whatsapp || '').replace(/[^\d]/g, '');
  const contactBits = [];
  if (phone) contactBits.push(`<a class="v-link" href="tel:${escapeAttr(phone)}">${t('v_call')} ${escapeHtml(phone)}</a>`);
  if (wa) contactBits.push(`<a class="v-link" href="https://wa.me/${wa}" target="_blank" rel="noopener">${t('v_whatsapp')}</a>`);
  const contactHtml = contactBits.length ? contactBits.join(' · ') : pending;
  const rules = L(info, 'rules') || [];
  const emgLabel = L(info, 'emergency_national_label') || t('v_emergency');
  const emg = info.emergency_national || '123';

  el.innerHTML = `
    <div class="panel visit-panel">
      <h2>${t('visit_h')}</h2>
      <div class="v-grid">
        <div class="v-row"><span class="v-key">${t('v_hours')}</span><span class="v-v">${val('hours')}</span></div>
        <div class="v-row"><span class="v-key">${t('v_contact')}</span><span class="v-v">${contactHtml}</span></div>
        <div class="v-row"><span class="v-key">${t('v_arrive')}</span><span class="v-v">${val('how_to_arrive')}</span></div>
        <div class="v-row"><span class="v-key">${t('v_parking')}</span><span class="v-v">${val('parking')}</span></div>
        <div class="v-row"><span class="v-key">${t('v_entry')}</span><span class="v-v">${val('entry')}</span></div>
      </div>
    </div>
    ${rules.length ? `<div class="panel visit-panel">
      <h2>${t('v_rules_h')}</h2>
      <ul class="v-rules">${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    </div>` : ''}
    <div class="panel visit-panel v-safety">
      <h2>${t('v_safety_h')}</h2>
      <p class="v-lost"><strong>${t('v_lost')}:</strong> ${escapeHtml(L(info, 'if_lost') || '')}</p>
      <div class="v-emergency">
        <a class="v-emg-btn" href="tel:${escapeAttr(emg)}">🆘 ${escapeHtml(emgLabel)}: ${escapeHtml(emg)}</a>
        ${phone ? `<a class="v-emg-btn v-emg-reserve" href="tel:${escapeAttr(phone)}">📞 ${escapeHtml(phone)}</a>` : ''}
      </div>
    </div>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// ---------- navigation ----------
function switchView(name) {
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  $(`#view-${name}`).classList.add('is-active');
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === name));
  if (name === 'recorridos' && state.map) setTimeout(() => state.map.resize(), 60);
}

// ---------- restoration carbon ----------
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
function renderOfflineStatus() { $('#offline-status').innerHTML = navigator.onLine ? t('online') : t('offline'); }
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW', e); }
}

// ---------- legend ----------
function renderLegend() {
  const zones = ['conservacion', 'uso_intensivo', 'agroecosistema', 'transicion'];
  const off = !state.zonesVisible;
  const types = presentTypes();
  $('#legend-body').innerHTML = `
    <div class="lg-row"><span class="lg-line" style="background:#f4f1de"></span>${t('lg_trails')}</div>
    <div class="lg-row"><span class="lg-line" style="background:#e07a1f;height:4px"></span>${t('lg_route')}</div>
    <div class="lg-row"><span class="lg-dot" style="background:#2f9e44"></span>${t('lg_start')} · <span class="lg-dot" style="background:#e03131;margin-left:4px"></span>${t('lg_end')}</div>
    <div class="lg-sep">${t('lg_points_head')}</div>
    <div class="lg-types">
      ${types.map((tp) => {
        const m = typeMeta(tp), hidden = state.hiddenTypes.has(tp);
        return `<button class="lg-type ${hidden ? 'off' : ''}" data-type="${tp}">
          <span class="lg-dot" style="background:${m.color}"></span>${m.emoji} ${typeLabel(tp)}</button>`;
      }).join('')}
    </div>
    <div class="lg-sep lg-zones-head">${t('lg_zones')}
      <button id="zones-toggle" class="lg-eye" title="${t('lg_zones_toggle')}">${off ? '🚫' : '👁'}</button></div>
    <div id="lg-zone-rows" class="${off ? 'lg-dim' : ''}">
      ${zones.map((z) => `<div class="lg-row"><span class="lg-sw" style="background:${ZONE_COLORS[z]}"></span>${t('z_' + z)}</div>`).join('')}
    </div>`;
  const zt = $('#zones-toggle');
  if (zt) zt.onclick = toggleZones;
  $$('#legend-body .lg-type').forEach((b) => b.onclick = () => toggleType(b.dataset.type));
}
function toggleType(tp) {
  if (state.hiddenTypes.has(tp)) state.hiddenTypes.delete(tp); else state.hiddenTypes.add(tp);
  applyWaypointFilter();
  renderLegend();
  if (state.activeRoute) renderRouteInfo(state.routesById[state.activeRoute], buildRoutePath(state.activeRoute));
}
function toggleZones() {
  state.zonesVisible = !state.zonesVisible;
  const vis = state.zonesVisible ? 'visible' : 'none';
  const map = state.map;
  if (map && map.getLayer('zones-fill')) {
    map.setLayoutProperty('zones-fill', 'visibility', vis);
    map.setLayoutProperty('zones-line', 'visibility', vis);
  }
  renderLegend();
}

// ---------- draggable widgets (legend, imagery toggle) ----------
// Pointer Events (unified mouse/touch, works on iOS) + setPointerCapture so the
// widget tracks the finger 1:1. Positions are stored in the OFFSET-PARENT frame
// (el.offsetLeft/Top) — mixing viewport coords with left/top caused the widget
// to jump out from under the cursor. A small threshold keeps taps working.
function makeDraggable(el, handle, key, onTap) {
  const clampAndSet = (left, top) => {
    const parent = el.offsetParent || document.body;
    const maxX = parent.clientWidth - el.offsetWidth - 4;
    const maxY = parent.clientHeight - el.offsetHeight - 4;
    Object.assign(el.style, {
      left: Math.max(4, Math.min(maxX, left)) + 'px',
      top: Math.max(4, Math.min(maxY, top)) + 'px',
      right: 'auto', bottom: 'auto',
    });
  };
  const saved = key && localStorage.getItem(key);
  if (saved) { try { const p = JSON.parse(saved); clampAndSet(p.left, p.top); } catch (e) { /* ignore */ } }
  let sx, sy, startLeft, startTop, moved = false, dragging = false;
  const move = (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    if (e.cancelable) e.preventDefault();
    clampAndSet(startLeft + dx, startTop + dy);
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    if (moved && key) localStorage.setItem(key, JSON.stringify({ left: el.offsetLeft, top: el.offsetTop }));
    else if (!moved && onTap) onTap();
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    startLeft = el.offsetLeft; startTop = el.offsetTop;
    try { handle.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.style.touchAction = 'none';
}

// ---------- language ----------
function applyStaticI18n() {
  document.documentElement.lang = LANG;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  $('#lang-toggle').textContent = LANG === 'es' ? 'EN' : 'ES';
  $('#base-caption').textContent = t('base_forest_title');
  const bh = $('#base-hint'); if (bh) bh.textContent = t('base_forest_hint');
}
function setLang(lang) {
  LANG = lang; localStorage.setItem('cantares_lang', lang);
  applyStaticI18n(); renderRouteBar(); selectRoute(state.activeRoute);
  renderSpeciesFilters(); renderSpeciesGrid(); renderCarbon(); renderOfflineStatus(); renderLegend(); refreshGameUI(); renderVisitInfo();
  $('#base-year').textContent = baseLabel(CONFIG.baseStops[state.baseIndex]);
  if (state.openWaypointId) { const wp = state.waypoints.find((w) => w.properties.id === state.openWaypointId); if (wp) showWaypoint(wp); }
  if (state.watchId == null) setGps('off', t('gps'));
}

// ---------- init ----------
async function main() {
  $$('.tab').forEach((tab) => tab.onclick = () => switchView(tab.dataset.view));
  $('#wp-close').onclick = closeWaypoint;
  $('#inat-link').href = CONFIG.inatProjectUrl;
  $('#lang-toggle').onclick = () => setLang(LANG === 'es' ? 'en' : 'es');
  // Legend, imagery toggle and GPS button: draggable (tap still collapses / locates).
  makeDraggable($('#legend'), $('#legend-toggle'), 'cantares_pos_legend', () => $('#legend').classList.toggle('collapsed'));
  makeDraggable($('#base-slider-box'), $('#base-toggle'), 'cantares_pos_base', () => $('#base-slider-box').classList.toggle('collapsed'));
  makeDraggable($('#locate-btn'), $('#locate-btn'), 'cantares_pos_locate', locate);
  window.addEventListener('online', renderOfflineStatus);
  window.addEventListener('offline', renderOfflineStatus);

  // Register the PMTiles protocol (for an optional local orthophoto layer).
  if (window.pmtiles && maplibregl.addProtocol) {
    try { maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile); } catch (e) { /* already registered */ }
  }
  // Auto-add the orthophoto to the imagery slider IF the file exists (drop it at tiles/ortho.pmtiles).
  try {
    const r = await fetch('tiles/ortho.pmtiles', { method: 'HEAD' });
    if (r.ok) CONFIG.baseStops.push({ key: 'ortho', pmtiles: true });
  } catch (e) { /* no ortho yet */ }

  const slider = $('#base-slider');
  slider.max = String(CONFIG.baseStops.length - 1);
  slider.value = String(state.baseIndex);
  renderBaseTicks();
  let baseSwapTimer = null;
  slider.oninput = (e) => {
    const i = +e.target.value;
    $('#base-year').textContent = baseLabel(CONFIG.baseStops[i]);   // live year while dragging
    clearTimeout(baseSwapTimer);
    baseSwapTimer = setTimeout(() => setBaseLayer(i), 130);          // debounce the heavy layer swap
  };

  const [routesDoc, speciesDoc, reserveInfo, mediaDoc] = await Promise.all([
    loadJSON(CONFIG.data.routes), loadJSON(CONFIG.data.species),
    loadJSON(CONFIG.data.reserveInfo).catch(() => null),
    loadJSON(CONFIG.data.media).catch(() => null),
  ]);
  state.routes = routesDoc.routes;
  state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
  state.species = speciesDoc.species;
  state.reserveInfo = reserveInfo;
  state.media = indexMedia(mediaDoc);

  applyStaticI18n();
  renderRouteBar(); renderSpeciesFilters(); renderSpeciesGrid(); renderOfflineStatus(); renderCarbon(); renderLegend(); renderVisitInfo();
  $('#base-year').textContent = baseLabel(CONFIG.baseStops[state.baseIndex]);

  // El resto del arranque ocurre DESPUÉS de la puerta de entrada (login/invitado).
  const enterApp = async () => {
    await loadCloudData();                       // preferir datos de la nube (ediciones del admin)
    renderSpeciesFilters(); renderSpeciesGrid(); renderLegend();
    if (!localStorage.getItem('cantares_onboarded')) showOnboarding();
    await initGame({ state, t, L, toast, rerenderSpecies: () => renderSpeciesGrid(),
      cloud: { enabled: Cloud.cloudConfigured() && Cloud.isLoggedIn(), user: Cloud.currentUser(),
        addSighting: Cloud.addSighting, mySightings: Cloud.mySightings, uploadImage: Cloud.uploadImage } });
    if (!new URLSearchParams(location.search).has('nomap')) {
      await initMap();
      renderLegend(); applyWaypointFilter(); selectRoute(null);
      onStyleReady(state.map, () => { try { gameAddMapLayer(); } catch (e) { console.warn('gameAddMapLayer', e); } });
      initAdmin({ state, map: state.map, t, L, LANG, toast,
        typeColor: (tp) => typeMeta(tp).color, refreshWaypoints, refreshSpecies });
    }
    registerSW();
  };

  // Puerta de entrada: invitado / visitante (cuenta) / admin. Si la nube está
  // desactivada, entra directo (app igual que antes).
  await initAuthGate({ lang: LANG, onEnter: () => enterApp() });
}
main().catch((e) => { console.error(e); toast('Error: ' + e.message); });

// ---------- puente con la nube (datos + refresco tras editar) ----------
function cloudWaypointToFeature(r) {
  return { type: 'Feature', properties: {
    id: r.id, title: r.title, title_en: r.title_en, description: r.description, description_en: r.description_en,
    tipo: r.tipo || 'punto', routes: r.routes || [], species_ids: r.species_ids || [], photo: r.photo || null,
  }, geometry: { type: 'Point', coordinates: [r.lng, r.lat] } };
}
async function loadCloudData() {
  if (!Cloud.cloudConfigured()) return;
  try {
    const [cw, cs] = await Promise.all([Cloud.listWaypoints().catch(() => null), Cloud.listSpecies().catch(() => null)]);
    if (cw && cw.length) { const fc = { type: 'FeatureCollection', features: cw.map(cloudWaypointToFeature) }; normalizeFeatures(fc); state.waypoints = fc.features; }
    if (cs && cs.length) state.species = cs;
  } catch (e) { console.warn('[cloud] datos', e && e.message); }
}
async function refreshWaypoints() {
  if (!Cloud.cloudConfigured()) return;
  const cw = await Cloud.listWaypoints();
  const fc = { type: 'FeatureCollection', features: cw.map(cloudWaypointToFeature) };
  normalizeFeatures(fc); state.waypoints = fc.features;
  const src = state.map && state.map.getSource('waypoints'); if (src) src.setData(fc);
  renderLegend(); applyWaypointFilter();
  if (state.activeRoute) selectRoute(state.activeRoute);
}
async function refreshSpecies() {
  if (!Cloud.cloudConfigured()) return;
  state.species = await Cloud.listSpecies();
  renderSpeciesFilters(); renderSpeciesGrid();
}

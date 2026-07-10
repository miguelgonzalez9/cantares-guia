// Cantares — Guía interactiva de la reserva / Interactive reserve guide
// Minimal-vanilla PWA. Globals `maplibregl` and `pmtiles` come from vendored scripts.

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
  lastTriggered: {}, openWaypointId: null, baseIndex: 2, zonesVisible: true,
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
    legend: 'Leyenda', lg_trails: 'Senderos', lg_route: 'Recorrido activo', lg_start: 'Inicio', lg_end: 'Fin',
    lg_point: 'Punto clave', lg_zones: 'Zonas de manejo', lg_zones_toggle: 'Mostrar/ocultar zonas',
    z_conservacion: 'Conservación', z_uso_intensivo: 'Uso intensivo', z_agroecosistema: 'Agrosistema', z_transicion: 'Transición',
    base_label: 'Imagen satelital', base_hd: 'Actual (HD)', base_ortho: 'Ortofoto',
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
    map_illus: 'Mapa ilustrado de senderos',
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
    legend: 'Legend', lg_trails: 'Trails', lg_route: 'Active route', lg_start: 'Start', lg_end: 'End',
    lg_point: 'Key point', lg_zones: 'Management zones', lg_zones_toggle: 'Show/hide zones',
    z_conservacion: 'Conservation', z_uso_intensivo: 'Intensive use', z_agroecosistema: 'Agrosystem', z_transicion: 'Transition',
    base_label: 'Satellite image', base_hd: 'Current (HD)', base_ortho: 'Orthophoto',
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
    map_illus: 'Illustrated trail map',
    grp_flora: 'Plants', grp_ave: 'Birds', grp_mamifero: 'Mammals',
    online: '🟢 Online. Open the map here (wifi) to cache tiles, then it works with no signal on the trail.',
    offline: '⚪ Offline. The app and cached content are still available.',
    demo_note: 'DEMO figures. Replace <code>inputs/inventory/key_trees.csv</code> and run <code>data_prep/05_carbon_allometry.R</code>.',
    key_trees: 'key trees', agb: 'above-ground biomass',
  },
};
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

const ZONE_COLORS = { conservacion: '#1b4332', uso_intensivo: '#b5651d', agroecosistema: '#a3b18a', transicion: '#52796f' };
const zoneMatch = (prop) => ['match', ['get', 'zona'],
  'conservacion', ZONE_COLORS.conservacion, 'uso_intensivo', ZONE_COLORS.uso_intensivo,
  'agroecosistema', ZONE_COLORS.agroecosistema, 'transicion', ZONE_COLORS.transicion, '#888'];

async function initMap() {
  const [boundary, zones, trails, waypointsFC] = await Promise.all([
    loadJSON(CONFIG.data.boundary), loadJSON(CONFIG.data.zones),
    loadJSON(CONFIG.data.trails), loadJSON(CONFIG.data.waypoints),
  ]);
  normalizeFeatures(trails); normalizeFeatures(waypointsFC);   // tolerate QGIS text fields
  state.waypoints = waypointsFC.features;
  state.trails = trails.features;

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
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones',
        paint: { 'fill-color': zoneMatch(), 'fill-opacity': 0.22 } });
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
        paint: { 'line-color': zoneMatch(), 'line-width': 1, 'line-opacity': 0.5 } });
      // boundary
      map.addSource('boundary', { type: 'geojson', data: boundary });
      map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
        paint: { 'line-color': '#fff', 'line-width': 3, 'line-dasharray': [2, 1.4] } });
      // trails — all as neutral lines, plus a highlighted layer + direction arrows
      map.addSource('trails', { type: 'geojson', data: trails });
      map.addLayer({ id: 'trails-all', type: 'line', source: 'trails',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f4f1de', 'line-width': 2.2, 'line-opacity': 0.85 } });
      map.addLayer({ id: 'trails-hl', type: 'line', source: 'trails', filter: ['==', 'id', '___none___'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#e07a1f', 'line-width': 5 } });
      map.addLayer({ id: 'trails-arrows', type: 'symbol', source: 'trails', filter: ['==', 'id', '___none___'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 55, 'icon-image': 'arrow',
          'icon-size': 0.8, 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
      // route start/end markers
      map.addSource('route-ends', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'route-ends', type: 'circle', source: 'route-ends',
        paint: { 'circle-radius': 8,
          'circle-color': ['match', ['get', 'kind'], 'start', '#2f9e44', 'end', '#e03131', '#888'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
      // waypoints
      map.addSource('waypoints', { type: 'geojson', data: waypointsFC });
      map.addLayer({ id: 'waypoints-pt', type: 'circle', source: 'waypoints',
        paint: { 'circle-radius': 6.5, 'circle-color': '#ffd166',
          'circle-stroke-color': '#7a4b12', 'circle-stroke-width': 2 } });
      // user
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

function routeEndpoints(id) {
  // Pick the two vertices farthest apart among this route's segments as start/end.
  const verts = [];
  state.trails.forEach((tr) => {
    if ((tr.properties.routes || []).includes(id)) {
      const cs = tr.geometry.coordinates;
      verts.push(cs[0], cs[cs.length - 1]);
    }
  });
  if (verts.length < 2) return { type: 'FeatureCollection', features: [] };
  let best = [verts[0], verts[1]], bestD = -1;
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++) {
      const d = haversine(verts[i], verts[j]);
      if (d > bestD) { bestD = d; best = [verts[i], verts[j]]; }
    }
  // Start = endpoint nearest the "Entrada" landmark (fallback: lower latitude)
  const entrada = state.waypoints.find((w) => w.properties.id === 'portada');
  let [a, b] = best;
  const startFirst = entrada
    ? haversine(a, entrada.geometry.coordinates) <= haversine(b, entrada.geometry.coordinates)
    : a[1] < b[1];
  const [s, e] = startFirst ? [a, b] : [b, a];
  return { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: s } },
    { type: 'Feature', properties: { kind: 'end' }, geometry: { type: 'Point', coordinates: e } },
  ] };
}

// Name of the waypoint of this route nearest to a coordinate (for start/end labels).
function nearestRouteWaypoint(coord, id) {
  let best = null, bd = Infinity;
  state.waypoints.forEach((w) => {
    const rts = w.properties.routes || [];
    if (rts.length && !rts.includes(id)) return;   // route's points + always-on landmarks
    const d = haversine(coord, w.geometry.coordinates);
    if (d < bd) { bd = d; best = w; }
  });
  return best ? (L(best.properties, 'title') || best.properties.name) : null;
}

function selectRoute(id) {
  state.activeRoute = id;
  const route = id ? state.routesById[id] : null;
  renderRouteBar();

  const ends = id ? routeEndpoints(id) : { type: 'FeatureCollection', features: [] };
  const map = state.map;
  if (map && map.getLayer && map.getLayer('trails-hl')) {
    if (id) {
      const hlFilter = ['in', id, ['get', 'routes']];
      map.setFilter('trails-hl', hlFilter);
      map.setFilter('trails-arrows', hlFilter);
      map.setPaintProperty('trails-hl', 'line-color', route.color);
      map.getSource('route-ends').setData(ends);
      map.setFilter('waypoints-pt', ['any', ['in', id, ['get', 'routes']], ['==', ['length', ['get', 'routes']], 0]]);
    } else {
      map.setFilter('trails-hl', ['==', 'id', '___none___']);
      map.setFilter('trails-arrows', ['==', 'id', '___none___']);
      map.getSource('route-ends').setData({ type: 'FeatureCollection', features: [] });
      map.setFilter('waypoints-pt', null);
    }
  }

  const info = $('#route-info');
  if (route) {
    const sf = ends.features.find((f) => f.properties.kind === 'start');
    const ef = ends.features.find((f) => f.properties.kind === 'end');
    const sn = sf ? nearestRouteWaypoint(sf.geometry.coordinates, id) : null;
    const en = ef ? nearestRouteWaypoint(ef.geometry.coordinates, id) : null;
    info.classList.remove('hidden');
    info.style.borderLeftColor = route.color;
    info.innerHTML = `
      <button class="ri-close" id="ri-close" aria-label="Cerrar">×</button>
      <h3>${route.emoji} ${L(route, 'name')}</h3>
      <p>${L(route, 'summary')}</p>
      ${(sn || en) ? `<div class="ri-ends">
        ${sn ? `<span class="ri-end-item"><span class="ri-dot start"></span>${t('lg_start')}: ${sn}</span>` : ''}
        ${en ? `<span class="ri-end-item"><span class="ri-dot end"></span>${t('lg_end')}: ${en}</span>` : ''}
      </div>` : ''}`;
    $('#ri-close').onclick = () => info.classList.add('hidden');
  } else info.classList.add('hidden');
}

// ---------- waypoint card ----------
const ROUTE_COLORS = { agua: '#2b8cbe', aves: '#d94801', arboles: '#238b45',
  flora: '#c2255c', paisaje: '#1098ad', regeneracion: '#6a4c93', nocturno: '#3b5bdb' };
function routeLabel(rid) {
  const r = state.routesById[rid];
  return r ? L(r, 'name') : rid;
}
function showWaypoint(wp) {
  if (!wp) return;
  const p = wp.properties;
  state.openWaypointId = p.id;
  const badges = (p.routes || []).map((rid) =>
    `<span class="badge" style="background:${ROUTE_COLORS[rid] || '#5b6b60'}">${routeLabel(rid)}</span>`).join('');
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
    ${p.approx ? `<p class="tiny muted" style="margin-top:10px">${t('approx_note')}</p>` : ''}`;
  $('#waypoint-card').classList.remove('hidden');
  $$('#wp-content .chip').forEach((chip) =>
    chip.onclick = () => { switchView('especies'); highlightSpecies(chip.dataset.species); });
}
function closeWaypoint() { $('#waypoint-card').classList.add('hidden'); state.openWaypointId = null; }

// ---------- geolocation ----------
function setGps(status, label) { $('#gps-chip').className = `gps-chip gps-${status}`; $('#gps-label').textContent = label || t('gps'); }
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
function checkProximity() {
  if (!state.userPos) return;
  state.waypoints.forEach((wp) => {
    const id = wp.properties.id;
    if (state.activeRoute) {
      const rts = wp.properties.routes || [];
      if (rts.length && !rts.includes(state.activeRoute)) return;
    }
    const d = haversine(state.userPos, wp.geometry.coordinates);
    if (d <= CONFIG.proximityMeters && !state.lastTriggered[id]) {
      state.lastTriggered[id] = true;
      toast('📍 ' + (L(wp.properties, 'title') || wp.properties.name));
      showWaypoint(wp);
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
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid var(--sun)'; setTimeout(() => el.style.outline = '', 2000); }
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
  $('#legend-body').innerHTML = `
    <div class="lg-row"><span class="lg-line" style="background:#f4f1de"></span>${t('lg_trails')}</div>
    <div class="lg-row"><span class="lg-line" style="background:#e07a1f;height:4px"></span>${t('lg_route')}</div>
    <div class="lg-row"><span class="lg-dot" style="background:#2f9e44"></span>${t('lg_start')} · <span class="lg-dot" style="background:#e03131;margin-left:4px"></span>${t('lg_end')}</div>
    <div class="lg-row"><span class="lg-dot" style="background:#ffd166;border-color:#7a4b12"></span>${t('lg_point')}</div>
    <div class="lg-sep lg-zones-head">${t('lg_zones')}
      <button id="zones-toggle" class="lg-eye" title="${t('lg_zones_toggle')}">${off ? '🚫' : '👁'}</button></div>
    <div id="lg-zone-rows" class="${off ? 'lg-dim' : ''}">
      ${zones.map((z) => `<div class="lg-row"><span class="lg-sw" style="background:${ZONE_COLORS[z]}"></span>${t('z_' + z)}</div>`).join('')}
    </div>`;
  const zt = $('#zones-toggle');
  if (zt) zt.onclick = toggleZones;
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

// ---------- language ----------
function applyStaticI18n() {
  document.documentElement.lang = LANG;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  $('#lang-toggle').textContent = LANG === 'es' ? 'EN' : 'ES';
  $('#base-caption').textContent = t('base_label');
}
function setLang(lang) {
  LANG = lang; localStorage.setItem('cantares_lang', lang);
  applyStaticI18n(); renderRouteBar(); selectRoute(state.activeRoute);
  renderSpeciesFilters(); renderSpeciesGrid(); renderCarbon(); renderOfflineStatus(); renderLegend();
  $('#base-year').textContent = baseLabel(CONFIG.baseStops[state.baseIndex]);
  if (state.openWaypointId) { const wp = state.waypoints.find((w) => w.properties.id === state.openWaypointId); if (wp) showWaypoint(wp); }
  if (state.watchId == null) setGps('off', t('gps'));
}

// ---------- init ----------
async function main() {
  $$('.tab').forEach((tab) => tab.onclick = () => switchView(tab.dataset.view));
  $('#wp-close').onclick = closeWaypoint;
  $('#locate-btn').onclick = locate;
  $('#inat-link').href = CONFIG.inatProjectUrl;
  $('#lang-toggle').onclick = () => setLang(LANG === 'es' ? 'en' : 'es');
  $('#legend-toggle').onclick = () => $('#legend').classList.toggle('collapsed');
  $('#base-toggle').onclick = () => $('#base-slider-box').classList.toggle('collapsed');
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

  const [routesDoc, speciesDoc] = await Promise.all([loadJSON(CONFIG.data.routes), loadJSON(CONFIG.data.species)]);
  state.routes = routesDoc.routes;
  state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
  state.species = speciesDoc.species;

  applyStaticI18n();
  renderRouteBar(); renderSpeciesFilters(); renderSpeciesGrid(); renderOfflineStatus(); renderCarbon(); renderLegend();
  $('#base-year').textContent = baseLabel(CONFIG.baseStops[state.baseIndex]);

  if (!new URLSearchParams(location.search).has('nomap')) {
    await initMap();
    selectRoute(null);
  }
  registerSW();
}
main().catch((e) => { console.error(e); toast('Error: ' + e.message); });

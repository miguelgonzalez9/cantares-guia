// Cantares — Guía interactiva de la reserva / Interactive reserve guide
// Minimal-vanilla PWA. Globals `maplibregl` and `pmtiles` come from vendored scripts.

import { GAME_I18N, initGame, refreshGameUI, capturedBadge, gameAddMapLayer, accountSummary, capturedPhotos } from './game.js';
import * as Cloud from './cloud.js';
import { initAuthGate, doLogout } from './auth-ui.js';
import { initAdmin, openSpeciesEditor, downloadPhoto, isAdminUser, focusFromMap as adminFocusFromMap, openPointEditor } from './admin.js';
import { initRecorder, listWalks, walkCardHTML, downloadWalk, startWalk, stopWalk, isRecording, openHistory } from './recorder.js';
import { initSync, pendingOps } from './sync.js';
import { keepAwake, releaseAwake } from './wakelock.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const CONFIG = {
  center: [-75.4503, 5.0818], zoom: 15.6,
  maxBounds: [[-75.462, 5.072], [-75.439, 5.092]],
  proximityMeters: 25, reTriggerMeters: 60,
  inatProjectUrl: 'https://www.inaturalist.org/projects/reserva-natural-cantares',
  data: {
    boundary: 'data/boundary.geojson', zones: 'data/zones.geojson',
    trails: 'data/trails.geojson', waypoints: 'data/waypoints.geojson',
    trees: 'data/trees.geojson',
    routes: 'data/routes.json', species: 'data/species.json',
    reserveInfo: 'data/reserve_info.json', media: 'data/media.json',
    speciesGroups: 'data/species_groups.json',
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
  staticWaypoints: [], staticSpecies: [],   // respaldos para el merge con la nube
  activeRoute: null, userPos: null, watchId: null, userAccuracy: null, firstFix: false,
  lastTriggered: {}, openWaypointId: null, baseIndex: 2, zonesVisible: false,
  reserveInfo: null, media: { bySubject: {} }, boundary: null,
  hiddenTypes: new Set(),   // tipos de punto ocultados por el usuario
  guiding: null,            // id del recorrido en modo "seguir" (GPS)
  flowTimer: null,          // animación de flechas/flujo sobre el recorrido
  eleCache: {},             // desnivel por recorrido (cache de la API de elevación)
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
  arbol:        { emoji: '🌳', color: '#1b7a3a', es: 'Árboles',       en: 'Trees' },
  punto:        { emoji: '📍', color: '#5b6b60', es: 'Otros puntos',  en: 'Other points' },
};
const typeMeta = (tp) => TYPE_META[tp] || TYPE_META.punto;
const typeLabel = (tp) => { const m = typeMeta(tp); return LANG === 'en' ? m.en : m.es; };
// Tipos personalizados que añade el admin. Se guardan en el dispositivo y se
// funden en TYPE_META, de modo que leyenda, coloreado del mapa y editor comparten
// UNA sola lista (no dos paralelas). Nota: por ahora son por-dispositivo (aún no
// hay tabla en la nube para tipos).
function loadCustomTypes() {
  try { const raw = JSON.parse(localStorage.getItem('cantares_types') || '{}');
    Object.entries(raw).forEach(([k, v]) => { if (k && v && !TYPE_META[k]) TYPE_META[k] = v; });
  } catch (e) { /* json corrupto: ignorar */ }
}
loadCustomTypes();
// Registra un tipo nuevo y refresca mapa + leyenda al vuelo. def: {tipo,emoji,color,es,en}.
function registerPointType(def) {
  const tp = String(def && def.tipo || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!tp) return null;
  TYPE_META[tp] = { emoji: def.emoji || '📍', color: def.color || '#5b6b60', es: def.es || tp, en: def.en || def.es || tp };
  try { const raw = JSON.parse(localStorage.getItem('cantares_types') || '{}'); raw[tp] = TYPE_META[tp]; localStorage.setItem('cantares_types', JSON.stringify(raw)); } catch (e) { /* almacenamiento lleno */ }
  const map = state.map;
  if (map && map.getLayer('waypoints-pt')) { try { map.setPaintProperty('waypoints-pt', 'circle-color', typeColorMatch()); } catch (e) { /* estilo no listo */ } }
  renderLegend();
  return tp;
}
// Distinct tipos present in the loaded waypoints, in a stable, meaningful order.
function presentTypes() {
  const order = Object.keys(TYPE_META);
  const seen = new Set(state.waypoints.map((w) => w.properties.tipo || 'punto'));
  return order.filter((t) => seen.has(t));
}

// ---------- media (fotos + videos de especies y puntos) ----------
// Dos fuentes se combinan en un registro canónico: (1) las fotos curadas de
// build-time (media.json: campos file/jpg/thumb, WebP) y (2) la tabla `media`
// de la nube (campos url/kind/focal…, subida por admin/visitantes). normMedia
// las lleva a la misma forma para que las galerías, la portada y los videos las
// rendericen igual.
function normMedia(r) {
  const isCloud = !!r.url;
  const full = r.url || r.jpg || r.file || '';
  const thumb = r.thumb || full;
  return {
    id: r.id || full,
    kind: r.kind || 'photo',                 // 'photo' | 'video'
    full, thumb, poster: r.poster || null,
    webpThumb: (!isCloud && r.file) ? (r.thumb || r.file) : null,   // <picture> WebP (pipeline estático)
    jpgThumb: (!isCloud && r.jpg) ? r.jpg : thumb,
    is_primary: r.is_primary === true,
    sort: r.sort != null ? r.sort : 0,
    focal_x: r.focal_x != null ? r.focal_x : 0.5,
    focal_y: r.focal_y != null ? r.focal_y : 0.5,
    caption: r.caption || '', caption_en: r.caption_en || '',
    credit: r.credit || '', license: r.license || '',
    subject_type: r.subject_type || null, subject_id: r.subject_id || null,
    source: r.source || (isCloud ? 'cloud' : 'curated'),
    status: r.status || ((r.subject_type && r.subject_id) ? 'classified' : (isCloud ? 'unclassified' : 'classified')),
  };
}
function indexMedia(doc, cloud) {
  const all = [];
  ((doc && doc.photos) || []).forEach((p) => all.push(normMedia(p)));
  (cloud || []).forEach((r) => all.push(normMedia(r)));
  const bySubject = {}, byId = {}, unclassified = [];
  all.forEach((m) => {
    byId[m.id] = m;
    if (m.subject_type && m.subject_id && m.status !== 'unclassified') {
      const k = `${m.subject_type}:${m.subject_id}`;
      (bySubject[k] = bySubject[k] || []).push(m);
    } else unclassified.push(m);
  });
  // portada primero, luego por 'sort'
  Object.values(bySubject).forEach((arr) => arr.sort((a, b) => (b.is_primary - a.is_primary) || (a.sort - b.sort)));
  return { bySubject, byId, unclassified, all };
}
// Combina la tabla `media` de la nube SOBRE las fotos estáticas (reindexa todo).
function applyCloudMedia(cm) {
  state.cloudMedia = cm || [];
  state.media = indexMedia(state.staticMedia, state.cloudMedia);
}
function photosFor(type, id) { return state.media.bySubject[`${type}:${id}`] || []; }
function primaryPhoto(type, id) { const a = photosFor(type, id); return a[0] || null; }
// <picture>/<video> con recorte por punto focal (focal_x/y → object-position).
function pictureTag(ph, cls, alt) {
  if (!ph) return '';
  const pos = `object-position:${(ph.focal_x * 100).toFixed(1)}% ${(ph.focal_y * 100).toFixed(1)}%`;
  const a = (alt || '').replace(/"/g, '&quot;');
  if (ph.kind === 'video') {
    return `<video class="${cls}" src="${ph.full}" ${ph.poster ? `poster="${ph.poster}"` : ''} muted loop playsinline preload="metadata" style="${pos}"></video>`;
  }
  const src = ph.jpgThumb || ph.thumb || ph.full;
  return `<picture class="${cls}">${ph.webpThumb ? `<source srcset="${ph.webpThumb}" type="image/webp">` : ''}` +
    `<img src="${src}" alt="${a}" loading="lazy" style="${pos}"></picture>`;
}
// Media a tamaño grande (galería/ampliada): usa la versión full, no la miniatura.
function mediaFullTag(m, cls, alt) {
  const pos = `object-position:${(m.focal_x * 100).toFixed(1)}% ${(m.focal_y * 100).toFixed(1)}%`;
  const a = (alt || m.caption || '').replace(/"/g, '&quot;');
  if (m.kind === 'video') {
    return `<video class="${cls}" src="${m.full}" ${m.poster ? `poster="${m.poster}"` : ''} controls muted playsinline preload="metadata" style="${pos}"></video>`;
  }
  return `<img class="${cls}" src="${m.full}" alt="${a}" loading="lazy" style="${pos}">`;
}

// ---------- i18n ----------
const I18N = {
  es: {
    subtitle: 'Reserva Natural', tab_recorridos: 'Recorridos', tab_restauracion: 'Restauración',
    tab_especies: 'Especies', tab_info: 'Info', tab_cuenta: 'Cuenta', all_routes: 'Todos',
    dash_guest: 'Invitado', dash_guest_sub: 'Sin cuenta — tu progreso solo vive en este dispositivo',
    dash_visitor: 'Visitante', dash_admin: 'Administrador', dash_logout: 'Cerrar sesión',
    dash_create: 'Crear cuenta / entrar', dash_walks: 'recorridos', dash_dist: 'distancia',
    dash_species: 'especies', dash_points: 'puntos', dash_walks_h: 'Mis recorridos',
    dash_photos_h: 'Mis fotos', dash_no_walks: 'Aún no has grabado recorridos.',
    dash_no_photos: 'Aún no has tomado fotos de especies.',
    gps: 'GPS', gps_searching: 'Buscando…', gps_denied: 'Permiso denegado', gps_unavailable: 'Sin señal',
    gps_timeout: 'Sin respuesta', gps_unsupported: 'GPS no disponible', gps_insecure: 'El GPS requiere HTTPS',
    gps_hint_denied: 'Activa el permiso de ubicación para este sitio en el navegador.',
    approx_note: 'Posición aproximada — se reemplaza con el punto GPS real.',
    more_info: 'Más información', sample_photo: 'foto de muestra',
    legend: 'Leyenda', lg_trails: 'Senderos', lg_route: 'Recorrido activo', lg_start: 'Inicio', lg_end: 'Fin',
    lg_point: 'Punto clave', lg_zones: 'Zonas de manejo', lg_zones_toggle: 'Mostrar/ocultar zonas',
    lg_trees_layer: 'Árboles del inventario', lg_trees_toggle: 'Mostrar/ocultar árboles',
    lg_trees_hint: 'Censo georreferenciado 2021. Acércate para verlos y tócalos.',
    tree_note: 'Árbol del inventario de Cantares (censo 2021)', tree_tag: 'N.º',
    search_none: 'Sin resultados. Escribe el nombre de un punto.',
    nav_how: 'Cómo llegar', nav_locating: 'Buscando tu ubicación…', nav_need_gps: 'Activa el GPS para trazar la ruta.',
    nav_by_trail: 'por los senderos', nav_direct: 'en línea recta', nav_follow: '▶ Seguir',
    free_walk: 'Recorrido libre', free_stop: 'Terminar', my_walks: 'Mis recorridos',
    sp_here_1: 'lugar en la reserva', sp_here_n: 'lugares en la reserva', sp_nowhere: 'Aún sin puntos asociados en el mapa',
    sp_edit: 'Editar', sp_dl: 'Descargar foto', sp_new: 'Nueva especie',
    tree_photo: 'Árbol', leaf_photo: 'Hoja',
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
    ndvi_pending: 'Próximamente: el gráfico del reverdecimiento de la reserva medido por satélite (2019 → hoy).',
    guiding_confirm_end: '¿Terminar el recorrido guiado?',
    guiding_screen: '🔆 La pantalla quedará encendida durante el recorrido',
    guiding_screen_warn: '⚠️ Mantén la pantalla encendida: si se apaga, se pierden los avisos de los puntos',
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
    fact_bio: 'Biodiversidad', fact_bio_v: '~160 especies de aves (12% de Colombia), 15 colibríes, orquídeas y felinos como el puma',
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
    demo_note: 'Cifras preliminares de demostración — pronto con el inventario real de árboles de la reserva.',
    key_trees: 'árboles clave', agb: 'biomasa aérea',
  },
  en: {
    subtitle: 'Nature Reserve', tab_recorridos: 'Trails', tab_restauracion: 'Restoration',
    tab_especies: 'Species', tab_info: 'Info', tab_cuenta: 'Account', all_routes: 'All',
    dash_guest: 'Guest', dash_guest_sub: 'No account — your progress stays only on this device',
    dash_visitor: 'Visitor', dash_admin: 'Administrator', dash_logout: 'Log out',
    dash_create: 'Sign up / log in', dash_walks: 'walks', dash_dist: 'distance',
    dash_species: 'species', dash_points: 'points', dash_walks_h: 'My walks',
    dash_photos_h: 'My photos', dash_no_walks: "You haven't recorded any walks yet.",
    dash_no_photos: "You haven't taken any species photos yet.",
    gps: 'GPS', gps_searching: 'Locating…', gps_denied: 'Permission denied', gps_unavailable: 'No signal',
    gps_timeout: 'Timed out', gps_unsupported: 'GPS unavailable', gps_insecure: 'GPS needs HTTPS',
    gps_hint_denied: 'Enable location permission for this site in your browser.',
    approx_note: 'Approximate position — to be replaced by the real GPS point.',
    more_info: 'More info', sample_photo: 'sample photo',
    legend: 'Legend', lg_trails: 'Trails', lg_route: 'Active route', lg_start: 'Start', lg_end: 'End',
    lg_point: 'Key point', lg_zones: 'Management zones', lg_zones_toggle: 'Show/hide zones',
    lg_trees_layer: 'Tree inventory', lg_trees_toggle: 'Show/hide trees',
    lg_trees_hint: 'Georeferenced 2021 census. Zoom in to see and tap them.',
    tree_note: 'Tree from the Cantares inventory (2021 census)', tree_tag: 'No.',
    search_none: 'No results. Type a point name.',
    nav_how: 'Get there', nav_locating: 'Finding your location…', nav_need_gps: 'Turn on GPS to draw the route.',
    nav_by_trail: 'along the trails', nav_direct: 'straight line', nav_follow: '▶ Follow',
    free_walk: 'Free walk', free_stop: 'Finish', my_walks: 'My walks',
    sp_here_1: 'spot in the reserve', sp_here_n: 'spots in the reserve', sp_nowhere: 'No map points linked yet',
    sp_edit: 'Edit', sp_dl: 'Download photo', sp_new: 'New species',
    tree_photo: 'Tree', leaf_photo: 'Leaf',
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
    ndvi_pending: 'Coming soon: a satellite-measured greening chart of the reserve (2019 → today).',
    guiding_confirm_end: 'End the guided route?',
    guiding_screen: '🔆 The screen will stay on during the route',
    guiding_screen_warn: '⚠️ Keep the screen on: if it turns off, point alerts stop',
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
    fact_bio: 'Biodiversity', fact_bio_v: '~160 bird species (12% of Colombia), 15 hummingbirds, orchids and cats such as the puma',
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
    demo_note: 'Preliminary demo figures — the real tree inventory of the reserve is coming soon.',
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
// Longitud de una polilínea [[lng,lat],...] en metros, y formateo.
function pathLengthM(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 2) + ' km' : Math.round(m) + ' m'; }
// Distancia acumulada hasta el vértice del path más cercano a `coord` (para
// ordenar los puntos clave en el sentido en que se recorre el sendero).
function pathPos(path, coord) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < path.length; i++) { const d = haversine(coord, path[i]); if (d < bd) { bd = d; bi = i; } }
  let cum = 0; for (let i = 1; i <= bi; i++) cum += haversine(path[i - 1], path[i]);
  return cum;
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
  // Trails: de la nube si ya vinieron (ediciones del admin), si no del estático.
  let trails;
  if (state.trails.length) { trails = { type: 'FeatureCollection', features: state.trails }; }
  else { trails = await loadJSON(CONFIG.data.trails); normalizeFeatures(trails); state.trails = trails.features; }
  // Waypoints (curados + árboles) ya se cargaron en main() y se fusionaron con la nube.
  const waypointsFC = { type: 'FeatureCollection', features: state.waypoints };
  state.boundary = boundary;   // para la imagen descargable del historial de recorridos

  const map = new maplibregl.Map({
    container: 'map', style: buildStyle(), center: CONFIG.center, zoom: CONFIG.zoom,
    maxBounds: CONFIG.maxBounds, attributionControl: { compact: true },
  });
  // Panear con el dedo suspende el seguimiento GPS (el mapa deja de "pelear"
  // por recentrarse); un tap en ◎ lo reactiva.
  map.on('dragstart', () => { state.following = false; });
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
      // Ruta "cómo llegar" (desde tu ubicación al punto elegido) — línea dorada.
      map.addSource('nav-route', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'nav-route-casing', type: 'line', source: 'nav-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fff', 'line-width': 8, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'nav-route-line', type: 'line', source: 'nav-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fab814', 'line-width': 5 } });
      // Un SOLO source para todos los puntos (curados + árboles del inventario);
      // los árboles son waypoints tipo 'arbol' (editables, con foto, linkeables).
      map.addSource('waypoints', { type: 'geojson', data: waypointsFC });
      // Puntos curados (todo lo que NO es árbol): visibles a cualquier zoom.
      map.addLayer({ id: 'waypoints-pt', type: 'circle', source: 'waypoints',
        filter: ['!=', ['get', 'tipo'], 'arbol'],
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4.5, 17, 6.5, 19, 8.5],
          'circle-color': typeColorMatch(), 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
      // Árboles del inventario: mismo source, sólo desde zoom 15.5 (evita amontonar
      // ~200 puntos) y ocultables con el toggle 'arbol' de la leyenda.
      map.addLayer({ id: 'trees-pt', type: 'circle', source: 'waypoints', minzoom: 15.5,
        filter: ['==', ['get', 'tipo'], 'arbol'],
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15.5, 3, 18, 5.5, 20, 7],
          'circle-color': TYPE_META.arbol.color, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2 } });
      // user — el halo representa la PRECISIÓN del GPS (radio real en metros),
      // como Google Maps; su radio en píxeles se recalcula al moverse/hacer zoom.
      map.addSource('user', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'user-acc', type: 'circle', source: 'user',
        paint: { 'circle-radius': 0, 'circle-color': '#2b8cbe', 'circle-opacity': 0.15,
          'circle-stroke-color': '#2b8cbe', 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.35 } });
      map.addLayer({ id: 'user-dot', type: 'circle', source: 'user',
        paint: { 'circle-radius': 7, 'circle-color': '#2b8cbe', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
      map.on('zoom', updateAccuracyCircle);

      // Tap/hover: en móvil los puntos son pequeños y densos, así que en vez de
      // depender del hit exacto del círculo, buscamos en un RECUADRO alrededor del
      // toque (±14 px) y abrimos el más cercano. Esto arregla el "toca muchas veces".
      const HIT = 14;
      const wpById2 = (id) => state.waypoints.find((w) => w.properties.id === id);
      const nearestAt = (pt) => {
        const box = [[pt.x - HIT, pt.y - HIT], [pt.x + HIT, pt.y + HIT]];
        const layers = ['waypoints-pt', 'trees-pt'].filter((l) => map.getLayer(l));
        const feats = map.queryRenderedFeatures(box, { layers });
        if (!feats.length) return null;
        let best = null, bestD = Infinity;
        for (const f of feats) {
          const p = map.project(f.geometry.coordinates);
          const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
          if (d < bestD) { bestD = d; best = f; }
        }
        return best ? wpById2(best.properties.id) : null;
      };
      const setCursor = (e) => { map.getCanvas().style.cursor = nearestAt(e.point) ? 'pointer' : ''; };
      map.on('mousemove', (e) => { if (canHover) setCursor(e); });
      map.on('click', (e) => {
        // En modo edición manda el admin (selección + manijas): no abrir el popup.
        if (document.body.classList.contains('edit-mode')) return;
        const wp = nearestAt(e.point);
        if (wp) { state._wpClick = true; miniPopup(wp); try { adminFocusFromMap(wp.properties.id); } catch (er) { /* no admin */ } }
        else if (state._wpClick) { state._wpClick = false; }
        else removePopup();
      });
      finish();
    });
  });
}

// ---------- routes ----------
function renderRouteBar() {
  const bar = $('#route-bar');
  bar.innerHTML = '';
  // Chip "Recorrido libre": graba el recorrido que haga la persona (reemplaza a
  // "Todos" y al botón de grabar). Mientras graba, muestra ⏹ y para al tocarlo.
  // Durante un recorrido GUIADO no se muestra (el chip flotante de guía manda).
  if (!state.guiding) {
    const free = document.createElement('button');
    const rec = isRecording();
    free.className = 'route-chip free' + (rec ? ' recording' : '');
    free.innerHTML = rec ? `<span class="emoji">⏹</span>${t('free_stop')}` : `<span class="emoji">🎒</span>${t('free_walk')}`;
    free.onclick = () => { if (isRecording()) stopWalk(); else { selectRoute(null); startWalk(null, null); } };
    bar.appendChild(free);
  }
  state.routes.forEach((r) => {
    const chip = document.createElement('button');
    chip.className = 'route-chip' + (state.activeRoute === r.id ? ' active' : '');
    chip.dataset.route = r.id;
    chip.innerHTML = `<span class="emoji">${r.emoji}</span>${L(r, 'name')}`;   // full name, never truncated
    if (state.activeRoute === r.id) { chip.style.background = r.color; chip.style.color = '#fff'; }
    chip.onclick = () => selectRoute(state.activeRoute === r.id ? null : r.id);   // re-tap = quitar (ver todos)
    bar.appendChild(chip);
  });
  // Historial rápido de mis recorridos.
  const hist = document.createElement('button');
  hist.className = 'route-chip hist'; hist.title = t('my_walks');
  hist.innerHTML = '<span class="emoji">📖</span>';
  hist.onclick = () => openHistory();
  bar.appendChild(hist);
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

// Encadena senderos en el ORDEN dado (route.segments), orientando cada uno para
// conectar con el anterior. Ese orden fija la dirección del recorrido.
const trailById = (tid) => state.trails.find((t) => t.properties.id === tid);
function orderedPathFromSegments(ids) {
  const segs = ids.map(trailById).filter(Boolean).map((t) => t.geometry.coordinates.slice());
  if (!segs.length) return null;
  let path = segs[0].slice();
  if (segs.length > 1) {   // orientar el primero según por dónde sigue el segundo
    const n = segs[1];
    const endToNext = Math.min(haversine(path[path.length - 1], n[0]), haversine(path[path.length - 1], n[n.length - 1]));
    const startToNext = Math.min(haversine(path[0], n[0]), haversine(path[0], n[n.length - 1]));
    if (startToNext < endToNext) path.reverse();
  }
  for (let i = 1; i < segs.length; i++) {
    let seg = segs[i]; const tail = path[path.length - 1];
    if (haversine(tail, seg[seg.length - 1]) < haversine(tail, seg[0])) seg = seg.slice().reverse();
    path = haversine(tail, seg[0]) < 5 ? path.concat(seg.slice(1)) : path.concat(seg);
  }
  return path;
}

// Greedily chain a route's segments into ONE ordered polyline start→end, so the
// direction arrows and the marching-dash flow all run the same, correct way.
function buildRoutePath(id) {
  const route = state.routesById[id];
  const sWp = route && route.start_id ? wpById(route.start_id) : null;
  const eWp = route && route.end_id ? wpById(route.end_id) : null;
  // Si el recorrido define senderos en orden, úsalos; y ORIENTA la dirección
  // según los puntos de inicio/fin si se dieron (para que el flujo del camino
  // apunte hacia donde el admin marcó, aunque no cambie el orden de senderos).
  if (route && Array.isArray(route.segments) && route.segments.length) {
    let path = orderedPathFromSegments(route.segments);
    if (path && path.length >= 2) {
      const last = path.length - 1;
      const sC = sWp && sWp.geometry.coordinates, eC = eWp && eWp.geometry.coordinates;
      if (sC) { if (haversine(path[0], sC) > haversine(path[last], sC)) path.reverse(); }
      else if (eC) { if (haversine(path[0], eC) < haversine(path[last], eC)) path.reverse(); }
      return { segs: [], path, startCoord: path[0], endCoord: path[path.length - 1], startWp: sWp, endWp: eWp };
    }
  }
  const info = routeStartEnd(id);
  if (!info) {
    // Sin senderos definidos: si hay puntos de inicio Y fin, DEDUCE el camino
    // por la red de senderos (Dijkstra), y así el recorrido queda trazado.
    if (sWp && eWp) {
      const r = routeOnTrails(sWp.geometry.coordinates, eWp.geometry.coordinates);
      if (r && r.coords.length >= 2) return { segs: [], path: r.coords, startCoord: r.coords[0], endCoord: r.coords[r.coords.length - 1], startWp: sWp, endWp: eWp };
    }
    return null;
  }
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
  const hidden = [...state.hiddenTypes];
  const hiddenClause = hidden.length ? [['!', ['in', ['get', 'tipo'], ['literal', hidden]]]] : [];
  // TODOS los puntos siguen visibles (los tipos ocultos por el usuario, no). El
  // recorrido activo NO los oculta: sólo atenúa los NO asociados.
  map.setFilter('waypoints-pt', ['all', ['!=', ['get', 'tipo'], 'arbol'], ...hiddenClause]);
  if (map.getLayer('trees-pt')) map.setFilter('trees-pt', ['all', ['==', ['get', 'tipo'], 'arbol'], ...hiddenClause]);
  // Opacidad: con un recorrido activo, los puntos asociados quedan sólidos y el
  // resto tenue; de los árboles, los cercanos al camino resaltan sobre los lejanos.
  const wpOpacity = state.activeRoute
    ? ['case', ['in', state.activeRoute, ['get', 'routes']], 1, 0.3]
    : 1;
  map.setPaintProperty('waypoints-pt', 'circle-opacity', wpOpacity);
  map.setPaintProperty('waypoints-pt', 'circle-stroke-opacity', wpOpacity);
  if (map.getLayer('trees-pt')) {
    const trOpacity = state.activeRoute
      ? ['case', ['in', ['get', 'id'], ['literal', state.nearbyTrees || []]], 0.85, 0.25]
      : 1;
    map.setPaintProperty('trees-pt', 'circle-opacity', trOpacity);
    map.setPaintProperty('trees-pt', 'circle-stroke-opacity', trOpacity);
  }
}
// Árboles a menos de ~35 m del camino del recorrido (para mostrarlos con la ruta).
function computeNearbyTrees(path) {
  if (!path || !path.length) { state.nearbyTrees = []; return; }
  const THRESH = 35, step = Math.max(1, Math.floor(path.length / 120));   // muestrear el camino
  const sample = path.filter((_, i) => i % step === 0);
  const near = [];
  for (const w of state.waypoints) {
    if (w.properties.tipo !== 'arbol') continue;
    const c = w.geometry.coordinates;
    for (const p of sample) { if (haversine(c, p) <= THRESH) { near.push(w.properties.id); break; } }
  }
  state.nearbyTrees = near;
}
function waypointVisible(wp) {
  const p = wp.properties;
  if (state.hiddenTypes.has(p.tipo || 'punto')) return false;
  // Con un recorrido activo: sólo sus puntos (los no asociados desaparecen).
  if (state.activeRoute && !(p.routes || []).includes(state.activeRoute)) return false;
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
      // Con orden explícito, ilumina SOLO esos senderos (no los etiquetados).
      const segs = (route.segments && route.segments.length) ? route.segments : null;
      map.setFilter('trails-hl', segs ? ['in', ['get', 'id'], ['literal', segs]] : ['in', id, ['get', 'routes']]);
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
      computeNearbyTrees(built && built.path);   // árboles cerca del recorrido
    } else {
      map.setFilter('trails-hl', ['==', 'id', '___none___']);
      map.getSource('route-path').setData(emptyFC());
      map.getSource('route-ends').setData(emptyFC());
      stopFlow();
      state.nearbyTrees = [];
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
  let pts = state.waypoints.filter((w) => {
    const rts = w.properties.routes || [];
    return rts.includes(id) && waypointVisible(w);
  });
  // Ordénalos en el sentido del recorrido (a lo largo del trazado).
  if (built && built.path) pts = pts
    .map((w) => ({ w, pos: pathPos(built.path, w.geometry.coordinates) }))
    .sort((a, b) => a.pos - b.pos).map((x) => x.w);
  const guiding = state.guiding === id;
  // Una sola caja a la vez: abrir la del recorrido cierra la del punto.
  closeWaypoint(); removePopup();
  // Durante la guía la caja vive cerrada (queda el chip); si el usuario la
  // reabrió desde el chip, respetar eso. Fuera de guía, siempre abierta.
  const wasHidden = info.classList.contains('hidden');
  if (!guiding || !wasHidden) info.classList.remove('hidden');
  info.style.borderTopColor = route.color;
  info.innerHTML = `
    <button class="ri-close" id="ri-close" aria-label="Cerrar">×</button>
    <div class="ri-scroll">
      <h3>${route.emoji} ${L(route, 'name')}</h3>
      <p>${L(route, 'summary')}</p>
      ${built ? `<div class="ri-stats"><span class="ri-stat">📏 ${fmtDist(pathLengthM(built.path))}</span><span class="ri-stat" id="ri-ele">⛰️ …</span></div>` : ''}
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
  // La × solo cierra la caja. Durante la guía queda el chip flotante para
  // reabrirla o terminar — cerrar la caja ya no termina el recorrido.
  $('#ri-close').onclick = () => info.classList.add('hidden');
  $('#ri-start').onclick = () => (state.guiding === id ? stopGuiding() : startGuiding(id));
  $$('#route-info .ri-points li').forEach((li) => li.onclick = () => {
    const w = wpById(li.dataset.wp);
    if (!w) return;
    state.map.easeTo({ center: w.geometry.coordinates, zoom: Math.max(state.map.getZoom(), 17), duration: 600 });
    miniPopup(w);
  });
  if (built) applyElevation(route.id, built.path);
}

// ---------- elevación / desnivel (API gratis Open-Meteo) ----------
function eleText(r) { return `⛰️ +${Math.round(r.gainM)} m`; }
async function fetchElevation(coords) {
  const N = Math.min(coords.length, 90);
  const step = coords.length / N, samp = [];
  for (let i = 0; i < N; i++) samp.push(coords[Math.floor(i * step)]);
  samp.push(coords[coords.length - 1]);
  const lats = samp.map((c) => c[1].toFixed(6)).join(',');
  const lons = samp.map((c) => c[0].toFixed(6)).join(',');
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
  if (!res.ok) throw new Error('elev ' + res.status);
  const e = (await res.json()).elevation || [];
  let gain = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < e.length; i++) { min = Math.min(min, e[i]); max = Math.max(max, e[i]); if (i > 0 && e[i] > e[i - 1]) gain += e[i] - e[i - 1]; }
  return { gainM: gain, minEle: min, maxEle: max };
}
async function applyElevation(id, path) {
  const set = (txt) => { const el = $('#ri-ele'); if (el && state.activeRoute === id) el.textContent = txt; };
  if (state.eleCache[id]) { set(eleText(state.eleCache[id])); return; }
  try { const r = await fetchElevation(path); state.eleCache[id] = r; set(eleText(r)); }
  catch (e) { set('⛰️ —'); }
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
  // Prefiere la portada elegida en la galería (media); si es video, su poster.
  const mp = primaryPhoto('waypoint', wp.properties.id);
  if (mp) return mp.kind === 'video' ? (mp.poster || wp.properties.photo || null) : mp.full;
  return wp.properties.photo || null;
}
// Galería del punto: portada/fotos de la tabla media + foto y hoja heredadas.
function waypointGallery(wp) {
  const p = wp.properties, out = [], seen = new Set();
  const push = (m) => { if (m && m.full && !seen.has(m.full)) { seen.add(m.full); out.push(m); } };
  (state.media.bySubject[`waypoint:${p.id}`] || []).forEach(push);
  if (p.photo) push(normMedia({ url: p.photo, subject_type: 'waypoint', subject_id: p.id, id: 'wp-photo:' + p.id,
    caption: p.tipo === 'arbol' ? t('tree_photo') : '', caption_en: p.tipo === 'arbol' ? 'Tree' : '' }));
  if (p.photo_leaf) push(normMedia({ url: p.photo_leaf, id: 'wp-leaf:' + p.id, caption: t('leaf_photo'), caption_en: 'Leaf' }));
  out.sort((a, b) => (b.is_primary - a.is_primary) || (a.sort - b.sort));
  return out;
}
// Especies linkeadas a un punto (por id de especie o por nombre científico).
// Guarda contra scientific_name nulo. Devuelve los objetos-especie encontrados.
function linkedSpecies(p) {
  return (p.species_ids || []).map((sid) => {
    const key = String(sid).trim().toLowerCase();
    return state.species.find((x) => (x.id && x.id.toLowerCase() === key)
      || (x.scientific_name && x.scientific_name.toLowerCase() === key));
  }).filter(Boolean);
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
      ${(() => { const s = p.sci || (linkedSpecies(p)[0] && linkedSpecies(p)[0].scientific_name); return s ? `<em class="mp-sci">${escapeHtml(s)}</em>` : ''; })()}
      ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
      <div class="mp-actions">
        ${hasMore ? `<button class="mp-more" type="button">${t('more_info')} ›</button>` : ''}
        ${isAdminUser() ? '<button class="mp-edit" type="button">✏️ Editar</button>' : ''}
      </div>
    </div></div>`;
  state.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '240px', offset: 12, className: 'cantares-popup' })
    .setLngLat(wp.geometry.coordinates).setHTML(html).addTo(state.map);
  const el = state.popup.getElement();
  if (el) {
    el.addEventListener('mouseenter', cancelClosePopup);
    el.addEventListener('mouseleave', scheduleClosePopup);
    const btn = el.querySelector('.mp-more');
    if (btn) btn.onclick = () => { removePopup(); showWaypoint(wp); };
    const edb = el.querySelector('.mp-edit');
    if (edb) edb.onclick = () => { removePopup(); try { openPointEditor(wp.properties.id); } catch (e) { /* admin no cargado */ } };
  }
}

// Full detail "page" overlaid on the map (opened from the mini-popup's More button).
function showWaypoint(wp) {
  if (!wp) return;
  const p = wp.properties;
  state.openWaypointId = p.id; state.openSpeciesId = null;
  // Una sola caja a la vez: la tarjeta del punto oculta la caja del recorrido
  // (y al cerrarla, la caja vuelve si estaba abierta).
  const ri = $('#route-info');
  state._riWasOpen = !ri.classList.contains('hidden');
  ri.classList.add('hidden');
  // Badges de recorrido: son BOTONES que llevan al recorrido y cierran la ficha.
  const badges = (p.routes || []).filter((rid) => state.routesById[rid]).map((rid) =>
    `<button class="badge route-badge" data-route="${escapeHtml(rid)}" style="background:${ROUTE_COLORS[rid] || '#5b6b60'}">${routeLabel(rid)} ›</button>`).join('');
  const linked = linkedSpecies(p);
  const speciesChips = linked.map((s) => { const c = L(s, 'common_name'); const nm = (c && s.scientific_name) ? `${c} (${s.scientific_name})` : (c || s.scientific_name || ''); return `<span class="chip" data-species="${s.id}">${escapeHtml(nm)}</span>`; }).join('');
  const photo = realPhoto(wp);
  const gallery = waypointGallery(wp);
  const tm = typeMeta(p.tipo);
  const desc = L(p, 'description');
  // Nombre científico/familia: del waypoint (árboles estáticos) o, si no, de la
  // especie linkeada (para árboles editados en la nube que ya no cargan sci/family).
  const sci = p.sci || (linked[0] && linked[0].scientific_name) || null;
  const family = p.family || (linked[0] && linked[0].family) || null;
  $('#wp-content').innerHTML = `
    ${photo
      ? `<div class="wp-photo-hdr" style="background-image:url('${photo}')"></div>`
      : `<div class="wp-photo-hdr wp-no-photo" style="background:linear-gradient(135deg, ${tm.color}, var(--forest))"><span class="wp-hdr-emoji">${tm.emoji}</span></div>`}
    <div class="wp-inner">
      <div class="wp-theme-badges">${badges}</div>
      <h2 class="wp-title">${escapeHtml(L(p, 'title') || p.title)}</h2>
      ${sci ? `<p class="wp-sci"><em>${escapeHtml(sci)}</em>${family ? ` · ${escapeHtml(family)}` : ''}</p>` : ''}
      <button class="wp-nav" id="wp-nav">🧭 ${t('nav_how')}</button>
      ${gallery.length > 1 ? `<div class="sp-gallery">${gallery.map((m) => `<figure class="sp-fig" data-full="${escapeHtml(m.full)}" data-kind="${m.kind}">${pictureTag(m, 'sp-gimg', L(p, 'title'))}${m.caption ? `<figcaption>${escapeHtml(L(m, 'caption'))}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}
      ${desc ? `<p class="wp-desc">${escapeHtml(desc)}</p>` : ''}
      ${speciesChips ? `<div class="wp-species">${speciesChips}</div>` : ''}
      ${p.tipo === 'arbol' ? `<p class="tiny muted" style="margin-top:10px">${t('tree_note')}${p.tag ? ` · ${t('tree_tag')} ${escapeHtml(p.tag)}` : ''}${p.altitude ? ` · ${escapeHtml(p.altitude)}` : ''}</p>` : ''}
      ${p.approx ? `<p class="tiny muted" style="margin-top:10px">${t('approx_note')}</p>` : ''}
    </div>`;
  $('#waypoint-card').classList.remove('hidden');
  const navBtn = $('#wp-nav'); if (navBtn) navBtn.onclick = () => navigateTo(wp);
  $$('#wp-content .sp-gallery .sp-fig').forEach((f) => f.onclick = () => openLightbox(f.dataset.full, f.dataset.kind));
  $$('#wp-content .route-badge').forEach((b) =>
    b.onclick = () => { const rid = b.dataset.route; closeWaypoint(); selectRoute(rid); });
  $$('#wp-content .chip').forEach((chip) =>
    chip.onclick = () => { switchView('especies'); highlightSpecies(chip.dataset.species); });
}
function closeWaypoint() {
  $('#waypoint-card').classList.add('hidden'); state.openWaypointId = null; state.openSpeciesId = null;
  if (state._riWasOpen && state.activeRoute) $('#route-info').classList.remove('hidden');
  state._riWasOpen = false;
}

// ---------- geolocation ----------
function setGps(status, label) {
  const chip = $('#gps-chip'); if (!chip) return;   // header chip removed; button color is the cue
  chip.className = `gps-chip gps-${status}`; $('#gps-label').textContent = label || t('gps');
}
function locate() {
  if (state.watchId != null) {
    // Ya hay GPS activo: si el usuario paneó el mapa (dejó de seguir), un tap
    // vuelve a centrar y seguir (patrón Google Maps); si ya seguía, apaga.
    if (!state.following) {
      state.following = true;
      if (state.userPos && state.map) state.map.easeTo({ center: state.userPos, zoom: Math.max(state.map.getZoom(), 16.5), duration: 600 });
      return;
    }
    stopTracking(); return;
  }
  if (!('geolocation' in navigator)) { setGps('error', t('gps_unsupported')); toast(t('gps_unsupported')); return; }
  const localhost = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!window.isSecureContext && !localhost) toast(t('gps_insecure'));
  state.firstFix = false;
  state.following = true;
  setGps('searching', t('gps_searching'));
  $('#locate-btn').classList.add('tracking');
  navigator.geolocation.getCurrentPosition(onPosition, onGeoError, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 });
}
function stopTracking() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null; state.following = false;
  $('#locate-btn').classList.remove('tracking'); setGps('off', t('gps'));
  // Sin GPS no hay avisos de proximidad: cerrar también el modo guiado para
  // que el estado visible coincida con lo que de verdad está pasando.
  if (state.guiding) stopGuiding();
}
function onPosition(pos) {
  const { longitude, latitude, accuracy } = pos.coords;
  state.userPos = [longitude, latitude];
  state.userAccuracy = accuracy;   // metros — para el círculo de precisión
  setGps('on', `±${Math.round(accuracy)} m`);
  window.dispatchEvent(new CustomEvent('cantares:position', { detail: { lng: longitude, lat: latitude, accuracy } }));   // stream compartido (grabador)
  const src = state.map && state.map.getSource('user');
  if (src) src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: state.userPos }, properties: {} }] });
  updateAccuracyCircle();
  if (state.map) {
    if (!state.firstFix) { state.map.flyTo({ center: state.userPos, zoom: 17, duration: 900 }); state.firstFix = true; }
    // Recentrar sólo en modo seguimiento: si el usuario paneó para mirar más
    // adelante, no pelearle el mapa en cada fijo del GPS.
    else if (state.following) state.map.easeTo({ center: state.userPos, duration: 600 });
  }
  checkProximity();
}
// Radio del halo de precisión = accuracy (m) en píxeles al zoom actual.
// Se proyecta un punto `accuracy` metros al norte del usuario y se mide la
// distancia en píxeles (exacto y sin fórmulas de mercator a mano).
function updateAccuracyCircle() {
  const map = state.map;
  if (!map || !map.getLayer('user-acc')) return;
  const acc = state.userAccuracy;
  if (!state.userPos || !acc) { map.setPaintProperty('user-acc', 'circle-radius', 0); return; }
  try {
    const [lng, lat] = state.userPos;
    const dLat = acc / 111320;   // metros → grados de latitud
    const p0 = map.project([lng, lat]);
    const p1 = map.project([lng, lat + dLat]);
    const px = Math.abs(p0.y - p1.y);
    map.setPaintProperty('user-acc', 'circle-radius', Math.min(px, 600));   // tope por si el GPS reporta ±km
  } catch (e) { /* estilo transitorio */ }
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
  state.following = true;
  // Grabar también el recorrido guiado en el historial del usuario.
  const rt = state.routesById[id];
  if (!isRecording()) startWalk(id, rt ? L(rt, 'name') : null);
  // Pantalla encendida durante la guía: si se apaga, el navegador corta el GPS
  // y los avisos de llegada a los puntos mueren en silencio.
  keepAwake().then((ok) => toast(ok ? t('guiding_screen') : t('guiding_screen_warn')));
  toast(t('guiding_on'));
  // Mapa despejado durante la guía: la caja se cierra y queda solo el chip.
  closeWaypoint(); removePopup();
  $('#route-info').classList.add('hidden');
  guideChip(true);
}
function stopGuiding() {
  const wasId = state.guiding;
  state.guiding = null;
  releaseAwake();
  guideChip(false);
  if (isRecording()) stopWalk();   // guarda el recorrido guiado en el historial
  if (wasId) toast(t('guiding_off'));
  if (state.activeRoute) renderRouteInfo(state.routesById[state.activeRoute], buildRoutePath(state.activeRoute));
}
// Chip flotante mientras se sigue un recorrido: tocar el nombre reabre la caja
// de información; ■ termina (con confirmación — es un botón pequeño).
function guideChip(show) {
  let el = document.getElementById('guide-chip');
  if (!show) { if (el) el.remove(); return; }
  const r = state.routesById[state.guiding];
  if (!r) return;
  if (!el) {
    el = document.createElement('div'); el.id = 'guide-chip'; el.className = 'guide-chip';
    (document.getElementById('view-recorridos') || document.body).appendChild(el);
  }
  el.style.borderColor = r.color || 'var(--moss)';
  el.innerHTML = `
    <button class="gc-open">${r.emoji || '🥾'} <b>${escapeHtml(L(r, 'name'))}</b></button>
    <button class="gc-stop" aria-label="${t('ri_stop_walk')}">■</button>`;
  el.querySelector('.gc-open').onclick = () => {
    renderRouteInfo(r, buildRoutePath(state.guiding));
    $('#route-info').classList.remove('hidden');
  };
  el.querySelector('.gc-stop').onclick = () => { if (confirm(t('guiding_confirm_end'))) stopGuiding(); };
}

function checkProximity() {
  if (!state.userPos || !state.guiding) return;   // sólo durante un recorrido iniciado
  state.waypoints.forEach((wp) => {
    const id = wp.properties.id;
    if (!waypointVisible(wp)) return;   // only trigger points currently shown
    const d = haversine(state.userPos, wp.geometry.coordinates);
    if (d <= CONFIG.proximityMeters && !state.lastTriggered[id]) {
      state.lastTriggered[id] = true;
      const arriveName = L(wp.properties, 'title') || wp.properties.title || '';
      if (arriveName) toast('📍 ' + arriveName);
      miniPopup(wp);   // arriving shows the small popup; visitor taps "Más info" to expand
    } else if (d > CONFIG.reTriggerMeters && state.lastTriggered[id]) state.lastTriggered[id] = false;
  });
}
let toastTimer = null;
function toast(msg) {
  const el = $('#proximity-toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer);
  // Mensajes largos (errores, avisos offline) necesitan más tiempo de lectura.
  const ms = Math.max(3400, Math.min(8000, String(msg).length * 70));
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------- species ----------
// ---------- grupos de especies (orden canónico de la estructura de información) ----------
// Fuente compartida: data/species_groups.json (cargado en main con este respaldo
// idéntico). El orden del arreglo define el orden de aparición y de las secciones.
// Espejo 1:1 de las categorías del Sistema de Información (14_classify_photos.py:
// CATEGORIES/CLIP → aves, anfibios, mamíferos, insectos, árboles, flores, plantas).
const SPECIES_GROUPS_FALLBACK = [
  { key: 'ave',      es: 'Aves',      en: 'Birds',      emoji: '🐦', color: '#269ed9' },
  { key: 'anfibio',  es: 'Anfibios',  en: 'Amphibians', emoji: '🐸', color: '#1098ad' },
  { key: 'mamifero', es: 'Mamíferos', en: 'Mammals',    emoji: '🐾', color: '#8d6e63' },
  { key: 'insecto',  es: 'Insectos',  en: 'Insects',    emoji: '🐞', color: '#e8760c' },
  { key: 'arbol',    es: 'Árboles',   en: 'Trees',      emoji: '🌳', color: '#1b7a3a' },
  { key: 'flor',     es: 'Flores',    en: 'Flowers',    emoji: '🌸', color: '#c2255c' },
  { key: 'planta',   es: 'Plantas',   en: 'Plants',     emoji: '🌿', color: '#5a8f2b' },
];
function speciesGroupsList() { return (state.speciesGroups && state.speciesGroups.length) ? state.speciesGroups : SPECIES_GROUPS_FALLBACK; }
function groupMeta(key) {
  return speciesGroupsList().find((g) => g.key === key)
    || { key: key || 'otro', es: 'Otros', en: 'Other', emoji: '❓', color: '#8a97a5' };
}
function groupLabel(key) { const g = groupMeta(key); return LANG === 'en' ? g.en : g.es; }
const groupOrderIndex = (key) => { const i = speciesGroupsList().findIndex((g) => g.key === key); return i < 0 ? 99 : i; };
// ¿La especie es un árbol? (linkeada a un punto tipo 'arbol' del inventario).
function isTreeSpecies(s) { return speciesWaypoints(s).some((w) => w.properties.tipo === 'arbol'); }
// Grupo de VISUALIZACIÓN, siguiendo el modelo del Sistema de Información:
// group (ave/anfibio/mamifero/insecto/flora) + habit (arbol/flor/planta) para la
// flora — misma lógica que 14_classify_photos.py. La flora sin hábito cae en
// planta (fallback), salvo que esté linkeada a un punto tipo 'arbol'.
const normGrp = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function speciesGroup(s) {
  const g = normGrp(s.group), h = normGrp(s.habit);
  if (g === 'ave') return 'ave';
  if (g === 'anfibio') return 'anfibio';
  if (g === 'mamifero') return 'mamifero';
  if (g === 'insecto' || g === 'insectos') return 'insecto';
  if (g === 'arbol' || g === 'flor' || g === 'planta') return g;   // valor fino explícito
  // flora → hábito
  if (h === 'arbol') return 'arbol';
  if (h === 'flor' || h === 'orquidea') return 'flor';
  if (h === 'arbusto' || h === 'hierba' || h === 'planta') return 'planta';
  return isTreeSpecies(s) ? 'arbol' : 'planta';   // sin hábito: heurística, luego fallback
}

let speciesFilter = 'all';
function renderSpeciesFilters() {
  const wrap = $('#species-filters');
  // Sólo los grupos presentes (según el grupo derivado), en el orden canónico.
  const present = new Set(state.species.map(speciesGroup));
  const groupChips = speciesGroupsList().filter((g) => present.has(g.key)).map((g) => [g.key, groupLabel(g.key)]);
  const opts = [['all', t('f_all')], ['flagship', t('f_flagship')], ...groupChips];
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
  return state.species.filter((s) => speciesFilter === 'all' ? true : speciesFilter === 'flagship' ? s.flagship : speciesGroup(s) === speciesFilter);
}
function renderSpeciesGrid(highlightId) {
  const grid = $('#species-grid');
  // Grupo derivado precomputado (evita recalcular el lookup de árbol en el sort).
  const grpOf = new Map(state.species.map((s) => [s.id, speciesGroup(s)]));
  const gOf = (s) => grpOf.get(s.id) || 'planta';
  // Orden canónico de la estructura de información (grupo → nombre).
  const list = filteredSpecies().slice().sort((a, b) =>
    groupOrderIndex(gOf(a)) - groupOrderIndex(gOf(b))
    || (L(a, 'common_name') || a.scientific_name || '').localeCompare(L(b, 'common_name') || b.scientific_name || ''));
  $('#species-count').textContent = `${list.length} ${t('count_suffix')}`;
  grid.innerHTML = '';
  const showHeaders = speciesFilter === 'all';   // separar por secciones sólo en «Todos»
  let lastGroup = null;
  // Admin: botón para crear una especie nueva (edición vive en este tab).
  const adminAdd = $('#species-admin-add');
  if (isAdminUser()) {
    if (!adminAdd) {
      const b = document.createElement('button');
      b.id = 'species-admin-add'; b.className = 'admin-add'; b.style.marginBottom = '10px';
      b.textContent = '＋ ' + t('sp_new');
      b.onclick = () => openSpeciesEditor(null, () => { refreshSpecies(); renderSpeciesGrid(); });
      grid.parentNode.insertBefore(b, grid);
    }
  } else if (adminAdd) adminAdd.remove();
  list.forEach((s) => {
    const gg = gOf(s), gm = groupMeta(gg);
    if (showHeaders && gg !== lastGroup) {
      lastGroup = gg;
      const h = document.createElement('div');
      h.className = 'species-section-head';
      h.innerHTML = `<span class="ssh-emoji">${gm.emoji}</span> ${escapeHtml(groupLabel(gg))}`;
      grid.appendChild(h);
    }
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
      <span class="species-group-tag" style="background:${gm.color}">${escapeHtml(groupLabel(gg))}</span>
      ${capturedBadge(s.id)}`;
    card.onclick = () => showSpecies(s);
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

// ---------- ficha de especie (click en una especie) ----------
// Puntos donde se encuentra la especie (link por id o por nombre científico).
function speciesWaypoints(s) {
  const keys = new Set([String(s.id).toLowerCase(), (s.scientific_name || '').toLowerCase()].filter(Boolean));
  return state.waypoints.filter((w) => (w.properties.species_ids || []).some((sid) => keys.has(String(sid).trim().toLowerCase())));
}
// Galería de una especie (registros normalizados): media de la nube + curadas
// (media.json) + su foto directa + COMPARTIDAS de los puntos asociados. Así, si
// un punto está linkeado a una especie, su foto aparece también en la especie.
function speciesGallery(s) {
  const out = [], seen = new Set();
  const push = (m) => { if (m && m.full && !seen.has(m.full)) { seen.add(m.full); out.push(m); } };
  (state.media.bySubject[`species:${s.id}`] || []).forEach(push);
  if (s.photo) push(normMedia({ url: s.photo, subject_type: 'species', subject_id: s.id, id: 'sp-photo:' + s.id }));
  speciesWaypoints(s).forEach((w) => {
    const p = w.properties, ttl = L(p, 'title') || p.title || '';
    if (p.photo) push(normMedia({ url: p.photo, id: 'shared:' + p.id, caption: ttl, source: 'shared' }));
    (state.media.bySubject[`waypoint:${p.id}`] || []).forEach((m) => push({ ...m, caption: m.caption || ttl }));
  });
  out.sort((a, b) => (b.is_primary - a.is_primary) || (a.sort - b.sort));
  return out;
}
// Mini-mapa estático (canvas) del contorno de la reserva + los puntos de la especie.
function drawSpeciesMap(wps, size = 560) {
  const cv = document.createElement('canvas'); cv.width = size; cv.height = Math.round(size * 0.72);
  const g = cv.getContext('2d'); const H = cv.height;
  g.fillStyle = '#eaf2fb'; g.fillRect(0, 0, size, H);
  const b = state.boundary;
  // bbox del contorno de la reserva
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const scanRing = (ring) => ring.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
  const polysOf = (gj) => { const out = []; (gj && (gj.features || [gj])).forEach((f) => { const gm = f.geometry || f; if (!gm) return; if (gm.type === 'Polygon') out.push(gm.coordinates); else if (gm.type === 'MultiPolygon') gm.coordinates.forEach((p) => out.push(p)); }); return out; };
  const polys = polysOf(b);
  polys.forEach((poly) => scanRing(poly[0]));
  if (!isFinite(minX)) { wps.forEach((w) => scanRing([w.geometry.coordinates])); }
  const pad = 20, s = Math.min((size - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1));
  const offX = pad + ((size - pad * 2) - s * (maxX - minX)) / 2, offY = pad + ((H - pad * 2) - s * (maxY - minY)) / 2;
  const X = (lng) => offX + (lng - minX) * s, Y = (lat) => offY + (maxY - lat) * s;
  // contorno + senderos tenues
  polys.forEach((poly) => { g.beginPath(); poly[0].forEach((c, i) => { const px = X(c[0]), py = Y(c[1]); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.closePath(); g.fillStyle = 'rgba(0,122,53,0.08)'; g.fill(); g.strokeStyle = '#9db8cf'; g.lineWidth = 1.5; g.stroke(); });
  (state.trails || []).forEach((tr) => { const cs = tr.geometry.coordinates; g.beginPath(); cs.forEach((c, i) => { const px = X(c[0]), py = Y(c[1]); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.strokeStyle = '#cdd8c8'; g.lineWidth = 2; g.stroke(); });
  // puntos de la especie
  wps.forEach((w) => { const c = w.geometry.coordinates, m = typeMeta(w.properties.tipo); g.beginPath(); g.arc(X(c[0]), Y(c[1]), 6, 0, 7); g.fillStyle = m.color; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); });
  return cv.toDataURL('image/png');
}
function showSpecies(s) {
  if (!s) return;
  const wps = speciesWaypoints(s);
  const gallery = speciesGallery(s);
  const cover = gallery[0] || null;
  const admin = isAdminUser();
  const statusTxt = s.status === 'possible' ? t('possible') : '';
  let mapImg = '';   // el mini-mapa nunca debe impedir que abra la ficha
  if (wps.length) { try { mapImg = drawSpeciesMap(wps); } catch (e) { console.warn('speciesMap', e && e.message); } }
  const coverBg = cover ? (cover.kind === 'video' ? (cover.poster || '') : cover.full) : '';
  const html = `
    ${cover
      ? (cover.kind === 'video'
          ? `<div class="wp-photo-hdr wp-video-hdr">${mediaFullTag(cover, 'wp-hdr-video', L(s, 'common_name'))}</div>`
          : `<div class="wp-photo-hdr" style="background-image:url('${escapeHtml(coverBg)}');background-position:${(cover.focal_x * 100).toFixed(0)}% ${(cover.focal_y * 100).toFixed(0)}%"></div>`)
      : `<div class="wp-photo-hdr wp-no-photo" style="background:linear-gradient(135deg, var(--green), var(--deep))"><span class="wp-hdr-emoji">${groupMeta(speciesGroup(s)).emoji}</span></div>`}
    <div class="wp-inner">
      <div class="wp-theme-badges"><span class="species-group-tag" style="background:${groupMeta(speciesGroup(s)).color}">${escapeHtml(groupLabel(speciesGroup(s)))}</span>${s.flagship ? '<span class="badge" style="background:var(--gold);color:var(--navy)">★</span>' : ''}${statusTxt ? `<span class="badge" style="background:#8a97a5">${statusTxt}</span>` : ''}</div>
      <h2 class="wp-title">${escapeHtml(L(s, 'common_name') || s.scientific_name || '')}</h2>
      ${s.scientific_name ? `<p class="wp-sci"><em>${escapeHtml(s.scientific_name)}</em>${s.family ? ` · ${escapeHtml(s.family)}` : ''}</p>` : ''}
      ${gallery.length > 1 ? `<div class="sp-gallery">${gallery.map((m) => `<figure class="sp-fig" data-full="${escapeHtml(m.full)}" data-kind="${m.kind}">${pictureTag(m, 'sp-gimg', L(s, 'common_name'))}${m.caption ? `<figcaption>${escapeHtml(L(m, 'caption'))}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}
      ${s.notes ? `<p class="wp-desc">${escapeHtml(s.notes)}</p>` : ''}
      <div class="sp-where">📍 ${wps.length ? `${wps.length} ${wps.length === 1 ? t('sp_here_1') : t('sp_here_n')}` : t('sp_nowhere')}</div>
      ${wps.length ? `${mapImg ? `<img class="sp-map" src="${mapImg}" alt="">` : ''}
        <div class="sp-locs">${wps.map((w) => `<button class="chip" data-wp="${escapeHtml(w.properties.id)}">${escapeHtml(L(w.properties, 'title') || w.properties.title)}</button>`).join('')}</div>` : ''}
      ${admin ? `<div class="sp-admin-actions">
        <button class="wp-nav" id="sp-edit" style="background:var(--deep)">✏️ ${t('sp_edit')}</button>
        ${cover ? `<button class="wp-nav" id="sp-dl" style="background:var(--muted)">⬇️ ${t('sp_dl')}</button>` : ''}
      </div>` : ''}
    </div>`;
  $('#wp-content').innerHTML = html;
  $('#waypoint-card').classList.remove('hidden');
  state.openWaypointId = null; state.openSpeciesId = s.id;
  $$('#wp-content .sp-gallery .sp-fig').forEach((f) => f.onclick = () => openLightbox(f.dataset.full, f.dataset.kind));
  $$('#wp-content .sp-locs .chip').forEach((c) => c.onclick = () => { const w = wpById(c.dataset.wp); closeWaypoint(); if (w) selectSearch(w.properties.id); });
  const ed = $('#sp-edit'); if (ed) ed.onclick = () => { closeWaypoint(); openSpeciesEditor(s.id, () => { refreshSpecies(); renderSpeciesGrid(); }); };
  const dl = $('#sp-dl'); if (dl) dl.onclick = () => downloadPhoto(cover.full, L(s, 'common_name') || s.scientific_name);
}
// Visor a pantalla completa para una foto/video de la galería.
function openLightbox(url, kind) {
  if (!url) return;
  let ov = document.getElementById('media-lightbox');
  if (!ov) { ov = document.createElement('div'); ov.id = 'media-lightbox'; ov.className = 'media-lightbox'; document.body.appendChild(ov); }
  ov.innerHTML = kind === 'video'
    ? `<video src="${escapeHtml(url)}" controls autoplay playsinline class="lb-media"></video><button class="lb-close" aria-label="Cerrar">×</button>`
    : `<img src="${escapeHtml(url)}" class="lb-media" alt=""><button class="lb-close" aria-label="Cerrar">×</button>`;
  ov.classList.add('open');
  const close = () => ov.classList.remove('open');
  ov.onclick = (e) => { if (e.target === ov || e.target.classList.contains('lb-close')) close(); };
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

// ---------- cuenta / dashboard ----------
async function renderDashboard() {
  const el = $('#dashboard'); if (!el) return;
  const user = Cloud.currentUser();
  const walks = await listWalks();
  const totalDist = walks.reduce((s, w) => s + (w.distanceM || 0), 0);
  const sum = accountSummary();
  const photos = capturedPhotos(24);
  const name = user ? user.username : t('dash_guest');
  const roleLabel = user ? (user.role === 'admin' ? t('dash_admin') : t('dash_visitor')) : t('dash_guest_sub');
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '·';
  el.innerHTML = `
    <div class="dash-head">
      <div class="dash-avatar">${escapeHtml(initial)}</div>
      <div class="dash-id"><h1>${escapeHtml(name)}</h1><p class="muted">${roleLabel}</p></div>
    </div>
    ${user ? `<button class="dash-logout" id="dash-logout">${t('dash_logout')}</button>`
           : `<button class="dash-cta" id="dash-cta">${t('dash_create')}</button>`}
    <div class="dash-stats">
      <div class="dash-stat"><b>${walks.length}</b><span>${t('dash_walks')}</span></div>
      <div class="dash-stat"><b>${fmtDist(totalDist)}</b><span>${t('dash_dist')}</span></div>
      <div class="dash-stat"><b>${sum.nSpecies}</b><span>${t('dash_species')}</span></div>
      <div class="dash-stat"><b>${sum.points}</b><span>${t('dash_points')}</span></div>
    </div>
    <h2 class="dash-h2">${t('dash_walks_h')}</h2>
    ${walks.length ? `<div class="dash-walks">${walks.map((w) => walkCardHTML(w)).join('')}</div>` : `<p class="muted">${t('dash_no_walks')}</p>`}
    <h2 class="dash-h2">${t('dash_photos_h')}</h2>
    ${photos.length ? `<div class="dash-photos">${photos.map((ph) => `<figure><img src="${ph.url}" alt="" loading="lazy"><figcaption>${escapeHtml(ph.common)}</figcaption></figure>`).join('')}</div>` : `<p class="muted">${t('dash_no_photos')}</p>`}`;
  const lo = $('#dash-logout'); if (lo) lo.onclick = doLogout;
  const cta = $('#dash-cta'); if (cta) cta.onclick = () => { localStorage.removeItem('cantares_guest'); location.reload(); };
  $$('#dashboard .rec-dl').forEach((b) => b.onclick = () => { const w = walks.find((x) => x.id === b.dataset.id); if (w) downloadWalk(w); });
}

// ---------- navigation ----------
function switchView(name) {
  // La ficha es un overlay de nivel superior: al cambiar de pestaña, ciérrala
  // (antes vivía dentro de Recorridos y se ocultaba sola con la vista).
  if (state.openWaypointId || state.openSpeciesId) closeWaypoint();
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  $(`#view-${name}`).classList.add('is-active');
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === name));
  const acc = $('#account-btn'); if (acc) acc.classList.toggle('active', name === 'cuenta');
  if (name === 'recorridos' && state.map) setTimeout(() => state.map.resize(), 60);
  if (name === 'cuenta') renderDashboard();
}

// ---------- búsqueda de puntos ----------
function openSearch() {
  $('#search-panel').classList.remove('hidden');
  const inp = $('#search-input'); inp.value = ''; renderSearch(''); setTimeout(() => inp.focus(), 60);
}
function closeSearch() { $('#search-panel').classList.add('hidden'); }
function renderSearch(q) {
  const box = $('#search-results');
  const query = (q || '').trim().toLowerCase();
  let items = state.waypoints.map((w) => ({ w, name: L(w.properties, 'title') || w.properties.title || '' }));
  if (query) {
    items = items.filter((x) => x.name.toLowerCase().includes(query) || (x.w.properties.sci || '').toLowerCase().includes(query));
    items.sort((a, b) => (b.name.toLowerCase().startsWith(query)) - (a.name.toLowerCase().startsWith(query)));
  } else {
    items = items.filter((x) => x.w.properties.tipo !== 'arbol');   // sin texto: solo puntos curados
  }
  items = items.slice(0, 40);
  if (!items.length) { box.innerHTML = `<div class="search-empty">${t('search_none')}</div>`; return; }
  box.innerHTML = items.map((x) => {
    const m = typeMeta(x.w.properties.tipo);
    const sub = x.w.properties.sci ? `<i>${escapeHtml(x.w.properties.sci)}</i>` : typeLabel(x.w.properties.tipo);
    return `<button class="search-item" data-id="${escapeHtml(x.w.properties.id)}">
      <span class="si-dot" style="background:${m.color}"></span>
      <span>${escapeHtml(x.name)} · <span class="si-sub">${sub}</span></span></button>`;
  }).join('');
  box.querySelectorAll('.search-item').forEach((b) => b.onclick = () => selectSearch(b.dataset.id));
}
function selectSearch(id) {
  const w = state.waypoints.find((x) => x.properties.id === id);
  closeSearch();
  if (!w || !state.map) return;
  if (!$('#view-recorridos').classList.contains('is-active')) switchView('recorridos');
  setTimeout(() => {
    state.following = false;
    state.map.easeTo({ center: w.geometry.coordinates, zoom: Math.max(state.map.getZoom(), 17.5), duration: 700 });
    miniPopup(w);
  }, 90);
}

// ---------- "Cómo llegar": ruta desde tu ubicación al punto, por los senderos ----------
// Grafo de la red de senderos: vértices = puntos de las líneas; aristas entre
// vértices consecutivos + puentes entre vértices muy cercanos (uniones que no
// comparten vértice exacto). Se cachea porque los senderos casi no cambian.
function buildTrailGraph() {
  if (state._trailGraph) return state._trailGraph;
  const nodes = [], adj = [], idxOf = new Map();
  const key = (c) => c[0].toFixed(5) + ',' + c[1].toFixed(5);
  const addNode = (c) => { const k = key(c); if (idxOf.has(k)) return idxOf.get(k); const i = nodes.length; nodes.push(c); adj.push([]); idxOf.set(k, i); return i; };
  const link = (a, b) => { if (a === b) return; const w = haversine(nodes[a], nodes[b]); adj[a].push({ to: b, w }); adj[b].push({ to: a, w }); };
  (state.trails || []).forEach((tr) => {
    const cs = (tr.geometry && tr.geometry.coordinates) || [];
    let prev = null;
    for (const c of cs) { const i = addNode(c); if (prev != null) link(prev, i); prev = i; }
  });
  const SNAP = 12;   // m: une uniones de senderos cercanas
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++)
    if (haversine(nodes[i], nodes[j]) <= SNAP) link(i, j);
  state._trailGraph = { nodes, adj };
  return state._trailGraph;
}
function nearestNode(nodes, c) { let bi = -1, bd = Infinity; for (let i = 0; i < nodes.length; i++) { const d = haversine(nodes[i], c); if (d < bd) { bd = d; bi = i; } } return { i: bi, d: bd }; }
// Camino más corto (Dijkstra) por los senderos desde `from` hasta `to`.
function routeOnTrails(from, to) {
  const g = buildTrailGraph();
  if (!g.nodes.length) return null;
  const s = nearestNode(g.nodes, from), t = nearestNode(g.nodes, to);
  if (s.i < 0 || t.i < 0) return null;
  const N = g.nodes.length, dist = new Array(N).fill(Infinity), prev = new Array(N).fill(-1), done = new Array(N).fill(false);
  dist[s.i] = 0;
  for (let it = 0; it < N; it++) {
    let u = -1, best = Infinity;
    for (let k = 0; k < N; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k; }
    if (u < 0 || u === t.i) break;
    done[u] = true;
    for (const e of g.adj[u]) { const nd = dist[u] + e.w; if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; } }
  }
  if (!isFinite(dist[t.i])) return null;
  const path = [];
  for (let u = t.i; u !== -1; u = prev[u]) path.unshift(g.nodes[u]);
  return { coords: [from, ...path, to], distM: dist[t.i] + s.d + t.d, onTrail: true };
}
// Botón "Cómo llegar" del punto: rutea desde el GPS. Si aún no hay ubicación,
// la pide y reintenta; si no hay camino por senderos, traza una línea directa.
function navigateTo(wp) {
  const target = wp.geometry.coordinates;
  const go = () => {
    if (!state.userPos) { toast(t('nav_need_gps')); return; }
    let r = routeOnTrails(state.userPos, target);
    if (!r) r = { coords: [state.userPos, target], distM: haversine(state.userPos, target), onTrail: false };
    drawNav(r, wp);
  };
  if (state.userPos) { go(); return; }
  toast(t('nav_locating'));
  if (state.watchId == null) locate();
  // esperar el primer fijo (hasta ~12 s)
  let waited = 0;
  const iv = setInterval(() => {
    waited += 400;
    if (state.userPos) { clearInterval(iv); go(); }
    else if (waited > 12000) { clearInterval(iv); toast(t('nav_need_gps')); }
  }, 400);
}
function drawNav(r, wp) {
  const map = state.map; if (!map) return;
  closeWaypoint(); removePopup();
  const src = map.getSource('nav-route');
  if (src) src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } }] });
  // encuadrar la ruta
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  r.coords.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
  try { map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 70, maxZoom: 18, duration: 700 }); } catch (e) { /* bounds degenerados */ }
  showNavBanner(r, wp);
}
function showNavBanner(r, wp) {
  let el = document.getElementById('nav-banner');
  if (!el) { el = document.createElement('div'); el.id = 'nav-banner'; el.className = 'nav-banner'; (document.getElementById('view-recorridos') || document.body).appendChild(el); }
  const name = escapeHtml(L(wp.properties, 'title') || wp.properties.title || '');
  const note = r.onTrail ? t('nav_by_trail') : t('nav_direct');
  el.innerHTML = `<span class="nb-txt">🧭 ${fmtDist(r.distM)} <small>· ${name} · ${note}</small></span>
    <button class="nb-go" id="nb-go">${t('nav_follow')}</button><button id="nb-x" aria-label="Cerrar">✕</button>`;
  el.querySelector('#nb-go').onclick = () => { state.following = true; if (state.watchId == null) locate(); };
  el.querySelector('#nb-x').onclick = clearNav;
}
function clearNav() {
  const map = state.map;
  const src = map && map.getSource('nav-route'); if (src) src.setData(emptyFC());
  const el = document.getElementById('nav-banner'); if (el) el.remove();
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
    if (!moved && Math.abs(dx) + Math.abs(dy) > 9) moved = true;   // >9px: un tap tembloroso caminando no debe mover el widget
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
  $('#account-btn').onclick = () => switchView('cuenta');   // Cuenta pasó del tabbar al header
  // Tap fuera del recuadro (sobre el fondo oscuro) lo cierra.
  $('#waypoint-card').addEventListener('click', (e) => { if (e.target.id === 'waypoint-card') closeWaypoint(); });
  $('#search-btn').onclick = openSearch;
  $('#search-close').onclick = closeSearch;
  $('#search-input').oninput = (e) => renderSearch(e.target.value);
  // Legend, imagery toggle and GPS button: draggable (tap still collapses / locates).
  makeDraggable($('#legend'), $('#legend-toggle'), 'cantares_pos_legend', () => $('#legend').classList.toggle('collapsed'));
  // Menos desorden en móvil: la leyenda arranca colapsada (un tap la abre).
  if (window.matchMedia && window.matchMedia('(max-width: 560px)').matches) $('#legend').classList.add('collapsed');
  makeDraggable($('#base-slider-box'), $('#base-toggle'), 'cantares_pos_base', () => $('#base-slider-box').classList.toggle('collapsed'));
  makeDraggable($('#locate-btn'), $('#locate-btn'), 'cantares_pos_locate', locate);
  window.addEventListener('online', renderOfflineStatus);
  window.addEventListener('offline', renderOfflineStatus);
  window.addEventListener('cantares:recstate', renderRouteBar);   // refresca el chip "Recorrido libre"

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

  const [routesDoc, speciesDoc, reserveInfo, mediaDoc, groupsDoc] = await Promise.all([
    loadJSON(CONFIG.data.routes), loadJSON(CONFIG.data.species),
    loadJSON(CONFIG.data.reserveInfo).catch(() => null),
    loadJSON(CONFIG.data.media).catch(() => null),
    loadJSON(CONFIG.data.speciesGroups).catch(() => null),
  ]);
  state.speciesGroups = (groupsDoc && Array.isArray(groupsDoc.groups) && groupsDoc.groups.length) ? groupsDoc.groups : SPECIES_GROUPS_FALLBACK;
  state.routes = routesDoc.routes;
  state.staticRoutes = routesDoc.routes;   // respaldo para el merge con la nube
  state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
  state.species = speciesDoc.species;
  state.staticSpecies = speciesDoc.species;   // respaldo para el merge con la nube
  state.reserveInfo = reserveInfo;
  state.staticMedia = mediaDoc;             // respaldo para el merge con la nube
  state.cloudMedia = [];
  state.media = indexMedia(mediaDoc, []);

  // Waypoints base = puntos curados + inventario de árboles (tipo 'arbol').
  // La nube se combina ENCIMA de esta base (los árboles editados/con foto la
  // sobrescriben por id; los demás rellenan). Así los árboles son editables y
  // nunca "desaparecen" si la tabla de la nube está incompleta.
  const [wpDoc, treeDoc] = await Promise.all([
    loadJSON(CONFIG.data.waypoints), loadJSON(CONFIG.data.trees).catch(() => ({ features: [] })),
  ]);
  normalizeFeatures(wpDoc); normalizeFeatures(treeDoc);
  state.staticWaypoints = [...wpDoc.features, ...treeDoc.features];
  state.waypoints = state.staticWaypoints.slice();

  applyStaticI18n();
  renderRouteBar(); renderSpeciesFilters(); renderSpeciesGrid(); renderOfflineStatus(); renderCarbon(); renderLegend(); renderVisitInfo();
  $('#base-year').textContent = baseLabel(CONFIG.baseStops[state.baseIndex]);

  // El resto del arranque ocurre DESPUÉS de la puerta de entrada (login/invitado).
  const enterApp = async () => {
    // La puerta de entrada pudo cambiar el idioma (botón English): sincronizar.
    const gateLang = localStorage.getItem('cantares_lang');
    if (gateLang && gateLang !== LANG) setLang(gateLang);
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
      initAdmin({ state, map: state.map, t, L, LANG, toast, makeDraggable,
        typeColor: (tp) => typeMeta(tp).color,
        refreshWaypoints, refreshSpecies, refreshRoutes, refreshTrails,
        applyLocalRow, removeLocalRow,
        showPointPopup: (id) => { const w = wpById(id); if (w) miniPopup(w); },   // mismo popup que fuera del modo edición (con "más info" + "Editar")
        pointTypes: () => Object.keys(TYPE_META).map((tp) => ({ tipo: tp, emoji: TYPE_META[tp].emoji, color: TYPE_META[tp].color, label: typeLabel(tp) })),
        registerPointType,
        ensureGps: () => { if (state.watchId == null) locate(); },   // GPS caliente para marcar sin esperar
        redrawActiveRoute: () => { if (state.activeRoute) selectRoute(state.activeRoute); } });
      initRecorder({ state, t, L, toast, ensureGps: () => { if (state.watchId == null) locate(); } });
    }
    // Cola offline: reflejar cambios pendientes de sesiones sin señal y
    // subirlos automáticamente cuando vuelva el internet.
    await applyPendingLocally();
    initSync({
      onSynced: async (n) => {
        toast(`☁️ ${n} cambio(s) sincronizado(s)`);
        await refreshRoutes(); await refreshTrails(); await refreshWaypoints(); await refreshSpecies(); await refreshMedia();
      },
      onPending: (n) => { const fab = document.getElementById('admin-fab'); if (fab) fab.dataset.pending = String(n || 0); },
      onStuck: (op) => toast(`⚠️ Un cambio (${op.table}) no se ha podido subir. Revisa tu sesión de admin; se seguirá reintentando.`),
    });
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
    tipo: r.tipo || 'punto', routes: r.routes || [], species_ids: r.species_ids || [],
    photo: r.photo || null, photo_leaf: r.photo_leaf || null,
  }, geometry: { type: 'Point', coordinates: [r.lng, r.lat] } };
}
function cloudTrailToFeature(r) {
  return { type: 'Feature', properties: { id: r.id, name: r.name, routes: r.routes || [] },
    geometry: { type: 'LineString', coordinates: r.geometry || [] } };
}
// Combina los recorridos de la nube SOBRE los estáticos (por id). Así una tabla
// `routes` incompleta nunca hace "desaparecer" recorridos: la nube manda donde
// existe, el estático rellena el resto.
function applyCloudRoutes(cr) {
  const byId = {};
  (state.staticRoutes || []).forEach((r, i) => { byId[r.id] = { sort: i, ...r }; });
  (cr || []).forEach((r) => { byId[r.id] = { ...(byId[r.id] || {}), ...r }; });
  state.routes = Object.values(byId).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
}
// Combina waypoints de la nube SOBRE los estáticos (por id): la nube manda donde
// existe (ediciones, fotos), el estático (curados + árboles) rellena el resto.
function applyCloudWaypoints(cw) {
  const fc = { type: 'FeatureCollection', features: (cw || []).map(cloudWaypointToFeature) };
  normalizeFeatures(fc);
  const byId = {};
  (state.staticWaypoints || []).forEach((w) => { byId[w.properties.id] = w; });
  fc.features.forEach((w) => {
    // Conserva atributos ricos del estático (sci, family, tag, altitud) que la
    // tabla de la nube no guarda, salvo que la nube traiga algo mejor.
    const base = byId[w.properties.id];
    if (base) w.properties = { ...base.properties, ...cleanProps(w.properties) };
    byId[w.properties.id] = w;
  });
  state.waypoints = Object.values(byId);
}
// Quita null/'' del registro de la nube para no borrar datos del estático al fusionar.
function cleanProps(p) {
  const o = {};
  for (const k in p) { const v = p[k]; if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) o[k] = v; }
  return o;
}
// Igual para especies, pero deduplicando por NOMBRE CIENTÍFICO (no por id): así
// las especies-árbol del estático y las de la nube (con distinto slug de id) no
// se duplican en la grilla; la nube manda donde exista.
function applyCloudSpecies(cs) {
  const keyOf = (s) => (s.scientific_name && s.scientific_name.trim().toLowerCase()) || ('id:' + s.id);
  const byKey = {};
  (state.staticSpecies || []).forEach((s) => { byKey[keyOf(s)] = s; });
  (cs || []).forEach((s) => { const k = keyOf(s); byKey[k] = { ...(byKey[k] || {}), ...cleanProps(s) }; });
  state.species = Object.values(byKey);
}
async function loadCloudData() {
  if (!Cloud.cloudConfigured()) return;
  try {
    const [cw, cs, cr, ct, cm] = await Promise.all([
      Cloud.listWaypoints().catch(() => null), Cloud.listSpecies().catch(() => null),
      Cloud.listRoutes().catch(() => null), Cloud.listTrails().catch(() => null),
      Cloud.listMedia().catch(() => null),
    ]);
    if (cw && cw.length) applyCloudWaypoints(cw);
    if (cs && cs.length) applyCloudSpecies(cs);
    if (cr && cr.length) applyCloudRoutes(cr);
    if (ct && ct.length) { const fc = { type: 'FeatureCollection', features: ct.map(cloudTrailToFeature) }; normalizeFeatures(fc); state.trails = fc.features; }
    if (cm) applyCloudMedia(cm);   // tabla de medios (fotos + videos) sobre las estáticas
  } catch (e) { console.warn('[cloud] datos', e && e.message); }
}
async function refreshRoutes() {
  if (!Cloud.cloudConfigured() || !navigator.onLine) return;
  try {
    const cr = await Cloud.listRoutes();
    applyCloudRoutes(cr);
    renderRouteBar();
    if (state.activeRoute && !state.routesById[state.activeRoute]) selectRoute(null);
    else if (state.activeRoute) selectRoute(state.activeRoute);
  } catch (e) { console.warn('[cloud] refreshRoutes', e && e.message); }
}
async function refreshTrails() {
  if (!Cloud.cloudConfigured() || !navigator.onLine) return;
  try {
    const ct = await Cloud.listTrails();
    const fc = { type: 'FeatureCollection', features: ct.map(cloudTrailToFeature) };
    normalizeFeatures(fc); state.trails = fc.features;
    const src = state.map && state.map.getSource('trails'); if (src) src.setData(fc);
    if (state.activeRoute) selectRoute(state.activeRoute);
  } catch (e) { console.warn('[cloud] refreshTrails', e && e.message); }
}
async function refreshWaypoints() {
  if (!Cloud.cloudConfigured() || !navigator.onLine) return;
  try {
    applyCloudWaypoints(await Cloud.listWaypoints());
    const src = state.map && state.map.getSource('waypoints');
    if (src) src.setData({ type: 'FeatureCollection', features: state.waypoints });
    renderLegend(); applyWaypointFilter();
    if (state.activeRoute) selectRoute(state.activeRoute);
  } catch (e) { console.warn('[cloud] refreshWaypoints', e && e.message); }
}
async function refreshSpecies() {
  if (!Cloud.cloudConfigured() || !navigator.onLine) return;
  try {
    applyCloudSpecies(await Cloud.listSpecies());
    renderSpeciesFilters(); renderSpeciesGrid();
  } catch (e) { console.warn('[cloud] refreshSpecies', e && e.message); }
}
async function refreshMedia() {
  if (!Cloud.cloudConfigured() || !navigator.onLine) return;
  try {
    applyCloudMedia(await Cloud.listMedia());
    renderSpeciesGrid(); refreshOpenCard();
  } catch (e) { console.warn('[cloud] refreshMedia', e && e.message); }
}

// ---------- modo offline: aplicar cambios al estado local sin red ----------
// Espejo local de lo que la nube devolvería tras un upsert/delete. Lo usa el
// editor admin (para reflejar el cambio al instante, con o sin señal) y la cola
// offline al arrancar (cambios pendientes de subir hechos en sesiones previas).
function applyLocalRow(table, row) {
  try {
    if (table === 'waypoints') {
      const fc = { type: 'FeatureCollection', features: [cloudWaypointToFeature(row)] };
      normalizeFeatures(fc);
      const i = state.waypoints.findIndex((w) => w.properties.id === row.id);
      if (i >= 0) state.waypoints[i] = fc.features[0]; else state.waypoints.push(fc.features[0]);
      const src = state.map && state.map.getSource('waypoints');
      if (src) src.setData({ type: 'FeatureCollection', features: state.waypoints });
      renderLegend(); applyWaypointFilter();
    } else if (table === 'trails') {
      const fc = { type: 'FeatureCollection', features: [cloudTrailToFeature(row)] };
      normalizeFeatures(fc);
      const i = state.trails.findIndex((t) => t.properties.id === row.id);
      if (i >= 0) state.trails[i] = fc.features[0]; else state.trails.push(fc.features[0]);
      state._trailGraph = null;   // la red cambió → recalcular el grafo de "cómo llegar"
      const src = state.map && state.map.getSource('trails');
      if (src) src.setData({ type: 'FeatureCollection', features: state.trails });
    } else if (table === 'routes') {
      const i = state.routes.findIndex((r) => r.id === row.id);
      if (i >= 0) state.routes[i] = { ...state.routes[i], ...row }; else state.routes.push(row);
      state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
      renderRouteBar();
    } else if (table === 'species') {
      const i = state.species.findIndex((s) => s.id === row.id);
      if (i >= 0) state.species[i] = { ...state.species[i], ...row }; else state.species.push(row);
      renderSpeciesFilters(); renderSpeciesGrid();
    } else if (table === 'media') {
      const list = state.cloudMedia || (state.cloudMedia = []);
      const i = list.findIndex((m) => m.id === row.id);
      if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row);
      applyCloudMedia(list);
      renderSpeciesGrid(); refreshOpenCard();
    }
    if (state.activeRoute) selectRoute(state.activeRoute);
    if (state.map && state.map.triggerRepaint) state.map.triggerRepaint();   // fuerza repintado tras el cambio
  } catch (e) { console.warn('applyLocalRow', table, e); }
}
function removeLocalRow(table, id) {
  try {
    if (table === 'waypoints') {
      state.waypoints = state.waypoints.filter((w) => w.properties.id !== id);
      const src = state.map && state.map.getSource('waypoints');
      if (src) src.setData({ type: 'FeatureCollection', features: state.waypoints });
      renderLegend(); applyWaypointFilter();
    } else if (table === 'trails') {
      state.trails = state.trails.filter((t) => t.properties.id !== id);
      state._trailGraph = null;
      const src = state.map && state.map.getSource('trails');
      if (src) src.setData({ type: 'FeatureCollection', features: state.trails });
    } else if (table === 'routes') {
      state.routes = state.routes.filter((r) => r.id !== id);
      state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
      renderRouteBar();
      if (state.activeRoute === id) { selectRoute(null); return; }
    } else if (table === 'species') {
      state.species = state.species.filter((s) => s.id !== id);
      renderSpeciesFilters(); renderSpeciesGrid();
    } else if (table === 'media') {
      state.cloudMedia = (state.cloudMedia || []).filter((m) => m.id !== id);
      applyCloudMedia(state.cloudMedia);
      renderSpeciesGrid(); refreshOpenCard();
    }
    if (state.activeRoute) selectRoute(state.activeRoute);
  } catch (e) { console.warn('removeLocalRow', table, e); }
}
// Re-renderiza la ficha abierta (punto o especie) tras cambiar sus medios.
function refreshOpenCard() {
  try {
    if (state.openSpeciesId) { const s = state.species.find((x) => x.id === state.openSpeciesId); if (s) showSpecies(s); }
    else if (state.openWaypointId) { const w = wpById(state.openWaypointId); if (w) showWaypoint(w); }
  } catch (e) { console.warn('refreshOpenCard', e && e.message); }
}
// Al arrancar: superponer los cambios que quedaron en la cola (hechos sin señal
// en una sesión anterior) sobre los datos cargados, para que no "desaparezcan".
async function applyPendingLocally() {
  try {
    for (const op of await pendingOps()) {
      if (op.op === 'delete') removeLocalRow(op.table, op.id);
      else {
        const row = { ...op.row };
        if (op.photoBlob) row.photo = URL.createObjectURL(op.photoBlob);   // compat ops viejos
        if (op.blobs) for (const f in op.blobs) if (!row[f]) row[f] = URL.createObjectURL(op.blobs[f]);
        applyLocalRow(op.table, row);
      }
    }
  } catch (e) { console.warn('[sync] pendientes', e && e.message); }
}

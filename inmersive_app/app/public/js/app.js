// Cantares — Guía interactiva de la reserva / Interactive reserve guide
// Minimal-vanilla PWA. Globals `maplibregl` and `pmtiles` come from vendored scripts.

import { GAME_I18N, initGame, refreshGameUI, capturedBadge, gameAddMapLayer, accountSummary, capturedPhotos } from './game.js';
import * as Cloud from './cloud.js';
import { initAuthGate, doLogout, inReserve } from './auth-ui.js';
import { initAdmin, openSpeciesEditor, downloadPhoto, isAdminUser, focusFromMap as adminFocusFromMap, openPointEditor, openReframe, openContentEditor, openAdminAt, closeAdmin, saveSpeciesPatch, mediaActions, getPath, setPath } from './admin.js';
import { inlineField, isEditing, setEditing, editToggleButton } from './inline-edit.js';
import { initGuide, startVisitorTourOnce } from './guide.js';
import { initRecorder, listWalks, walkCardHTML, downloadWalk, startWalk, stopWalk, isRecording, openHistory } from './recorder.js';
import { initSync, pendingOps, saveRow, deleteRow, compressImage } from './sync.js';
import { keepAwake, releaseAwake } from './wakelock.js';
import { dropboxHandleRedirect } from './dropbox.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const CONFIG = {
  center: [-75.4503, 5.0818], zoom: 15.6,
  maxBounds: [[-75.462, 5.072], [-75.439, 5.092]],
  // Llegada = estar EN el punto y verlo, no que el GPS diga «cerca». Bajo dosel
  // el fijo salta decenas de metros; con 25 m la voz arrancaba con el punto aún
  // invisible. 15 m + fijo preciso + dos fijos seguidos (ver checkProximity).
  proximityMeters: 15, reTriggerMeters: 45,
  data: {
    boundary: 'data/boundary.geojson', zones: 'data/zones.geojson',
    trails: 'data/trails.geojson', waypoints: 'data/waypoints.geojson',
    trees: 'data/trees.geojson',
    routes: 'data/routes.json', species: 'data/species.json',
    reserveInfo: 'data/reserve_info.json', media: 'data/media.json',
    historia: 'data/historia.json', comercial: 'data/comercial.json',
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
  lastTriggered: {}, navDone: {}, openWaypointId: null, baseIndex: 2, zonesVisible: false,
  reserveInfo: null, media: { bySubject: {} }, boundary: null,
  hiddenTypes: new Set(),   // tipos de punto ocultados por el usuario
  guiding: null,            // id del recorrido en modo "seguir" (GPS)
  // Modo de la audioguía: 'listen' (el teléfono lee) o 'read' (texto en pantalla).
  // Por defecto escuchar: vas caminando y mirando por dónde pisas, no la pantalla.
  tourMode: localStorage.getItem('cantares_tour_mode') || 'listen',
  atTrailhead: false,       // ¿ya llegó al inicio del recorrido?
  flowTimer: null,          // animación de flechas/flujo sobre el recorrido
  eleCache: {},             // desnivel por recorrido (cache de la API de elevación)
  routeStats: {},           // tiempo MEDIDO por recorrido (mediana de caminatas completas)
  contentFromCloud: false,  // ¿llegó la copia de la nube de las páginas de texto?
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
// Funde un tipo en TYPE_META + cache local + refresca coloreado del mapa y leyenda.
// row: {id, emoji, color, es, en}. NO escribe a la nube (eso lo hace registerPointType).
function mergePointType(row) {
  const tp = row && row.id; if (!tp) return null;
  TYPE_META[tp] = { emoji: row.emoji || '📍', color: row.color || '#5b6b60', es: row.es || tp, en: row.en || row.es || tp };
  try { const raw = JSON.parse(localStorage.getItem('cantares_types') || '{}'); raw[tp] = TYPE_META[tp]; localStorage.setItem('cantares_types', JSON.stringify(raw)); } catch (e) { /* almacenamiento lleno */ }
  const map = state.map;
  if (map && map.getLayer('waypoints-pt')) { try { map.setPaintProperty('waypoints-pt', 'circle-color', typeColorMatch()); } catch (e) { /* estilo no listo */ } }
  renderLegend();
  return tp;
}
// Aplica los tipos que vienen de la nube (la nube manda por id).
function applyCloudTypes(list) { (list || []).forEach((r) => { if (r && r.id) mergePointType(r); }); }
// Guarda un tipo con id EXPLÍCITO (editar sin renombrar el id): lo funde localmente
// Y lo sube a la nube (cola offline). row: {id,emoji,color,es,en,sort}.
function savePointType(row) {
  const id = row && row.id; if (!id) return null;
  const full = { id, emoji: row.emoji || '📍', color: row.color || '#5b6b60', es: row.es || id, en: row.en || row.es || id, sort: row.sort || 0 };
  mergePointType(full);
  saveRow('point_types', full).catch((e) => console.warn('[cloud] point_type', e && e.message));
  return id;
}
// Crea un tipo NUEVO: deriva el id (slug) del nombre. def: {tipo,emoji,color,es,en}.
function registerPointType(def) {
  const tp = String(def && def.tipo || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!tp) return null;
  return savePointType({ id: tp, emoji: def.emoji, color: def.color, es: def.es, en: def.en, sort: 0 });
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
    // Procedencia y ubicación (migración 23). Se normalizan aquí o se pierden en
    // el merge: la bandeja del admin filtra por `origin`, la sincronización local
    // deduplica por `content_hash` y `species_hint` es la conjetura del modelo,
    // que NO debe confundirse con `subject_id` (lo que un humano confirmó).
    origin: r.origin || (isCloud ? 'admin-upload' : 'curated'),
    content_hash: r.content_hash || null,
    lat: r.lat != null ? r.lat : null, lng: r.lng != null ? r.lng : null,
    taken_at: r.taken_at || null, walk_id: r.walk_id || null,
    species_hint: r.species_hint || null,
    hint_confidence: r.hint_confidence != null ? r.hint_confidence : null,
    // Carpeta del archivo de la que vino (migración 24). Sin normalizarla aquí se
    // pierde en el merge y la bandeja no puede ni mostrarla ni filtrar por ella.
    archive_dir: r.archive_dir || null,
    reviewed: r.reviewed === true,
    contributor: r.contributor || null,
  };
}
function indexMedia(doc, cloud) {
  // Dedup por id: una edición en la nube (mismo id) REEMPLAZA a la foto estática
  // del build (media.json) en vez de duplicar la tarjeta. La nube va después, así
  // gana. Esto permite reencuadrar/cambiar la portada de fotos empacadas.
  const byIdMap = new Map();
  ((doc && doc.photos) || []).forEach((p) => { const m = normMedia(p); byIdMap.set(m.id, m); });
  (cloud || []).forEach((r) => { const m = normMedia(r); byIdMap.set(m.id, m); });
  const all = [...byIdMap.values()];
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
// Contenido de páginas (Historia / Info): el documento de la nube REEMPLAZA al
// empacado (el admin edita el documento completo). Sin fila en la nube, manda el
// JSON del build, así la app funciona igual antes de correr la migración 22.
function applyCloudContent(rows) {
  (rows || []).forEach((r) => {
    if (!r || !r.doc) return;
    if (r.id === 'historia') state.historia = r.doc;
    else if (r.id === 'comercial') state.comercial = r.doc;
    else if (r.id === 'reserve_info') state.reserveInfo = r.doc;
    else if (r.id === 'freeroam') state.freeroam = r.doc;   // zona de recorrido libre (casa)
  });
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
    subtitle: 'Reserva Natural', tab_recorridos: 'Rutas', tab_restauracion: 'Historia',
    tab_especies: 'Especies', tab_juego: 'Juego', tab_info: 'Info', tab_cuenta: 'Cuenta', all_routes: 'Todos',
    dash_guest: 'Invitado', dash_guest_sub: 'Sin cuenta — tu progreso solo vive en este dispositivo',
    dash_visitor: 'Visitante', dash_admin: 'Administrador', dash_logout: 'Cerrar sesión',
    dash_create: 'Crear cuenta / entrar', dash_walks: 'recorridos', dash_dist: 'distancia',
    dash_species: 'especies', dash_points: 'puntos', dash_walks_h: 'Mis recorridos',
    dash_photos_h: 'Mis fotos', dash_no_walks: 'Aún no has grabado recorridos.',
    dash_no_photos: 'Aún no has tomado fotos de especies.',
    up_h: 'Fotos que has aportado', up_add: '＋ Subir una foto',
    up_none: 'Todavía no has aportado ninguna foto al inventario.',
    up_hint: 'Tus fotos quedan en tu cuenta. Al clasificarlas entran al inventario de la reserva cuando un administrador las revisa.',
    up_unclass: 'sin clasificar', up_class: 'en el inventario',
    up_pick: 'Clasificar', up_del: 'Borrar', up_del_sure: '¿Borrar esta foto?',
    up_pick_h: '¿Qué especie es?', up_search: 'Buscar especie…',
    up_saved: '📸 Foto guardada', up_queued: '💾 Guardada — se subirá cuando haya señal',
    up_need_account: 'Crea una cuenta para aportar fotos al inventario.',
    up_wait_upload: 'Esa foto todavía se está subiendo. Espera a que termine.',
    gps: 'GPS', gps_searching: 'Buscando…', gps_denied: 'Permiso denegado', gps_unavailable: 'Sin señal',
    gps_timeout: 'Sin respuesta', gps_unsupported: 'GPS no disponible', gps_insecure: 'El GPS requiere HTTPS',
    gps_hint_denied: 'Activa el permiso de ubicación para este sitio en el navegador.',
    gps_help_title: '📍 La guía necesita tu ubicación',
    gps_help_why: 'Sin ubicación no se puede seguir el recorrido ni avisarte cuando llegas a cada punto.',
    gps_help_denied_h: 'El permiso está bloqueado para esta página',
    gps_help_denied_1: 'Toca el candado 🔒 (o la ⓘ) junto a la dirección web, arriba.',
    gps_help_denied_2: 'Entra en «Permisos» → «Ubicación» y elige «Permitir».',
    gps_help_denied_3: 'Si instalaste la app y no ves la barra de direcciones: Ajustes de Android → Aplicaciones → Cantares → Permisos → Ubicación → Permitir.',
    gps_help_off_h: 'La ubicación del teléfono parece apagada',
    gps_help_off_1: 'Desliza desde arriba de la pantalla y enciende 📍 Ubicación.',
    gps_help_off_2: 'O en Ajustes de Android → Ubicación → activar.',
    gps_help_off_3: 'Bajo los árboles el GPS tarda: sal a un claro y espera unos segundos.',
    gps_help_note: 'Android no deja que una página web encienda la ubicación por ti — el permiso hay que darlo desde el navegador o los ajustes.',
    gps_help_retry: '🔄 Reintentar',
    gps_help_close: 'Ahora no',
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
    sp_edit: 'Editar', sp_dl: 'Descargar foto', sp_new: 'Nueva especie', sp_frame: 'Encuadrar foto',
    hist_title: 'Nuestra Historia',
    cm_services_h: '🎟️ Servicios y tarifas', cm_extra_h: 'Servicios adicionales',
    cm_rates_note: 'Tarifas tomadas del documento de servicios y tarifas de la reserva',
    cm_book_h: '📅 Reservar y seguirnos', cm_airbnb: 'Reservar en Airbnb',
    cm_wa_sub: 'Escríbenos', cm_email: 'Correo',
    cm_reviews_h: '⭐ Comentarios de huéspedes', cm_reviews_n: 'comentarios',
    cm_reviews_empty: 'Aún no hemos copiado los comentarios de Airbnb aquí. Puedes leerlos en el anuncio.',
    cm_more: 'Ver más comentarios', cm_translated: 'traducido',
    ce_edit: 'Editar esta página', ce_edit_info: 'Editar servicios y comentarios',
    ce_edit_visit: 'Editar datos de la visita',
    tree_photo: 'Árbol', leaf_photo: 'Hoja',
    lg_points_head: 'Tipos de punto',
    z_conservacion: 'Conservación', z_uso_intensivo: 'Uso intensivo', z_agroecosistema: 'Agrosistema', z_transicion: 'Transición',
    base_hd: 'Actual (HD)', base_ortho: 'Ortofoto',
    base_compare_a11y: 'Arrastra para comparar el bosque de antes con el de ahora',
    help_a11y: 'Ayuda',
    ri_points: 'Puntos del recorrido', ri_start_walk: '▶ Comenzar recorrido', ri_stop_walk: '■ Terminar recorrido',
    guiding_on: 'Siguiendo tu ubicación en el sendero…', guiding_off: 'Recorrido terminado',
    guiding_on_site: '🔒 Para hacer el recorrido guiado tienes que estar en la reserva.',
    no_points: 'No hay puntos visibles con los filtros activos.',
    rest_title: 'Restauración',
    rest_lead: 'De potrero de kikuyo a bosque. La reserva tiene <strong>16,4 ha en restauración</strong>, donde el ganado salió hacia ~2019 y hoy crecen especies nativas.',
    ndvi_h: '🌿 Reverdecimiento (NDVI)', ndvi_p: 'Serie temporal Sentinel-2 2019 → hoy en la zona de restauración vs. la de conservación (control).',
    ndvi_pending: 'Próximamente: el gráfico del reverdecimiento de la reserva medido por satélite (2019 → hoy).',
    guiding_confirm_end: '¿Terminar el recorrido guiado?',
    guiding_screen: '🔆 La pantalla quedará encendida durante el recorrido',
    guiding_screen_warn: '⚠️ Mantén la pantalla encendida: si se apaga, se pierden los avisos de los puntos',
    tour_ask: '¿Cómo quieres la guía?', tour_listen: '🔊 Escuchar', tour_read: '📖 Leer',
    tour_listen_sub: 'El teléfono lee cada punto en voz alta', tour_read_sub: 'El texto aparece en pantalla',
    tour_test: '🔈 Probar la voz ahora', tour_usual: 'lo que sueles elegir',
    tour_test_line: 'Bienvenido a la Reserva Natural Cantares. Si escuchas esta frase, la voz de la audioguía funciona.',
    tour_no_tts: 'Este teléfono no tiene ninguna voz instalada, así que la audioguía se leerá en pantalla. Para oírla: Ajustes → Accesibilidad → Texto a voz, e instala una voz en español.',
    gc_to_read: 'Cambiar a leer en pantalla', gc_to_listen: 'Cambiar a escuchar en voz alta',
    gc_now_read: '📖 Ahora la guía se lee en pantalla', gc_now_listen: '🔊 Ahora la guía se escucha en voz alta',
    th_title: 'Ve al inicio del recorrido', th_go: '🧭 Cómo llegar',
    th_close: 'Ya estoy aquí', th_arrived: '✓ Llegaste al inicio. ¡Buen camino!',
    nav_next: '➡️ Siguiente', nav_to_end: 'Final del recorrido',
    data_missing: '⚠️ Faltan datos por descargar (no se alcanzaron a guardar). El mapa y los senderos funcionan; vuelve a abrir la app con señal para completar.',
    gc_close: 'Seguir', gc_listen: '🔊 Escuchar de nuevo',
    ortho_h: '🛰️ Antes / después (ortofoto)', ortho_p: 'Ortofoto fotogramétrica de la reserva (~4,4 cm/píxel).',
    carbon_h: '🌳 Carbono capturado',
    especies_h: 'Especies', especies_lead: 'Reconoce la fauna y flora de Cantares. Cada avistamiento alimenta el inventario de la reserva.',
    sp_search_ph: 'Buscar por nombre común, científico o familia…', sp_no_match: 'Ninguna especie coincide con',
    sp_edit_full: 'Ficha completa…', ie_on: '✏️ Editar', ie_off: '✓ Listo',
    desc_source: 'Fuente', desc_in_en: 'Esta descripción sólo está disponible en inglés.',
    desc_in_es: 'Esta descripción sólo está disponible en español.',
    ce_sections: 'Secciones…', ie_no_cloud: 'Sin señal no se puede editar esta página: no sé qué había guardado y lo pisaría.',
    f_all: 'Todas', f_flagship: '★ Destacadas', f_flora: '🌳 Flora', f_aves: '🐦 Aves', f_mam: '🐾 Mamíferos', f_anf: '🐸 Anfibios',
    f_seen: '👁 Vistas', f_potential: '✨ Potenciales', f_bothtier: 'Ambas',
    f_mapped: '📍 En el mapa', f_listed: '📋 Solo en el listado',
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
    grp_flora: 'Flora', grp_ave: 'Aves', grp_mamifero: 'Mamíferos',
    online: '🟢 En línea. Abre el mapa aquí (wifi) para guardar los tiles y luego funciona sin señal en el sendero.',
    offline: '⚪ Sin conexión. La app y el contenido guardado siguen disponibles.',
    sw_new_version: '🔄 Hay una versión nueva. Cierra lo que tengas abierto y recarga.',
    ob_title: 'Bienvenido a Cantares',
    ob_p_map: 'Mapa con tu ubicación en vivo en el sendero',
    ob_p_species: 'Especies, avistamientos y un juego de exploración',
    ob_p_offline: 'Funciona sin señal una vez cargada',
    ob_tip: 'Consejo: abre el mapa ahora con wifi para guardarlo y usarlo sin conexión.',
    ob_go: 'Explorar la reserva →',
    visit_h: 'Planea tu visita', v_hours: '🕑 Horarios', v_contact: '📞 Contacto',
    v_arrive: '🚗 Cómo llegar', v_parking: '🅿️ Parqueo', v_entry: '🎟️ Entrada',
    v_rules_h: '📋 Normas de la reserva', v_call: 'Llamar',
    v_pending: 'Por completar', v_whatsapp: 'WhatsApp',
    demo_note: 'Cifras preliminares de demostración — pronto con el inventario real de árboles de la reserva.',
    key_trees: 'árboles clave', agb: 'biomasa aérea',
  },
  en: {
    subtitle: 'Nature Reserve', tab_recorridos: 'Trails', tab_restauracion: 'Story',
    tab_especies: 'Species', tab_juego: 'Game', tab_info: 'Info', tab_cuenta: 'Account', all_routes: 'All',
    dash_guest: 'Guest', dash_guest_sub: 'No account — your progress stays only on this device',
    dash_visitor: 'Visitor', dash_admin: 'Administrator', dash_logout: 'Log out',
    dash_create: 'Sign up / log in', dash_walks: 'walks', dash_dist: 'distance',
    dash_species: 'species', dash_points: 'points', dash_walks_h: 'My walks',
    dash_photos_h: 'My photos', dash_no_walks: "You haven't recorded any walks yet.",
    dash_no_photos: "You haven't taken any species photos yet.",
    up_h: 'Photos you contributed', up_add: '＋ Upload a photo',
    up_none: "You haven't contributed any photos to the inventory yet.",
    up_hint: 'Your photos stay in your account. Once classified they join the reserve inventory when an admin reviews them.',
    up_unclass: 'unclassified', up_class: 'in the inventory',
    up_pick: 'Classify', up_del: 'Delete', up_del_sure: 'Delete this photo?',
    up_pick_h: 'Which species is it?', up_search: 'Search species…',
    up_saved: '📸 Photo saved', up_queued: '💾 Saved — will upload when you have signal',
    up_need_account: 'Create an account to contribute photos to the inventory.',
    up_wait_upload: 'That photo is still uploading. Wait for it to finish.',
    gps: 'GPS', gps_searching: 'Locating…', gps_denied: 'Permission denied', gps_unavailable: 'No signal',
    gps_timeout: 'Timed out', gps_unsupported: 'GPS unavailable', gps_insecure: 'GPS needs HTTPS',
    gps_hint_denied: 'Enable location permission for this site in your browser.',
    gps_help_title: '📍 The guide needs your location',
    gps_help_why: 'Without location it cannot follow the route or tell you when you reach each point.',
    gps_help_denied_h: 'Permission is blocked for this page',
    gps_help_denied_1: 'Tap the padlock 🔒 (or the ⓘ) next to the web address at the top.',
    gps_help_denied_2: 'Open “Permissions” → “Location” and choose “Allow”.',
    gps_help_denied_3: 'If you installed the app and see no address bar: Android Settings → Apps → Cantares → Permissions → Location → Allow.',
    gps_help_off_h: 'Your phone location seems to be off',
    gps_help_off_1: 'Swipe down from the top of the screen and turn on 📍 Location.',
    gps_help_off_2: 'Or Android Settings → Location → turn on.',
    gps_help_off_3: 'Under the canopy GPS is slow: step into a clearing and wait a few seconds.',
    gps_help_note: 'Android does not let a web page turn location on for you — the permission has to be granted from the browser or the settings.',
    gps_help_retry: '🔄 Try again',
    gps_help_close: 'Not now',
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
    sp_edit: 'Edit', sp_dl: 'Download photo', sp_new: 'New species', sp_frame: 'Frame photo',
    hist_title: 'Our Story',
    cm_services_h: '🎟️ Services & rates', cm_extra_h: 'Add-on services',
    cm_rates_note: 'Rates taken from the reserve services & rates document',
    cm_book_h: '📅 Book & follow us', cm_airbnb: 'Book on Airbnb',
    cm_wa_sub: 'Message us', cm_email: 'Email',
    cm_reviews_h: '⭐ Guest reviews', cm_reviews_n: 'reviews',
    cm_reviews_empty: 'We have not copied the Airbnb reviews here yet. You can read them on the listing.',
    cm_more: 'Show more reviews', cm_translated: 'translated',
    ce_edit: 'Edit this page', ce_edit_info: 'Edit services and reviews',
    ce_edit_visit: 'Edit visit details',
    tree_photo: 'Tree', leaf_photo: 'Leaf',
    lg_points_head: 'Point types',
    z_conservacion: 'Conservation', z_uso_intensivo: 'Intensive use', z_agroecosistema: 'Agrosystem', z_transicion: 'Transition',
    base_hd: 'Current (HD)', base_ortho: 'Orthophoto',
    base_compare_a11y: 'Drag to compare the forest then and now',
    help_a11y: 'Help',
    ri_points: 'Route points', ri_start_walk: '▶ Start route', ri_stop_walk: '■ End route',
    guiding_on: 'Following your location on the trail…', guiding_off: 'Route ended',
    guiding_on_site: '🔒 To take the guided route you need to be at the reserve.',
    no_points: 'No points visible with the active filters.',
    rest_title: 'Restoration',
    rest_lead: 'From kikuyu pasture to forest. The reserve has <strong>16.4 ha under restoration</strong>, where cattle left around 2019 and native species now grow.',
    ndvi_h: '🌿 Greening (NDVI)', ndvi_p: 'Sentinel-2 time series 2019 → today in the restoration zone vs. the conservation zone (control).',
    ndvi_pending: 'Coming soon: a satellite-measured greening chart of the reserve (2019 → today).',
    guiding_confirm_end: 'End the guided route?',
    guiding_screen: '🔆 The screen will stay on during the route',
    guiding_screen_warn: '⚠️ Keep the screen on: if it turns off, point alerts stop',
    tour_ask: 'How would you like the guide?', tour_listen: '🔊 Listen', tour_read: '📖 Read',
    tour_listen_sub: 'Your phone reads each point aloud', tour_read_sub: 'The text appears on screen',
    tour_test: '🔈 Test the voice now', tour_usual: 'what you usually pick',
    tour_test_line: 'Welcome to Cantares Nature Reserve. If you can hear this sentence, the audio guide works.',
    tour_no_tts: 'This phone has no speech voice installed, so the guide will be shown on screen. To hear it: Settings → Accessibility → Text-to-speech, and install a voice.',
    gc_to_read: 'Switch to reading on screen', gc_to_listen: 'Switch to listening aloud',
    gc_now_read: '📖 The guide is now read on screen', gc_now_listen: '🔊 The guide is now spoken aloud',
    th_title: 'Head to the start of the route', th_go: '🧭 Directions',
    th_close: "I'm here", th_arrived: '✓ You reached the start. Enjoy the walk!',
    nav_next: '➡️ Next', nav_to_end: 'End of the route',
    data_missing: '⚠️ Some data never finished downloading. The map and trails work; reopen the app with signal to complete it.',
    gc_close: 'Continue', gc_listen: '🔊 Play again',
    ortho_h: '🛰️ Before / after (orthophoto)', ortho_p: 'Photogrammetric orthophoto of the reserve (~4.4 cm/pixel).',
    carbon_h: '🌳 Carbon captured',
    especies_h: 'Species', especies_lead: 'Get to know the wildlife and plants of Cantares. Every sighting feeds the reserve inventory.',
    sp_search_ph: 'Search by common name, scientific name or family…', sp_no_match: 'No species match',
    sp_edit_full: 'Full record…', ie_on: '✏️ Edit', ie_off: '✓ Done',
    desc_source: 'Source', desc_in_en: 'This description is only available in English.',
    desc_in_es: 'This description is only available in Spanish.',
    ce_sections: 'Sections…', ie_no_cloud: 'Offline this page cannot be edited: I do not know what was saved and would overwrite it.',
    f_all: 'All', f_flagship: '★ Flagship', f_flora: '🌳 Plants', f_aves: '🐦 Birds', f_mam: '🐾 Mammals', f_anf: '🐸 Amphibians',
    f_seen: '👁 Seen', f_potential: '✨ Possible', f_bothtier: 'Both',
    f_mapped: '📍 On the map', f_listed: '📋 List only',
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
    grp_flora: 'Plants', grp_ave: 'Birds', grp_mamifero: 'Mammals',
    online: '🟢 Online. Open the map here (wifi) to cache tiles, then it works with no signal on the trail.',
    offline: '⚪ Offline. The app and cached content are still available.',
    sw_new_version: '🔄 A new version is available. Close what you have open and reload.',
    ob_title: 'Welcome to Cantares',
    ob_p_map: 'A map with your live position on the trail',
    ob_p_species: 'Species, sightings and an exploration game',
    ob_p_offline: 'Works with no signal once loaded',
    ob_tip: 'Tip: open the map now on wifi to save it and use it offline.',
    ob_go: 'Explore the reserve →',
    visit_h: 'Plan your visit', v_hours: '🕑 Hours', v_contact: '📞 Contact',
    v_arrive: '🚗 Getting there', v_parking: '🅿️ Parking', v_entry: '🎟️ Entry',
    v_rules_h: '📋 Reserve rules', v_call: 'Call',
    v_pending: 'To be filled in', v_whatsapp: 'WhatsApp',
    demo_note: 'Preliminary demo figures — the real tree inventory of the reserve is coming soon.',
    key_trees: 'key trees', agb: 'above-ground biomass',
  },
};
// Merge the game's strings into the app dictionary (game.js owns its own keys).
Object.keys(GAME_I18N).forEach((lang) => Object.assign(I18N[lang] = I18N[lang] || {}, GAME_I18N[lang]));

let LANG = localStorage.getItem('cantares_lang') || 'es';
const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.es[k] || k;
// Cae al OTRO idioma en los dos sentidos. Antes sólo caía inglés→español: un
// visitante inglés veía el texto español cuando faltaba el suyo, pero uno
// español veía un HUECO cuando el texto sólo existía en inglés. Deja de ser
// teórico con las 191 descripciones de aves traídas de Wikipedia, que nacen
// sólo en inglés: media ficha en blanco para el idioma principal de la reserva.
// Un texto en el otro idioma es más útil que nada — `descLangNote` avisa de en
// cuál está. La audioguía NO pasa por aquí: `scriptLine` elige su propio idioma
// y se niega a leer español con voz inglesa.
const L = (obj, field) => (LANG === 'en'
  ? (obj[field + '_en'] || obj[field])
  : (obj[field] || obj[field + '_en']));

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
  // La atribución la pone el mapa principal (customAttribution): estos mapas no
  // llevan control, y repetirla aquí no la mostraría en ninguna parte.
  return { type: 'raster', tiles: [stop.tiles], tileSize: 256, maxzoom: 19 };
}
function baseLabel(stop) { return stop.hd ? t('base_hd') : stop.pmtiles ? t('base_ortho') : stop.key; }
// El mapa PRINCIPAL ya no lleva imagen ni fondo: sólo zonas, senderos, puntos y
// la posición. Va TRANSPARENTE encima de los mapas de imagen, que son los que se
// parten con la cortina. Así lo dibujado es UNO SOLO y cubre todo el ancho: al
// mover la cortina cambia la foto de debajo y nada más — ni un punto ni un
// sendero desaparecen. (MapLibre pide su contexto WebGL con alpha, así que un
// estilo sin capa `background` deja ver lo que hay detrás.)
function buildStyle() {
  return { version: 8, sources: {}, layers: [] };
}
// Estilo de un mapa de IMAGEN: una sola capa raster, nada más.
function imageryStyle(stop) {
  return { version: 8, sources: { base: baseSourceDef(stop) },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#c9d3c6' } },
      { id: 'base', type: 'raster', source: 'base' },
    ] };
}

// ---------- el bosque en el tiempo: cortina vertical ----------
// Como los comparadores de imágenes de siempre (el swipe de Esri Wayback,
// mapbox-gl-compare): una línea vertical fija en pantalla, el pasado a la
// izquierda y el presente a la derecha.
//
// La pieza que lo hace funcionar es CÓMO se reparten las capas. Hay tres lienzos:
//
//   [ abajo ]  #img-old  imagen antigua, ancho completo, nunca se recorta
//   [ medio ]  #img-now  imagen actual, recortada a la derecha de la línea
//   [ arriba ] #map      zonas, senderos, puntos, GPS — TRANSPARENTE y sin recortar
//
// Lo dibujado vive sólo en el mapa de arriba y cubre todo el ancho, así que al
// mover la cortina cambia la foto de debajo y NADA más: ningún punto ni sendero
// desaparece de un lado. (Antes el pasado iba encima y tapaba media leyenda de
// puntos — que es justo lo que no se quería.)
//
// Los dos mapas de imagen son sólo raster, sin eventos ni símbolos, y siguen a la
// cámara del principal. Al hacer zoom los dos van igual de acompasados, así que
// la costura entre ellos no se rompe; lo único que puede quedar un fotograma por
// delante es lo dibujado, y eso no se nota.
const imgMaps = { old: null, now: null };
function cmpOldStop() { return CONFIG.baseStops[0]; }
function cmpNowStop() { return CONFIG.baseStops[state.baseIndex]; }

function makeImageryMap(el, stop) {
  const m = state.map;
  return new maplibregl.Map({
    container: el, interactive: false, attributionControl: false,
    // Sin `maxBounds` a propósito: el principal ya lo impone y repetirlo aquí
    // haría que los dos encuadres se pelearan en los bordes.
    center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch(),
    style: imageryStyle(stop),
    // Estos dos mapas son un FONDO que sigue al principal, no una capa que se
    // explora: el desvanecido de tiles y la revalidación por expiración sólo
    // añaden repintados en cada paso del zoom.
    fadeDuration: 0, refreshExpiredTiles: false,
  });
}
// Mover el mapa principal obliga a redibujar los DOS mapas de imagen: son tres
// lienzos WebGL por fotograma, y en un monitor grande con rueda de ratón es
// donde el zoom se siente pesado. Dos recortes, sin cambiar lo que se ve:
//   1. una sola sincronización por fotograma (MapLibre dispara 'move' varias
//      veces por cuadro durante el zoom y la inercia);
//   2. no se sincroniza el mapa que está TAPADO por la cortina — si la línea
//      está en un extremo, uno de los dos no se ve y redibujarlo es gratis
//      sólo en apariencia. Al reaparecer se pone al día en el mismo cuadro.
let _syncRaf = 0;
function syncImagery() {
  if (_syncRaf) return;
  _syncRaf = requestAnimationFrame(() => {
    _syncRaf = 0;
    const m = state.map; if (!m) return;
    const c = { center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() };
    const pct = state.comparePct == null ? 50 : state.comparePct;
    // Guiando (y eligiendo puntos) el CSS quita el recorte: la imagen actual
    // cubre todo y la antigua no se ve. Hay que mirar eso, no sólo la cortina,
    // o durante la navegación se congelaría la única imagen visible.
    const clipOff = document.body.classList.contains('guiding') || document.body.classList.contains('picking-points');
    if (imgMaps.old && !clipOff && pct < 99.5) imgMaps.old.jumpTo(c);   // la antigua asoma
    if (imgMaps.now && (clipOff || pct > 0.5)) imgMaps.now.jumpTo(c);   // la actual asoma
  });
}
// pct = posición de la línea, 0 (todo pasado) a 100 (todo presente).
function setCompare(pct) {
  const x = Math.max(0, Math.min(100, pct));
  state.comparePct = x;
  const h = $('#bc-handle'), now = $('#img-now');
  if (h) { h.style.left = x + '%'; h.setAttribute('aria-valuenow', String(Math.round(x))); }
  // La imagen ACTUAL se recorta por la izquierda: se ve de la línea hacia la
  // derecha. Lo que asoma a su izquierda es la antigua, que está debajo entera.
  if (now) now.style.clipPath = `inset(0 0 0 ${x.toFixed(2)}%)`;
  syncImagery();   // el mapa que vuelve a asomar se pone al día (gratis: va por rAF)
}
function initCompare() {
  const h = $('#bc-handle'); if (!h || !state.map) return;
  const elOld = $('#img-old'), elNow = $('#img-now');
  if (!elOld || !elNow) return;
  // Diagnóstico: `?noimg` arranca SIN los dos mapas de imagen (queda el dibujo
  // sobre fondo liso). Sirve para saber en 10 segundos si el zoom pesado son
  // ellos o el mapa principal, sin adivinar. Mismo espíritu que `?nomap`.
  if (new URLSearchParams(location.search).has('noimg')) {
    elOld.style.display = elNow.style.display = 'none';
    const bc = $('#base-compare'); if (bc) bc.style.display = 'none';
    return;
  }
  $('#bc-old').textContent = baseLabel(cmpOldStop());
  $('#bc-new').textContent = baseLabel(cmpNowStop());
  imgMaps.old = makeImageryMap(elOld, cmpOldStop());
  imgMaps.now = makeImageryMap(elNow, cmpNowStop());
  // Arranca en el MEDIO: la comparación es el punto, así que se ve nada más
  // abrir en vez de esconderse en un borde a esperar que alguien la descubra.
  setCompare(50);
  // 'move' cubre arrastrar, zoom, rotar y los vuelos de selectRoute.
  state.map.on('move', syncImagery);
  state.map.on('resize', syncImagery);
  syncImagery();

  const pctFrom = (clientX) => {
    const r = $('#map').getBoundingClientRect();
    return ((clientX - r.left) / (r.width || 1)) * 100;
  };
  let dragging = false;
  h.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { h.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    e.stopPropagation();   // arrastrar la línea no debe panear el mapa
  });
  h.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    setCompare(pctFrom(e.clientX));
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { h.releasePointerCapture(e.pointerId); } catch (er) { /* ignore */ }
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  // Teclado: es un role="slider", así que las flechas tienen que moverlo.
  h.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -100, End: 100 }[e.key];
    if (step == null) return;
    e.preventDefault();
    setCompare(Math.abs(step) === 100 ? (step < 0 ? 0 : 100) : state.comparePct + step);
  });
  h.style.touchAction = 'none';
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
// Haz de brújula: abanico translúcido con vértice en el usuario, dibujado
// apuntando hacia ARRIBA (norte del mapa a icon-rotate=0). pixelRatio:2 → nítido
// en retina; tamaño lógico ≈64 px.
function makeHeadingCone(map) {
  if (map.hasImage('heading-cone')) return;
  const S = 128, cx = S / 2, cy = S / 2, R = 54, half = 30 * Math.PI / 180;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(cx, cy, 6, cx, cy, R);
  g.addColorStop(0, 'rgba(43,140,190,0.55)'); g.addColorStop(1, 'rgba(43,140,190,0)');
  x.fillStyle = g;
  x.beginPath(); x.moveTo(cx, cy);
  x.arc(cx, cy, R, -Math.PI / 2 - half, -Math.PI / 2 + half); x.closePath(); x.fill();
  map.addImage('heading-cone', x.getImageData(0, 0, S, S), { pixelRatio: 2 });
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
    maxBounds: CONFIG.maxBounds,
    // La atribución de Esri venía de la fuente raster, que ahora vive en los
    // mapas de imagen (sin control propio, para no repetirla dos veces sobre el
    // mismo mapa). Se declara aquí a mano: es obligatoria por licencia y sin
    // esto habría desaparecido de la pantalla sin que nada fallara.
    attributionControl: { compact: true, customAttribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
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
      makeHeadingCone(map);
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
      // Haz de dirección (estilo Google Maps): sólo aparece cuando hay rumbo de
      // brújula. rotation-alignment:'map' → MapLibre lo mantiene correcto aunque
      // el mapa esté rotado; icon-rotate = rumbo en grados horarios desde el norte.
      map.addLayer({ id: 'user-heading', type: 'symbol', source: 'user',
        filter: ['has', 'heading'],
        layout: { 'icon-image': 'heading-cone', 'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
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
  hist.innerHTML = `<span class="emoji">📖</span>${t('my_walks')}`;
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

// ---------- zona de recorrido libre (el claro de la casa) ----------
// Alrededor de la casa no hay sendero que seguir: hay pasto, y la traza real
// zigzaguea porque así se caminó el día que se grabó. Como guía eso no dice
// nada. Dentro del polígono el recorrido se dibuja RECTO: se conservan el
// vértice por donde entra y aquel por donde sale, y se tira todo lo de en medio.
// El polígono lo dibuja el admin y vive en la tabla `content` (id 'freeroam');
// sin polígono definido, todo esto es un no-op y el trazado queda como estaba.
function inPolygon(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function freeRoamRing() {
  const p = state.freeroam && state.freeroam.polygon;
  return Array.isArray(p) && p.length >= 4 ? p : null;   // anillo cerrado mínimo
}
// `keep` es la máscara paralela de orderedPathFromSegments: las coordenadas que
// vienen de un TRAZO LIBRE se respetan tal cual. Ese trazo está dibujado a
// propósito dentro de la zona, así que enderezarlo lo borraría entero — es
// exactamente lo contrario de lo que se pidió al dibujarlo.
function freeRoamPath(cs, keep) {
  const ring = freeRoamRing();
  if (!ring || !Array.isArray(cs) || cs.length < 3) return cs;
  const out = [];
  let i = 0;
  while (i < cs.length) {
    if (!inPolygon(cs[i], ring)) { out.push(cs[i]); i++; continue; }
    let j = i;                                   // tramo consecutivo dentro de la zona
    while (j + 1 < cs.length && inPolygon(cs[j + 1], ring)) j++;
    let drawn = false;
    if (keep) for (let k = i; k <= j && !drawn; k++) drawn = !!keep[k];
    if (drawn) { for (let k = i; k <= j; k++) out.push(cs[k]); }   // dibujado: intacto
    else {
      out.push(cs[i]);                           // por donde entra
      if (j > i) out.push(cs[j]);                // por donde sale (recta entre los dos)
    }
    i = j + 1;
  }
  return out.length >= 2 ? out : cs;
}

// Encadena senderos en el ORDEN dado (route.segments), orientando cada uno para
// conectar con el anterior. Ese orden fija la dirección del recorrido.
const trailById = (tid) => state.trails.find((t) => t.properties.id === tid);
// Un tramo del recorrido es un sendero de la red O un TRAZO LIBRE propio del
// recorrido (`free:<clave>` → route.freeroam_paths[clave]). El trazo libre no
// es un sendero: no está en `trails`, no sale en la lista de senderos y no se
// reutiliza en otro recorrido. Existe para poder pasar por donde no hay sendero
// —el claro de la casa— sin ensuciar la red con uno inventado.
const FREE_SEG = 'free:';
const isFreeSeg = (id) => String(id || '').startsWith(FREE_SEG);
const freeSegKey = (id) => String(id).slice(FREE_SEG.length);
function segCoords(id, freePaths) {
  if (isFreeSeg(id)) {
    const cs = freePaths && freePaths[freeSegKey(id)];
    return Array.isArray(cs) && cs.length >= 2 ? cs.slice() : null;
  }
  const t = trailById(id);
  return t ? t.geometry.coordinates.slice() : null;
}
// Devuelve { path, free }: el trazado encadenado y, en paralelo, qué coordenadas
// vienen de un trazo libre. Ese marcador es lo que impide luego que freeRoamPath
// enderece —y borre— justo lo que se dibujó a mano.
function orderedPathFromSegments(ids, freePaths) {
  const segs = [];
  (ids || []).forEach((id) => { const cs = segCoords(id, freePaths); if (cs) segs.push({ cs, free: isFreeSeg(id) }); });
  if (!segs.length) return null;
  let path = segs[0].cs.slice(), free = path.map(() => segs[0].free);
  if (segs.length > 1) {   // orientar el primero según por dónde sigue el segundo
    const n = segs[1].cs;
    const endToNext = Math.min(haversine(path[path.length - 1], n[0]), haversine(path[path.length - 1], n[n.length - 1]));
    const startToNext = Math.min(haversine(path[0], n[0]), haversine(path[0], n[n.length - 1]));
    if (startToNext < endToNext) { path.reverse(); free.reverse(); }
  }
  for (let i = 1; i < segs.length; i++) {
    let seg = segs[i].cs; const tail = path[path.length - 1];
    if (haversine(tail, seg[seg.length - 1]) < haversine(tail, seg[0])) seg = seg.slice().reverse();
    const add = haversine(tail, seg[0]) < 5 ? seg.slice(1) : seg;   // soldar si se tocan
    path = path.concat(add); free = free.concat(add.map(() => segs[i].free));
  }
  return { path, free };
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
    const built = orderedPathFromSegments(route.segments, route.freeroam_paths);
    let path = built && freeRoamPath(built.path, built.free);
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
  info.path = freeRoamPath(path);
  return info;
}

// Ordena unos puntos EN EL SENTIDO en que se recorren, dados los senderos (en
// orden) y el punto de inicio. Es la misma proyección sobre el trazado que usa
// la caja de información del recorrido; el editor la reutiliza para que los
// guiones salgan en el orden en que el visitante llega a cada punto, no en el
// orden en que el admin los fue tocando en el mapa.
function orderPointsAlongSegments(segIds, ptIds, startId, endId, freePaths) {
  const ids = (ptIds || []).slice();
  const sWp = startId ? wpById(startId) : null;
  const eWp = endId ? wpById(endId) : null;
  // Con los trazos libres puestos: los puntos del claro se proyectan sobre el
  // trazado que se dibujó, no sobre la recta que dejaría el enderezado.
  const built = orderedPathFromSegments(segIds || [], freePaths);
  let path = built && built.path;
  // Sin senderos elegidos no había trazado sobre el que proyectar y los puntos
  // se quedaban en el orden en que el admin los fue TOCANDO en el mapa — que no
  // es el orden en que se caminan. Se deduce el camino por la red de senderos
  // (inicio→fin), igual que hace buildRoutePath cuando falta `segments`.
  if ((!path || path.length < 2) && sWp && eWp) {
    const r = routeOnTrails(sWp.geometry.coordinates, eWp.geometry.coordinates);
    if (r && r.coords.length >= 2) path = r.coords;
  }
  // Último recurso: distancia al punto de inicio. Con un solo extremo fijo no hay
  // «sentido» del recorrido, pero sigue siendo mejor que el orden de los toques.
  if (!path || path.length < 2) {
    if (!sWp) return ids;
    const sC = sWp.geometry.coordinates;
    const dTo = (id) => { const w = wpById(id); return w ? haversine(sC, w.geometry.coordinates) : Infinity; };
    return ids.sort((a, b) => dTo(a) - dTo(b));
  }
  if (sWp) {                                                // orientar start→end
    const sC = sWp.geometry.coordinates;
    if (haversine(path[0], sC) > haversine(path[path.length - 1], sC)) path = path.slice().reverse();
  } else if (eWp) {                                         // sin inicio: orientar por el fin
    const eC = eWp.geometry.coordinates;
    if (haversine(path[0], eC) < haversine(path[path.length - 1], eC)) path = path.slice().reverse();
  }
  const pos = new Map();
  ids.forEach((id) => { const w = wpById(id); pos.set(id, w ? pathPos(path, w.geometry.coordinates) : Infinity); });
  return ids.sort((a, b) => pos.get(a) - pos.get(b));
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
  // Quien pidió menos animación no la recibe: son 11 repintados por segundo,
  // permanentes, y el recorrido se entiende igual sin ellos.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let i = 0;
  state.flowTimer = setInterval(() => {
    // Mientras el usuario mueve o hace zoom, la animación se calla. Cambiar
    // `line-dasharray` invalida el atlas de líneas de MapLibre y lo obliga a
    // rehacer el trazado: hacerlo 11 veces por segundo EN MEDIO de un zoom es
    // lo que hace que el zoom se sienta pesado y retrasado (sobre todo con
    // rueda de ratón, que genera muchos más fotogramas que un pellizco).
    // La animación se reanuda sola al soltar.
    if (map.isMoving() || map.isZooming() || map.isRotating()) return;
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
  // Fuera del recorrido guiado, TODOS los puntos siguen visibles (salvo los tipos
  // que el usuario ocultó): un recorrido activo sólo atenúa los no asociados.
  // DENTRO del recorrido guiado se ocultan de verdad — caminando, 263 puntos en
  // pantalla son ruido; los únicos que importan son los del recorrido.
  const focusClause = state.guiding ? [['in', state.guiding, ['get', 'routes']]] : [];
  map.setFilter('waypoints-pt', ['all', ['!=', ['get', 'tipo'], 'arbol'], ...hiddenClause, ...focusClause]);
  if (map.getLayer('trees-pt')) {
    // Los árboles no pertenecen a un recorrido: en modo guiado se dejan sólo los
    // que están junto al camino (computeNearbyTrees), que sí vas a ver al pasar.
    const treeFocus = state.guiding ? [['in', ['get', 'id'], ['literal', state.nearbyTrees || []]]] : [];
    map.setFilter('trees-pt', ['all', ['==', ['get', 'tipo'], 'arbol'], ...hiddenClause, ...treeFocus]);
  }
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
// Un unico predicado de permiso en toda la app. El flag `cantares_guest` dice
// que ELIGIO en la puerta; la sesion dice a que tiene DERECHO. Solo lo segundo
// es una entitlement, y los dos discrepaban al caducar la sesion: sin flag de
// invitado el recorrido guiado se abria, y sin `cloud.user` el juego se cerraba.
const hasAccount = () => !!Cloud.currentUser();
// Geocerco CACHEADO, evaluado con la ultima posicion conocida. No se pide un
// fijo nuevo: uno de alta precision cuesta ~12 s de radio a plena potencia bajo
// dosel, y aqui la respuesta no vale eso. Sin posicion falla ABIERTO --el gate
// de cuenta ya exige haberse dado de alta DENTRO de la reserva-- igual que en
// el juego (decision 2026-08-25).
let _outsideReserve = false, _geoCheckedAt = null;
function refreshOutsideReserve() {
  const p = state.userPos;
  if (!p) return;
  // Re-evaluar en cada fijo es tirar trabajo: 25 m no cambian de que lado del
  // lindero estas, y el buffer del geocerco son 75 m.
  if (_geoCheckedAt && haversine(_geoCheckedAt, p) < 25) return;
  _geoCheckedAt = p;
  inReserve(p, state.userAccuracy || 0).then((inside) => { _outsideReserve = !inside; });
}
// Derecho a la GUIA: cuenta Y estar en la reserva. Cubre empezar el recorrido y
// oir/leer el guion de un punto, que son la misma cosa -- el guion ES el
// recorrido guiado, y hasta ahora se regalaba con un toque en el punto.
const canGuide = () => hasAccount() && !_outsideReserve;
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
      ${built ? `<div class="ri-stats"><span class="ri-stat">📏 ${fmtDist(pathLengthM(built.path))}</span><span class="ri-stat" id="ri-ele">⛰️ …</span><span class="ri-stat" id="ri-time">⏱️ …</span></div>` : ''}
      ${(sLbl || eLbl) ? `<div class="ri-ends">
        ${sLbl ? `<span class="ri-end-item"><span class="ri-dot start"></span>${t('lg_start')}: ${escapeHtml(sLbl)}</span>` : ''}
        ${eLbl ? `<span class="ri-end-item"><span class="ri-dot end"></span>${t('lg_end')}: ${escapeHtml(eLbl)}</span>` : ''}
      </div>` : ''}
      <button class="ri-start ${guiding ? 'active' : ''}${canGuide() ? '' : ' locked'}" id="ri-start" style="${guiding ? '' : `background:${route.color}`}">
        ${guiding ? t('ri_stop_walk') : (canGuide() ? '' : '🔒 ') + t('ri_start_walk')}</button>
      <div class="ri-points-head">${t('ri_points')} <span class="ri-count">${pts.length}</span></div>
      ${pts.length ? `<ul class="ri-points">${pts.map((w) => {
        const m = typeMeta(w.properties.tipo);
        return `<li data-wp="${w.properties.id}"><span class="ri-pdot" style="background:${m.color}"></span>${escapeHtml(L(w.properties, 'title') || w.properties.title)}</li>`;
      }).join('')}</ul>` : `<p class="ri-empty">${t('no_points')}</p>`}
    </div>`;
  // La × solo cierra la caja. Durante la guía queda el chip flotante para
  // reabrirla o terminar — cerrar la caja ya no termina el recorrido.
  $('#ri-close').onclick = () => info.classList.add('hidden');
  // Siempre se pregunta escuchar/leer, con la elección habitual ya marcada. Es
  // un toque más, pero hace la audioguía predecible y da un sitio fijo donde
  // probar la voz — antes la pregunta aparecía o no y nadie sabía por qué.
  $('#ri-start').onclick = () => {
    if (!canGuide()) { toast(t('guiding_on_site')); return; }
    if (state.guiding === id) return stopGuiding();
    askTourMode(id);
  };
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
// Tiempo a pie: regla de Naismith ajustada a ritmo de paseo — 4 km/h en llano
// más 1 h por cada 600 m de subida. Es una estimacion, y se muestra con ~.
// ponytail: ritmo unico; si alguna vez hay perfiles (familia, deportista), aqui
// se parametriza.
// Constantes del modelo, en un solo sitio. Naismith con la corrección de
// Langmuir, con valores de SENDERO DE MONTAÑA HÚMEDA — no de camino llano, que
// es lo que había antes (4 km/h y 600 m/h) y por eso el Recorrido del Agua salía
// en ~30 min cuando eso es lo que tarda sólo la bajada a la cascada.
//
// Son valores de manual, no medidos: el ancla de cordura es esa observación —
// 1.518 m a 4 km/h daban 23 min para el recorrido ENTERO, menos que su propia
// bajada. En cuanto haya 3 caminatas completas de verdad, la mediana observada
// sustituye a todo esto (ver routeDuration).
const WALK_KMH = 2.0;            // ritmo en llano sobre sendero estrecho y húmedo
const ASCENT_M_PER_H = 400;      // 1 h por cada 400 m de subida acumulada
const DESCENT_MIN_PER_300M = 10; // Langmuir: la bajada pronunciada TAMBIÉN cuesta
const STOP_MIN = 3;              // pararse a escuchar un punto de la audioguía
// Minutos a pie. `stops` son los puntos con guión: un recorrido con audioguía se
// hace parando, y no contarlo era la mitad del error.
function walkMinutes(distM, gainM, lossM, stops) {
  const m = (distM / 1000) / WALK_KMH * 60
    + (gainM || 0) / ASCENT_M_PER_H * 60
    + (lossM || 0) / 300 * DESCENT_MIN_PER_300M
    + (stops || 0) * STOP_MIN;
  return isFinite(m) ? Math.round(m) : 0;
}
const fmtMin = (min) => (min < 60 ? `~${min} min` : `~${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`);
// Dos números, porque son dos cosas distintas: cuánto se tarda en caminarlo y
// cuánto en hacerlo como está diseñado, parándose en cada punto.
function walkText(distM, gainM, lossM, stops) {
  const walking = walkMinutes(distM, gainM, lossM, 0);
  if (walking <= 0) return '⏱️ —';
  const guided = walkMinutes(distM, gainM, lossM, stops);
  return guided > walking ? `🚶 ${fmtMin(walking)} · 🎧 ${fmtMin(guided)}` : `⏱️ ${fmtMin(walking)}`;
}
// Precedencia del tiempo que se enseña: lo que MIDIÓ el dueño gana sobre lo que
// midieron los visitantes, y eso gana sobre cualquier modelo. Un número medido
// vale más que una regla de manual, por buena que sea la regla.
function routeDuration(route, distM, gainM, lossM, stops) {
  if (route && route.duration_min > 0) return { text: `⏱️ ${fmtMin(route.duration_min)}`, src: 'manual' };
  const st = route && state.routeStats && state.routeStats[route.id];
  if (st && st.n_walks >= 3 && st.median_min > 0) {
    return { text: `⏱️ ${fmtMin(Math.round(st.median_min))}`, src: 'medido', n: st.n_walks };
  }
  return { text: walkText(distM, gainM, lossM, stops), src: 'modelo' };
}
// Paradas de la audioguia: puntos del recorrido que TIENEN guion. Un punto sin
// guion no suena y no hace parar a nadie, asi que no cuenta.
function routeStopCount(id) {
  const r = state.routesById[id];
  if (!r || !r.scripts) return 0;
  const member = new Set(state.waypoints.filter((w) => (w.properties.routes || []).includes(id)).map((w) => w.properties.id));
  // Se ENUMERA, no se indexa por punto: `route.scripts[pointId]` es la operación
  // «dame el guión de este punto», y ésa pasa siempre por routeScript, que es
  // donde vive el guard de cuenta-y-dentro-de-la-reserva (guide-gate.test.mjs
  // cuenta ese patrón y exige que aparezca una sola vez). Contar cuántos puntos
  // tienen guión no revela ningún texto, así que no necesita el embudo — pero
  // tampoco puede saltárselo por la puerta de atrás.
  return Object.entries(r.scripts).filter(([pid, sc]) => member.has(pid) && sc && (sc.es || sc.en)).length;
}
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
  // La BAJADA tambien cuesta tiempo en sendero pronunciado (correccion de
  // Langmuir), asi que se suma aparte en vez de tirarla.
  let gain = 0, loss = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < e.length; i++) {
    min = Math.min(min, e[i]); max = Math.max(max, e[i]);
    if (i > 0 && e[i] > e[i - 1]) gain += e[i] - e[i - 1];
    if (i > 0 && e[i] < e[i - 1]) loss += e[i - 1] - e[i];
  }
  return { gainM: gain, lossM: loss, minEle: min, maxEle: max };
}
async function applyElevation(id, path) {
  const set = (sel, txt) => { const el = $(sel); if (el && state.activeRoute === id) el.textContent = txt; };
  const route = state.routesById[id];
  const stops = routeStopCount(id);
  // El tiempo depende del desnivel, asi que se pinta con el, no antes.
  const paint = (r) => { set('#ri-ele', eleText(r)); set('#ri-time', routeDuration(route, pathLengthM(path), r.gainM, r.lossM, stops).text); };
  if (state.eleCache[id]) { paint(state.eleCache[id]); return; }
  try { const r = await fetchElevation(path); state.eleCache[id] = r; paint(r); }
  catch (e) { set('#ri-ele', '⛰️ —'); set('#ri-time', routeDuration(route, pathLengthM(path), 0, 0, stops).text); }
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
        ${(routeScript(state.guiding, p.id) || routeScript(state.activeRoute, p.id)) ? '<button class="mp-listen" type="button">🔊 Escuchar</button>' : ''}
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
    const lsb = el.querySelector('.mp-listen');
    if (lsb) lsb.onclick = () => { primeSpeech(); speakScript(routeScript(state.guiding, p.id) || routeScript(state.activeRoute, p.id)); };
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
  const rest = photo ? gallery.filter((m) => m.full !== photo && m.poster !== photo) : gallery;
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
      ${rest.length ? `<div class="sp-gallery">${rest.map((m) => `<figure class="sp-fig" data-full="${escapeHtml(m.full)}" data-kind="${m.kind}">${pictureTag(m, 'sp-gimg', L(p, 'title'))}${m.caption ? `<figcaption>${escapeHtml(L(m, 'caption'))}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}
      ${desc ? `<p class="wp-desc">${escapeHtml(desc)}</p>` : ''}
      ${speciesChips ? `<div class="wp-species">${speciesChips}</div>` : ''}
      ${p.tipo === 'arbol' ? `<p class="tiny muted" style="margin-top:10px">${t('tree_note')}${p.tag ? ` · ${t('tree_tag')} ${escapeHtml(p.tag)}` : ''}${p.altitude ? ` · ${escapeHtml(p.altitude)}` : ''}</p>` : ''}
      ${p.approx ? `<p class="tiny muted" style="margin-top:10px">${t('approx_note')}</p>` : ''}
      ${isAdminUser() ? `<div class="sp-admin-actions">
        <button class="wp-nav" id="wp-frame" style="background:var(--moss)">🖼️ ${t('sp_frame')}</button>
      </div>` : ''}
    </div>`;
  $('#waypoint-card').classList.remove('hidden');
  pushBack('card', closeWaypoint);   // el botón atrás del teléfono cierra la ficha
  const navBtn = $('#wp-nav'); if (navBtn) navBtn.onclick = () => navigateTo(wp);
  const wpFr = $('#wp-frame'); if (wpFr) wpFr.onclick = () => openReframe('waypoint', p.id);
  $$('#wp-content .sp-gallery .sp-fig').forEach((f) => f.onclick = () => openLightbox(f.dataset.full, f.dataset.kind));
  $$('#wp-content .route-badge').forEach((b) =>
    b.onclick = () => { const rid = b.dataset.route; closeWaypoint(); selectRoute(rid); });
  $$('#wp-content .chip').forEach((chip) =>
    chip.onclick = () => { switchView('especies'); highlightSpecies(chip.dataset.species); });
}
function closeWaypoint() {
  popBack('card');
  $('#waypoint-card').classList.add('hidden'); state.openWaypointId = null; state.openSpeciesId = null;
  if (state._riWasOpen && state.activeRoute) $('#route-info').classList.remove('hidden');
  state._riWasOpen = false;
}

// ---------- modo enfocado: llegar al inicio y avanzar punto a punto ----------
// Tres superficies y nada más: el mapa con el camino, una tarjeta que dice qué
// hacer ahora, y la voz (o el texto, según elija el visitante).

// Rumbo aproximado en palabras. Una flecha exige mirar la pantalla orientada;
// «hacia el norte» se entiende de reojo.
function bearingWord(from, to) {
  const dLng = (to[0] - from[0]) * Math.cos((from[1] + to[1]) * Math.PI / 360);
  const dLat = to[1] - from[1];
  const deg = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
  const es = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
  const en = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const i = Math.round(deg / 45) % 8;
  return LANG === 'en' ? en[i] : es[i];
}

const TRAILHEAD_M = 30;   // dentro de esto se considera que ya llegó al inicio

// Puntos del recorrido EN ORDEN de visita (misma proyección sobre el trazado que
// usa la caja de información y el editor de guiones).
function routePointsInOrder(id) {
  const r = state.routesById[id];
  if (!r) return [];
  const ids = state.waypoints.filter((w) => (w.properties.routes || []).includes(id)).map((w) => w.properties.id);
  return orderPointsAlongSegments(r.segments || [], ids, r.start_id, r.end_id, r.freeroam_paths).map(wpById).filter(Boolean);
}
// ¿A dónde toca ir AHORA? Antes de llegar al inicio, al inicio; después, al
// siguiente punto que no se haya visitado; al final, al punto de fin.
// `state.navDone` es distinto de `lastTriggered`: aquél se reinicia al alejarse
// (para poder volver a sonar), y como "ya visitado" haría que la guía mandara de
// vuelta a un punto por el que ya se pasó.
function navTarget() {
  if (!state.guiding) return null;
  const built = buildRoutePath(state.guiding);
  const path = built && built.path;
  if (!path || !path.length) return null;
  if (!state.atTrailhead) return { coord: path[0], label: t('th_title'), id: '__inicio__' };
  const next = routePointsInOrder(state.guiding).find((w) => !state.navDone[w.properties.id]);
  if (next) return { coord: next.geometry.coordinates, label: L(next.properties, 'title') || next.properties.title || '', id: next.properties.id, wp: next };
  return { coord: path[path.length - 1], label: t('nav_to_end'), id: '__fin__' };
}
// Traza en vivo hasta el objetivo, por los senderos (Dijkstra) — el equivalente
// a la línea azul de Google Maps. Se recalcula sólo si te moviste de verdad o si
// cambió el objetivo: reproyectar la red entera en cada fijo del GPS calienta el
// teléfono para nada.
function navDrawLeg(target) {
  const map = state.map;
  if (!map || !map.getSource('nav-route') || !state.userPos || !target) return;
  const moved = !state._navFrom || haversine(state._navFrom, state.userPos) > 8;
  if (!moved && state._navTo === target.id) return;
  state._navFrom = state.userPos; state._navTo = target.id;
  let r = routeOnTrails(state.userPos, target.coord);
  if (!r) r = { coords: [state.userPos, target.coord] };
  map.getSource('nav-route').setData({ type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } }] });
}
function navClearLeg() {
  const src = state.map && state.map.getSource('nav-route');
  if (src) src.setData(emptyFC());
  state._navFrom = null; state._navTo = null;
}
// Tarjeta de navegación: qué sigue, a qué distancia y hacia dónde. Nace de la
// vieja tarjeta «ve al inicio», que hacía esto mismo pero sólo para el primer
// punto y se apagaba al llegar — justo cuando empieza a hacer falta.
function renderTrailhead() {
  if (!state.guiding) return hideTrailhead();
  if (!state.userPos) return;              // sin GPS todavía: no se puede decir nada útil
  const target = navTarget();
  if (!target) return hideTrailhead();
  const d = haversine(state.userPos, target.coord);
  if (target.id === '__inicio__' && d <= TRAILHEAD_M) {
    state.atTrailhead = true; toast(t('th_arrived'));
    return renderTrailhead();              // ya en el inicio: la tarjeta pasa al primer punto
  }
  navDrawLeg(target);
  // UNA sola tarjeta abajo. Las dos (navegación y llegada a un punto) están
  // ancladas al mismo borde con el mismo z-index, así que aparecían encima una
  // de otra y se tapaban. Mientras esté abierta la de llegada, la de navegación
  // se retira; al cerrarla, hideGuideCard la repinta.
  if (document.getElementById('guide-card')) {
    const old = document.getElementById('trailhead-card');
    if (old) old.remove();
    return;
  }
  let el = document.getElementById('trailhead-card');
  if (!el) {
    el = document.createElement('div');
    el.id = 'trailhead-card'; el.className = 'guide-sheet';
    (document.getElementById('view-recorridos') || document.body).appendChild(el);
  }
  const head = target.id === '__inicio__' ? t('th_title') : `${t('nav_next')}: ${escapeHtml(target.label)}`;
  el.innerHTML = `
    <div class="gs-head"><b>${head}</b>
      <button class="gs-x" id="th-x" aria-label="${escapeHtml(t('th_close'))}">×</button></div>
    <p class="gs-body">${fmtDist(d)} · ${escapeHtml(bearingWord(state.userPos, target.coord))}</p>
    ${target.id === '__inicio__' ? `<button class="gs-cta" id="th-go">${t('th_go')}</button>` : ''}`;
  const go = document.getElementById('th-go');
  if (go) go.onclick = () => navigateTo({ geometry: { coordinates: target.coord },
    properties: { id: '__inicio__', title: t('th_title') } });
  // La × salta este objetivo (no cierra la guía): un punto que no se quiere ver,
  // o al que no se llega, no puede dejar la tarjeta clavada el resto del camino.
  document.getElementById('th-x').onclick = () => {
    if (target.id === '__inicio__') state.atTrailhead = true;
    else if (target.wp) state.navDone[target.id] = true;
    renderTrailhead();
  };
}
function hideTrailhead() { const el = document.getElementById('trailhead-card'); if (el) el.remove(); navClearLeg(); }

// Tarjeta de llegada a un punto. Sustituye al toast + mini-popup + voz sueltos:
// una idea por tarjeta, y el visitante decide si quiere más.
function showGuideCard(wp) {
  const p = wp.properties;
  state.lastGuideWp = wp;   // para repintar la tarjeta al cambiar voz↔texto
  const sc = routeScript(state.guiding, p.id) || routeScript(state.activeRoute, p.id);
  const photo = realPhoto(wp);
  let el = document.getElementById('guide-card');
  if (!el) {
    el = document.createElement('div');
    el.id = 'guide-card'; el.className = 'guide-sheet gs-arrive';
    (document.getElementById('view-recorridos') || document.body).appendChild(el);
  }
  // En modo LEER se muestra el guión completo; en ESCUCHAR, la voz lo lleva y la
  // tarjeta se queda corta (mirar el teléfono mientras caminas es justo lo que
  // se quiere evitar). En ambos casos el texto está disponible a un toque.
  const reading = state.tourMode === 'read';
  // El guion es un objeto {es,en}: hay que ELEGIR idioma antes de pintarlo. Es
  // la misma eleccion que hace la voz, y sale del mismo sitio (`scriptLine`).
  const scText = (scriptLine(sc) || {}).text || '';
  el.innerHTML = `
    <div class="gs-head"><b>📍 ${escapeHtml(L(p, 'title') || p.title || '')}</b>
      <button class="gs-x" id="gc-x" aria-label="${escapeHtml(t('gc_close'))}">×</button></div>
    ${photo ? `<div class="gs-photo" style="background-image:url('${escapeHtml(photo)}')"></div>` : ''}
    ${scText ? `<p class="gs-body ${reading ? '' : 'gs-clamp'}">${escapeHtml(scText)}</p>` : ''}
    <div class="gs-acts">
      ${sc && !reading ? `<button class="gs-ghost" id="gc-say">${t('gc_listen')}</button>` : ''}
      <button class="gs-cta" id="gc-more">${t('more_info')}</button>
      <button class="gs-ghost" id="gc-ok">${t('gc_close')}</button>
    </div>`;
  const close = () => hideGuideCard();
  document.getElementById('gc-x').onclick = close;
  document.getElementById('gc-ok').onclick = close;
  document.getElementById('gc-more').onclick = () => { close(); showWaypoint(wp); };
  const say = document.getElementById('gc-say');
  if (say) say.onclick = () => speakScript(sc);
  if (sc && !reading) speakScript(sc);
}
// Cerrar la tarjeta CALLA la voz: seguir oyendo el guión de un punto que ya
// cerraste es lo que hace que la gente le baje el volumen al teléfono y se
// pierda el resto de la audioguía. Al cerrarla vuelve la tarjeta de navegación
// (las dos van ancladas abajo y sólo puede haber una — ver renderTrailhead).
function hideGuideCard() {
  const el = document.getElementById('guide-card');
  if (!el) return;
  el.remove(); stopSpeech();
  if (state.guiding) renderTrailhead();
}

// Elegir entre escuchar y leer AL EMPEZAR CADA RECORRIDO. Antes se preguntaba
// sólo la primera vez y luego se recordaba para siempre: quien eligiera «leer»
// una vez no volvía a oír la voz nunca, y la pregunta aparecía o no sin que se
// entendiera por qué. Ahora siempre se pregunta, con la elección habitual ya
// marcada (un toque) y un botón para COMPROBAR la voz antes de echar a andar.
function askTourMode(routeId) {
  const ov = document.createElement('div');
  ov.className = 'fm-assign'; ov.id = 'tour-mode';
  document.body.appendChild(ov);
  const close = () => { popBack('tourmode'); stopSpeech(); ov.remove(); };
  const usual = state.tourMode || 'listen';
  const hasTts = ttsReady();
  ov.innerHTML = `<div class="fm-assign-box tour-box">
      <h3>${t('tour_ask')}</h3>
      <button class="tour-opt ${usual === 'listen' ? 'sel' : ''}" data-m="listen"><b>${t('tour_listen')}</b><span>${t('tour_listen_sub')}${usual === 'listen' ? ` · ${t('tour_usual')}` : ''}</span></button>
      <button class="tour-opt ${usual === 'read' ? 'sel' : ''}" data-m="read"><b>${t('tour_read')}</b><span>${t('tour_read_sub')}${usual === 'read' ? ` · ${t('tour_usual')}` : ''}</span></button>
      ${hasTts ? `<button class="tour-test" id="tour-test">${t('tour_test')}</button>` : `<div class="admin-note">${escapeHtml(t('tour_no_tts'))}</div>`}
    </div>`;
  pushBack('tourmode', () => ov.remove());
  ov.onclick = (e) => { if (e.target === ov) close(); };
  // Probar la voz AQUÍ, con el teléfono en la mano y antes de caminar, es la
  // única forma de saber que funciona: el volumen, el silencio y la falta de
  // voz en español fallan en silencio y sólo se descubren ya en el monte.
  const test = document.getElementById('tour-test');
  if (test) test.onclick = () => { primeSpeech(); speak(t('tour_test_line'), LANG === 'en' ? 'en-US' : 'es-CO'); };
  ov.querySelectorAll('.tour-opt').forEach((b) => b.onclick = () => {
    close();
    startGuiding(routeId, b.dataset.m);
  });
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
  startHeading();   // brújula: pide permiso (iOS) dentro del gesto del tap
  navigator.geolocation.getCurrentPosition(onPosition, onGeoError, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 });
}
function stopTracking() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null; state.following = false;
  stopHeading();
  $('#locate-btn').classList.remove('tracking'); setGps('off', t('gps'));
  // Sin GPS no hay avisos de proximidad: cerrar también el modo guiado para
  // que el estado visible coincida con lo que de verdad está pasando.
  if (state.guiding) stopGuiding();
}
// El punto del usuario lleva su rumbo (si lo hay) como propiedad `heading`, que
// alimenta el haz de dirección. Una sola feature para halo + haz + punto.
function pushUserFeature() {
  const src = state.map && state.map.getSource('user');
  if (!src) return;
  const props = state.heading != null ? { heading: state.heading } : {};
  src.setData({ type: 'FeatureCollection', features: state.userPos
    ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: state.userPos }, properties: props }]
    : [] });
}
// ---------- device heading (brújula, estilo Google Maps) ----------
// Suaviza el rumbo por el camino corto (evita el salto 359°→0°).
function smoothHeading(prev, next, a = 0.2) {
  if (prev == null) return next;
  const d = ((next - prev + 540) % 360) - 180;
  return (prev + a * d + 360) % 360;
}
let _headingRaf = 0;
function onDeviceOrientation(e) {
  let h = null;
  if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;   // iOS: grados horarios desde el norte
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;        // Android absoluto
  if (h == null || isNaN(h)) return;
  // Compensa la rotación de pantalla (no-op en vertical). Si en horizontal el haz
  // apunta al revés en el terreno, invertir el signo aquí (calibración de campo).
  const scr = (screen.orientation && screen.orientation.angle) || 0;
  h = (h + scr + 360) % 360;
  state.heading = smoothHeading(state.heading, h);
  if (!_headingRaf) _headingRaf = requestAnimationFrame(() => { _headingRaf = 0; pushUserFeature(); navFollowHeading(); });
}
// Mapa orientado a donde MIRAS mientras te guía (como el coche de Google Maps):
// «arriba» deja de ser el norte y pasa a ser el frente, que es lo que permite
// leer el mapa de reojo sin girarlo mentalmente. Sólo durante la guía y sólo si
// el mapa te está siguiendo: si paneaste para mirar adelante, no te lo peleo.
// El umbral de 8° evita reencuadrar en cada micro-oscilación de la brújula.
const NAV_PITCH = 55;
function navFollowHeading() {
  if (!state.guiding || !state.following || state.heading == null) return;
  const map = state.map; if (!map) return;
  const cur = map.getBearing();
  const diff = Math.abs(((state.heading - cur + 540) % 360) - 180);
  if (diff < 8) return;
  map.easeTo({ bearing: state.heading, duration: 300 });
}
function startHeading() {
  if (state._headingOn || !window.isSecureContext) return;
  const attach = () => {
    state._headingOn = true;
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
  };
  const req = window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission;
  if (typeof req === 'function') req().then((s) => { if (s === 'granted') attach(); }).catch(() => {});   // iOS 13+: requiere gesto (el tap de ubicar)
  else attach();
}
function stopHeading() {
  state._headingOn = false;
  window.removeEventListener('deviceorientationabsolute', onDeviceOrientation, true);
  window.removeEventListener('deviceorientation', onDeviceOrientation, true);
  state.heading = null; pushUserFeature();
}
function onPosition(pos) {
  const { longitude, latitude, accuracy } = pos.coords;
  state.userPos = [longitude, latitude];
  state.userAccuracy = accuracy;   // metros — para el círculo de precisión
  setGps('on', `±${Math.round(accuracy)} m`);
  window.dispatchEvent(new CustomEvent('cantares:position', { detail: { lng: longitude, lat: latitude, accuracy } }));   // stream compartido (grabador)
  pushUserFeature();
  updateAccuracyCircle();
  if (state.map) {
    if (!state.firstFix) { state.map.flyTo({ center: state.userPos, zoom: 17, duration: 900 }); state.firstFix = true; }
    // Recentrar sólo en modo seguimiento: si el usuario paneó para mirar más
    // adelante, no pelearle el mapa en cada fijo del GPS.
    else if (state.following) state.map.easeTo({ center: state.userPos, duration: 600 });
  }
  refreshOutsideReserve();
  checkProximity();
  if (state.guiding) renderTrailhead();   // destino, distancia, rumbo y traza en vivo
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
  // PERMISSION_DENIED (1) → el permiso está bloqueado: hay que ir a tocarlo, y un
  // toast de tres segundos no alcanza para explicar dónde. POSITION_UNAVAILABLE (2)
  // suele ser la ubicación del teléfono apagada. Los dos casos son accionables y
  // los dos dejaban al visitante mirando un mapa que no lo seguía.
  if (err.code === 1) { stopTracking(); showGpsHelp('denied'); return; }
  if (err.code === 2) { showGpsHelp('off'); return; }
  toast(msg);   // timeout: suele resolverse solo con otro fijo
}
// Qué hacer para tener ubicación, dicho con los pasos exactos del teléfono.
// Una página web NO puede encender la ubicación de Android ni abrir sus ajustes
// (lo impide el navegador, no la app): lo único honesto es pedir el permiso —
// que es lo que hace getCurrentPosition — y, si está bloqueado, explicar dónde
// se desbloquea. `_gpsHelpOpen` evita que cada fijo fallido reabra la hoja.
let _gpsHelpOpen = false;
function showGpsHelp(kind) {
  if (_gpsHelpOpen) return;
  _gpsHelpOpen = true;
  const ov = document.createElement('div');
  ov.className = 'fm-assign'; ov.id = 'gps-help';
  const close = () => { _gpsHelpOpen = false; popBack('gpshelp'); ov.remove(); };
  const steps = kind === 'denied'
    ? [t('gps_help_denied_1'), t('gps_help_denied_2'), t('gps_help_denied_3')]
    : [t('gps_help_off_1'), t('gps_help_off_2'), t('gps_help_off_3')];
  ov.innerHTML = `<div class="fm-assign-box gps-help-box">
      <h3>${escapeHtml(t('gps_help_title'))}</h3>
      <p class="gh-why">${escapeHtml(t('gps_help_why'))}</p>
      <p class="gh-h"><b>${escapeHtml(kind === 'denied' ? t('gps_help_denied_h') : t('gps_help_off_h'))}</b></p>
      <ol class="gh-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
      <p class="gh-note">${escapeHtml(t('gps_help_note'))}</p>
      <button class="gs-cta" id="gh-retry">${escapeHtml(t('gps_help_retry'))}</button>
      <button class="gs-ghost" id="gh-close">${escapeHtml(t('gps_help_close'))}</button>
    </div>`;
  document.body.appendChild(ov);
  pushBack('gpshelp', () => { _gpsHelpOpen = false; ov.remove(); });
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.querySelector('#gh-close').onclick = close;
  // Reintentar dentro del gesto del toque: si el visitante acaba de conceder el
  // permiso, esta llamada es la que vuelve a arrancar el seguimiento.
  ov.querySelector('#gh-retry').onclick = () => { close(); if (state.watchId == null) locate(); };
}
// ----- guided mode: follow the visitor and surface points as they approach -----
function startGuiding(id, mode) {
  if (mode) { state.tourMode = mode; localStorage.setItem('cantares_tour_mode', mode); }
  state.guiding = id;
  state.atTrailhead = false;
  state.navDone = {};   // ningún punto visitado todavía en ESTE recorrido
  state.nearFixes = {};   // contador de fijos dentro del radio (confirmación de llegada)
  // Modo enfocado: fuera leyenda, capas de satélite y buscador. Es la queja de
  // fondo — demasiadas cosas a la vez. Caminando sólo hacen falta el camino, los
  // puntos del recorrido y qué hacer ahora.
  document.body.classList.add('guiding');
  applyWaypointFilter();
  primeSpeech();   // gesto del usuario: habilita el TTS para leer los guiones al llegar
  const built = buildRoutePath(id);
  // Cámara de navegación: inclinada y de cerca. En plano y de lejos el mapa es
  // una lámina; inclinado se lee «lo que viene» sin pensarlo.
  if (built && state.map) state.map.easeTo({ center: built.path[0], zoom: 17.5, pitch: NAV_PITCH, duration: 800 });
  if (state.watchId == null) locate();   // begin GPS follow (google-maps style)
  state.following = true;
  // Grabar también el recorrido guiado en el historial del usuario.
  const rt = state.routesById[id];
  if (!isRecording()) startWalk(id, rt ? L(rt, 'name') : null);
  // Pantalla encendida durante la guía: si se apaga, el navegador corta el GPS
  // y los avisos de llegada a los puntos mueren en silencio.
  // Sólo se avisa si el bloqueo de pantalla FALLA. Antes salían dos avisos
  // seguidos en el mismo sitio y el segundo borraba al primero antes de leerlo.
  keepAwake().then((ok) => { if (!ok) toast(t('guiding_screen_warn')); });
  toast(t('guiding_on'));
  // Mapa despejado durante la guía: la caja se cierra y queda solo el chip.
  closeWaypoint(); removePopup();
  $('#route-info').classList.add('hidden');
  guideChip(true);
  // Atrás sale del recorrido antes que de la app: en medio del monte, salirse
  // sin querer y perder los avisos de los puntos es el peor final posible.
  pushBack('guiding', () => stopGuiding());
  renderTrailhead();
}
function stopGuiding() {
  const wasId = state.guiding;
  if (!wasId) return;   // idempotente: el par keepAwake/releaseAwake no puede descuadrarse
  popBack('guiding');
  state.guiding = null;
  state.atTrailhead = false;
  document.body.classList.remove('guiding');   // vuelve la leyenda, el satélite y el buscador
  // Cámara de vuelta a plano y al norte: dejarla inclinada y girada después de
  // terminar desorienta a quien sólo quería mirar el mapa.
  if (state.map) state.map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
  hideTrailhead(); hideGuideCard();
  applyWaypointFilter();
  stopSpeech();   // corta cualquier guión en curso al terminar el recorrido
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
  // El interruptor voz/texto vive AQUÍ, visible durante todo el recorrido: la
  // elección del arranque ya no queda encerrada hasta el próximo recorrido, y
  // se ve de un vistazo en qué modo está la guía (era la duda de fondo: «¿por
  // qué a veces habla y a veces no?»).
  const listening = state.tourMode !== 'read';
  el.innerHTML = `
    <button class="gc-open">${r.emoji || '🥾'} <b>${escapeHtml(L(r, 'name'))}</b></button>
    <button class="gc-mode" aria-label="${escapeHtml(listening ? t('gc_to_read') : t('gc_to_listen'))}">${listening ? '🔊' : '📖'}</button>
    <button class="gc-stop" aria-label="${t('ri_stop_walk')}">■</button>`;
  el.querySelector('.gc-open').onclick = () => {
    renderRouteInfo(r, buildRoutePath(state.guiding));
    $('#route-info').classList.remove('hidden');
  };
  el.querySelector('.gc-mode').onclick = () => {
    const next = listening ? 'read' : 'listen';
    state.tourMode = next; localStorage.setItem('cantares_tour_mode', next);
    if (next === 'read') stopSpeech(); else primeSpeech();
    guideChip(true);                       // repintar el icono
    toast(t(next === 'read' ? 'gc_now_read' : 'gc_now_listen'));
    // La tarjeta abierta cambia de forma con el modo (texto completo vs. voz).
    const open = document.getElementById('guide-card');
    if (open && state.lastGuideWp) showGuideCard(state.lastGuideWp);
  };
  el.querySelector('.gc-stop').onclick = () => { if (confirm(t('guiding_confirm_end'))) stopGuiding(); };
}

// ---------- audioguía: guión por (recorrido, punto), leído en voz alta ----------
// El guión es TEXTO (ES/EN) guardado en route.scripts[pointId]. Al llegar a un
// punto durante un recorrido, el teléfono lo lee con la voz del sistema (TTS,
// offline). Un punto sin guión en ese recorrido no activa audio. Como el mismo
// punto puede estar en varios recorridos, la clave es (recorrido, punto).
function routeScript(routeId, pointId) {
  // El permiso se comprueba AQUI, no en cada boton: `routeScript` es el unico
  // sitio por el que un guion llega a la pantalla (la tarjeta de llegada y el
  // popup del punto), asi que un solo guard los cubre a los dos y a los que
  // vengan. Un recorrido YA EMPEZADO no se corta: salirse dos metros del buffer
  // a mitad de camino no puede callar la audioguia.
  if (!state.guiding && !canGuide()) return null;
  const r = routeId && state.routesById[routeId];
  const s = r && r.scripts && r.scripts[pointId];
  return (s && (s.es || s.en)) ? s : null;
}
// ----- TTS: por qué «a veces suena y a veces no» -----
// Tres fallos del motor del navegador, los tres silenciosos, se sumaban:
//   1. getVoices() llega VACÍO en el primer arranque (las voces cargan asíncronas);
//      hablar antes de que exista una voz para el idioma no dice nada.
//   2. speak() llamado INMEDIATAMENTE después de cancel() se descarta en Chrome.
//   3. Chrome/Android corta la locución a los ~15 s si nadie hace pause()/resume().
// Aquí se cubren los tres, y `ttsReady()` permite avisar en pantalla en vez de
// dejar al visitante esperando una voz que no va a llegar.
const TTS_OK = 'speechSynthesis' in window;
let _voices = [];
function loadVoices() {
  if (!TTS_OK) return _voices;
  try { const v = window.speechSynthesis.getVoices(); if (v && v.length) _voices = v; } catch (e) { /* sin TTS */ }
  return _voices;
}
if (TTS_OK) { loadVoices(); try { window.speechSynthesis.onvoiceschanged = loadVoices; } catch (e) { /* sin TTS */ } }
// ¿Hay motor y al menos una voz? (Antes de la primera carga `_voices` está vacío
// pero el motor puede servir igual — sólo se declara «no hay» si nunca llegaron.)
function ttsReady() { return TTS_OK && loadVoices().length > 0; }
function pickVoice(lang) {
  const want = lang.slice(0, 2).toLowerCase();
  const vs = loadVoices();
  const norm = (l) => String(l || '').replace('_', '-').toLowerCase();
  return vs.find((v) => norm(v.lang) === lang.toLowerCase())
      || vs.find((v) => norm(v.lang).startsWith(want))
      || null;
}
// El TTS del navegador necesita un gesto del usuario para "despertar" (iOS).
// Se ceba al iniciar el recorrido (que sí es un toque) con un enunciado mudo.
let _speechPrimed = false;
function primeSpeech() {
  if (!TTS_OK) return;
  loadVoices();
  if (_speechPrimed) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); _speechPrimed = true; } catch (e) { /* sin TTS */ }
}
let _speakTimer = null, _resumeTimer = null;
function stopResumePing() { clearInterval(_resumeTimer); _resumeTimer = null; }
// Chrome corta a los ~15 s: un pause()+resume() periódico mantiene viva la locución.
function startResumePing() {
  stopResumePing();
  _resumeTimer = setInterval(() => {
    if (!window.speechSynthesis.speaking) return stopResumePing();
    try { window.speechSynthesis.pause(); window.speechSynthesis.resume(); } catch (e) { /* nada que reanudar */ }
  }, 9000);
}
function stopSpeech() {
  clearTimeout(_speakTimer); _speakTimer = null; stopResumePing();
  if (TTS_OK) try { window.speechSynthesis.cancel(); } catch (e) { /* sin TTS */ }
}
// Habla un texto. cancel()+speak garantiza UN solo audio a la vez; el respiro de
// 90 ms entre los dos es lo que impide que Chrome se trague el nuevo.
function speak(text, lang) {
  if (!text || !TTS_OK) return false;
  clearTimeout(_speakTimer); stopResumePing();
  try { window.speechSynthesis.cancel(); } catch (e) { /* sin TTS */ }
  _speakTimer = setTimeout(() => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang; u.rate = 0.95;
      const v = pickVoice(lang); if (v) u.voice = v;
      u.onend = stopResumePing; u.onerror = stopResumePing;
      window.speechSynthesis.speak(u);
      startResumePing();
    } catch (e) { /* TTS no disponible: el guión igual está en pantalla */ }
  }, 90);
  return true;
}
// Texto + idioma de un guión, elegidos JUNTOS. Van juntos porque son la misma
// decisión: si falta el guión en inglés se cae al español, y anunciar en-US
// sobre un texto español hace que la voz lo lea con fonética inglesa —
// ininteligible para todo el mundo. Lo usan la voz Y la tarjeta: cuando sólo lo
// sabía la voz, la tarjeta pintaba `[object Object]` en modo LEER.
function scriptLine(s) {
  if (!s) return null;
  const useEn = LANG === 'en' && !!s.en;
  const text = useEn ? s.en : (s.es || s.en);
  return text ? { text, lang: useEn ? 'en-US' : (s.es ? 'es-CO' : 'en-US') } : null;
}
// Lee un guión. Si no llega a leerse, el texto sigue estando en la tarjeta.
function speakScript(s) {
  const l = scriptLine(s);
  if (l) speak(l.text, l.lang);
}

// Tres guardas contra el aviso prematuro (la queja: «la voz arranca cuando
// todavía estoy lejos»). (1) sólo puntos DE ESTE recorrido — uno de otro sendero
// a 15 m del camino no es una llegada y su guión cuenta otro relato; (2) el fijo
// tiene que ser preciso: con ±60 m el GPS te pone en el punto estando a media
// ladera; (3) dos fijos seguidos dentro del radio, para que un salto aislado del
// GPS —lo normal bajo dosel— no dispare la tarjeta ni la voz.
const ARRIVE_ACC_MAX = 30;   // m de precisión máxima para dar una llegada por buena
const ARRIVE_FIXES = 2;      // fijos consecutivos dentro del radio
function checkProximity() {
  if (!state.userPos || !state.guiding) return;   // sólo durante un recorrido iniciado
  // accuracy nula = el navegador no la reporta; no se puede exigir lo que no hay.
  const trusted = state.userAccuracy == null || state.userAccuracy <= ARRIVE_ACC_MAX;
  if (!state.nearFixes) state.nearFixes = {};
  state.waypoints.forEach((wp) => {
    const id = wp.properties.id;
    if (!(wp.properties.routes || []).includes(state.guiding)) return;   // sólo puntos del recorrido en curso
    if (!waypointVisible(wp)) return;   // only trigger points currently shown
    const d = haversine(state.userPos, wp.geometry.coordinates);
    if (d > CONFIG.proximityMeters) {
      state.nearFixes[id] = 0;          // salir del radio reinicia la confirmación
      if (d > CONFIG.reTriggerMeters && state.lastTriggered[id]) state.lastTriggered[id] = false;
      return;
    }
    if (state.lastTriggered[id]) return;
    if (!trusted) return;               // fijo malo: esperar a uno mejor, no adivinar
    state.nearFixes[id] = (state.nearFixes[id] || 0) + 1;
    if (state.nearFixes[id] < ARRIVE_FIXES) return;   // aún sin confirmar
    state.lastTriggered[id] = true;
    state.navDone[id] = true;      // visitado: la guía ya no vuelve a mandarte aquí
    // Una sola tarjeta, no un toast + un popup + una voz a la vez: cada
    // llegada dice una cosa. El detalle completo sigue a un toque.
    showGuideCard(wp);
    renderTrailhead();             // y el destino pasa al punto siguiente
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
// Capa vista/potencial: eBird distingue lo REGISTRADO en la reserva ('seen') de lo
// que PODRÍA verse (unión montana, 'potential'). La distinción vale para CUALQUIER
// grupo (aves y árboles/flora): lo del censo confirmado es 'seen', lo marcado
// 'potential' es potencial. Sin reserve_status → 'seen' (confirmado). Default: vistas.
let seenFilter = 'seen';
// La capa depende de la FUENTE de verdad de cada grupo:
//   aves  → eBird (`reserve_status`, lo escribe data_prep/18_ebird_reserve_lists.py)
//   árboles → el inventario de PUNTOS del mapa: un árbol con punto está mapeado;
//             uno que solo aparece en el listado botánico, no.
// El resto de grupos no tiene dos capas y cae en 'seen' (una sola).
function speciesTier(s) {
  if (s.reserve_status) return s.reserve_status;
  if (speciesGroup(s) === 'arbol') return isTreeSpecies(s) ? 'seen' : 'potential';
  return 'seen';
}
// Etiquetas de la capa según el grupo elegido: para aves es visto/potencial
// (eBird); para árboles es estar o no en el inventario de puntos. Usar «vistas»
// para un árbol sería mentir sobre lo que mide el número.
function tierLabels() {
  return speciesFilter === 'arbol'
    ? { seen: t('f_mapped'), potential: t('f_listed') }
    : { seen: t('f_seen'), potential: t('f_potential') };
}
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
    // Cambiar de categoría reinicia la capa a «vistas»: cada grupo mide una cosa
    // distinta, y arrastrar «potenciales» de aves a árboles no significa nada.
    b.onclick = () => { speciesFilter = key; seenFilter = 'seen'; renderSpeciesFilters(); renderSpeciesGrid(); };
    wrap.appendChild(b);
  });
  // Segunda fila: capa vistas / potenciales, en INTERSECCIÓN con el filtro de grupo
  // de arriba. Los conteos reflejan sólo el grupo elegido; el toggle sólo aparece si
  // ese grupo tiene potenciales (p. ej. Aves; Flora sin potenciales no lo muestra).
  const tw = $('#species-tier');
  if (!tw) return;
  // Sin categoría elegida (Todas / Destacadas) el toggle no aparece: mezclaría
  // capas que miden cosas distintas (eBird para aves, inventario para árboles) en
  // un mismo número, que es justo lo que lo hacía incomprensible.
  if (speciesFilter === 'all' || speciesFilter === 'flagship') { tw.innerHTML = ''; return; }
  const base = groupFiltered();
  const nPot = base.filter((s) => speciesTier(s) === 'potential').length;
  if (!nPot) { tw.innerHTML = ''; return; }   // sin potenciales en este grupo → sin toggle
  const nSeen = base.length - nPot;
  const lbl = tierLabels();
  const tiers = [['seen', `${lbl.seen} (${nSeen})`], ['potential', `${lbl.potential} (${nPot})`], ['all', t('f_bothtier')]];
  tw.innerHTML = '';
  tiers.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.className = 'filter-chip' + (key === seenFilter ? ' active' : '');
    b.textContent = label;
    b.onclick = () => { seenFilter = key; renderSpeciesFilters(); renderSpeciesGrid(); };
    tw.appendChild(b);
  });
}
// Filtro de grupo solo (independiente de la capa vistas/potenciales).
// Texto del buscador de la pestaña Especies. Se normaliza (sin tildes, en
// minúsculas) para que «tangara» encuentre «Tángara» y «buho» encuentre «Búho».
let speciesQuery = '';
const normTxt = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Se busca por nombre común (ES y EN), científico y familia: son los cuatro
// nombres por los que alguien puede conocer un bicho. TODAS las palabras
// escritas tienen que aparecer en algún campo — así «tangara azul» filtra de
// verdad en vez de traer las 30 tángaras.
function matchesQuery(s, terms) {
  if (!terms.length) return true;
  const hay = normTxt([s.common_name, s.common_name_en, s.scientific_name, s.family,
    s.family_common, s.ebird_common_es, s.ebird_common_en].filter(Boolean).join(' '));
  return terms.every((w) => hay.includes(w));
}
function groupFiltered() {
  return state.species.filter((s) =>
    speciesFilter === 'all' ? true
    : speciesFilter === 'flagship' ? s.flagship
    : speciesGroup(s) === speciesFilter);
}
function filteredSpecies() {
  const terms = normTxt(speciesQuery).split(/\s+/).filter(Boolean);
  const base = groupFiltered().filter((s) => matchesQuery(s, terms));
  // Sin categoría elegida no hay toggle visible (ver renderSpeciesFilters), así
  // que TAMPOCO se filtra: un filtro que actúa sin botón que lo muestre es un
  // filtro invisible, y el visitante no entiende por qué le faltan especies.
  if (speciesFilter === 'all' || speciesFilter === 'flagship') return base;
  // La capa sólo aplica si el grupo actual tiene potenciales; si no, se ignora
  // para no dejar la rejilla vacía al cambiar de grupo.
  if (!base.some((s) => speciesTier(s) === 'potential')) return base;
  return base.filter((s) => seenFilter === 'all' || speciesTier(s) === seenFilter);
}
function renderSpeciesGrid(highlightId) {
  const grid = $('#species-grid');
  const ptIdx = pointsBySpeciesKey();
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
      // El interruptor gobierna TODA la pestaña, ficha incluida: se enciende una
      // vez y se editan varias especies seguidas, viendo cómo van quedando.
      const tg = editToggleButton({ label: t('ie_on'), labelOn: t('ie_off'),
        onToggle: () => { renderSpeciesGrid(); if (state.openSpeciesId) { const sp = state.species.find((x) => x.id === state.openSpeciesId); if (sp) showSpecies(sp); } } });
      tg.id = 'species-edit-toggle'; tg.style.marginLeft = '8px';
      const bar = document.createElement('div'); bar.id = 'species-admin-bar'; bar.style.marginBottom = '10px';
      bar.appendChild(b); bar.appendChild(tg);
      grid.parentNode.insertBefore(bar, grid);
    }
  } else if (adminAdd) {
    // Se va la barra entera (botón + interruptor), no sólo el botón: dejar el
    // interruptor de edición a la vista de un visitante sería peor que el bug.
    (document.getElementById('species-admin-bar') || adminAdd).remove();
    if (isEditing()) setEditing(false);
  }
  // Rejilla vacía buscando: decirlo, en vez de dejar un hueco que parece un fallo.
  if (!list.length && speciesQuery.trim()) {
    const p = document.createElement('p');
    p.className = 'species-empty';
    p.textContent = `${t('sp_no_match')} «${speciesQuery.trim()}».`;
    grid.appendChild(p);
    return;
  }
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
    // Nº de puntos del mapa asignados a esta especie. Sin esto, dos especies con
    // el mismo nombre común (p. ej. dos «Yolombo») son indistinguibles en la
    // rejilla y no se ve a cuál quedaron asignados los puntos tras reasignarlos.
    const nPts = countPoints(ptIdx, s);
    card.innerHTML = `
      ${ph ? pictureTag(ph, 'sp-thumb', L(s, 'common_name')) : ''}
      ${s.flagship ? '<span class="star">★</span>' : ''}
      <p class="species-common">${escapeHtml(L(s, 'common_name') || s.scientific_name || s.id)}</p>
      <p class="species-sci">${escapeHtml(s.scientific_name || '')}</p>
      <p class="species-meta">${escapeHtml(s.family || '')}${nPts ? `${s.family ? ' · ' : ''}📍 ${nPts}` : ''}${s.status === 'possible' ? ' · ' + t('possible') : ''}</p>
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
  speciesFilter = 'all'; seenFilter = 'all'; renderSpeciesFilters(); renderSpeciesGrid(id);
}

// ---------- ficha de especie (click en una especie) ----------
// Puntos donde se encuentra la especie (link por id o por nombre científico).
function speciesWaypoints(s) {
  const keys = new Set([String(s.id).toLowerCase(), (s.scientific_name || '').toLowerCase()].filter(Boolean));
  return state.waypoints.filter((w) => (w.properties.species_ids || []).some((sid) => keys.has(String(sid).trim().toLowerCase())));
}
// Índice clave-de-especie → ids de puntos, en UNA pasada. La rejilla tiene ~740
// tarjetas: preguntar punto por punto en cada una era O(especies × puntos).
function pointsBySpeciesKey() {
  const m = new Map();
  (state.waypoints || []).forEach((w) => (w.properties.species_ids || []).forEach((sid) => {
    const k = String(sid).trim().toLowerCase();
    (m.get(k) || m.set(k, new Set()).get(k)).add(w.properties.id);
  }));
  return m;
}
// Nº de puntos de una especie usando ese índice (unión de sus dos claves: el id
// y el nombre científico; los árboles del censo se linkean por nombre).
function countPoints(idx, s) {
  const ids = new Set();
  [String(s.id).toLowerCase(), (s.scientific_name || '').toLowerCase()].filter(Boolean)
    .forEach((k) => (idx.get(k) || []).forEach((wid) => ids.add(wid)));
  return ids.size;
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
// Texto multi-párrafo (separado por línea en blanco) → un <p> por párrafo, escapado.
function paraHtml(text, cls) {
  return String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p class="${cls}">${escapeHtml(p)}</p>`).join('');
}
// Avisa de que el texto que se está leyendo NO está en el idioma de la pantalla.
// `L()` cae al otro idioma cuando falta el propio, y sin este aviso una ficha
// española que de pronto sale en inglés parece un fallo en vez de una ausencia.
function descLangNote(s) {
  const es = (s.description || '').trim();
  const en = (s.description_en || '').trim();
  const shown = LANG === 'en' ? (en || es) : (es || en);
  if (!shown) return '';
  const shownIsEn = shown === en && !(LANG === 'en');
  const shownIsEs = shown === es && LANG === 'en';
  if (!shownIsEn && !shownIsEs) return '';
  return `<p class="desc-note">${escapeHtml(t(shownIsEn ? 'desc_in_en' : 'desc_in_es'))}</p>`;
}

// Atribución de la descripción. NO es decorativa: los textos traídos de
// Wikipedia son CC BY-SA, licencia que EXIGE citar la fuente y enlazarla.
// Publicarlos sin esto la incumple. Se muestra siempre que haya procedencia
// registrada, así que también sirve para el censo 2021 (Duque & Galeano) el día
// que se le anote la suya. Sin `description_url` no se pinta nada.
function descCredit(s) {
  const url = (s.description_url || '').trim();
  if (!url) return '';
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  const lic = (s.description_license || '').trim();
  return `<p class="desc-note desc-credit">${escapeHtml(t('desc_source'))}: `
    + `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)}</a>`
    + (lic ? ` · ${escapeHtml(lic)}` : '') + `</p>`;
}

// Colores de categoría UICN (badge de conservación). Amarillos → texto oscuro.
const IUCN_COLOR = { EX: '#000', EW: '#542344', CR: '#c0392b', EN: '#e67e22', VU: '#f1c40f', NT: '#8aa63a', LC: '#2e7d32', DD: '#95a5a6', NE: '#bdc3c7' };
function iucnBadge(code) {
  if (!code || !IUCN_COLOR[code]) return '';
  const dark = ['VU', 'DD', 'NE'].includes(code);
  return `<span class="badge" title="UICN ${code}" style="background:${IUCN_COLOR[code]};color:${dark ? '#222' : '#fff'}">${code}</span>`;
}
// ¿Es una foto PRESTADA? La galería de una especie mezcla sus propias fotos con
// las del punto donde vive y con `species.photo`, que no son filas de `media`
// suyas. Borrarlas desde aquí quitaría la portada de un punto, así que se marcan
// y sólo se ofrece adoptarlas: una fila nueva apuntando a la MISMA url.
const isBorrowedPhoto = (m) => !m.id || String(m.id).startsWith('sp-photo:')
  || String(m.id).startsWith('shared:') || m.subject_type === 'waypoint';
function speciesGalleryHtml(s, rest, admin) {
  const ed = admin && isEditing();
  const figs = rest.map((m, i) => {
    const cap = m.caption ? `<figcaption>${escapeHtml(L(m, 'caption'))}</figcaption>` : '';
    if (!ed) return `<figure class="sp-fig" data-full="${escapeHtml(m.full)}" data-kind="${m.kind}">${pictureTag(m, 'sp-gimg', L(s, 'common_name'))}${cap}</figure>`;
    const acts = isBorrowedPhoto(m)
      ? `<span class="sp-borrowed" title="Es de otro sitio: aquí sólo se toma prestada">prestada</span>
         <button type="button" class="sp-act" data-a="adopt" data-i="${i}" title="Usar como foto de esta especie">＋</button>`
      : `<button type="button" class="sp-act" data-a="cover" data-i="${i}" title="Poner de portada">★</button>
         <button type="button" class="sp-act" data-a="class" data-i="${i}" title="Reclasificar">🏷️</button>
         <button type="button" class="sp-act" data-a="del" data-i="${i}" title="Eliminar">🗑️</button>`;
    return `<figure class="sp-fig sp-fig-ed" data-full="${escapeHtml(m.full)}" data-kind="${m.kind}">${pictureTag(m, 'sp-gimg', L(s, 'common_name'))}${cap}<div class="sp-acts">${acts}</div></figure>`;
  }).join('');
  const add = ed ? `<button type="button" class="sp-fig sp-add" id="sp-add-photo">＋ foto</button>` : '';
  return (figs || add) ? `<div class="sp-gallery">${figs}${add}</div>` : '';
}
function showSpecies(s) {
  if (!s) return;
  const wps = speciesWaypoints(s);
  const gallery = speciesGallery(s);
  // La primera foto es la PORTADA (cabecera). La rejilla muestra sólo el resto:
  // antes salía también arriba y la foto aparecía repetida al abrir la especie.
  const cover = gallery[0] || null;
  const rest = gallery.slice(1);
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
      <div class="wp-theme-badges"><span class="species-group-tag" style="background:${groupMeta(speciesGroup(s)).color}">${escapeHtml(groupLabel(speciesGroup(s)))}</span>${s.flagship ? '<span class="badge" style="background:var(--gold);color:var(--navy)">★</span>' : ''}${statusTxt ? `<span class="badge" style="background:#8a97a5">${statusTxt}</span>` : ''}${iucnBadge(s.iucn)}</div>
      <h2 class="wp-title" id="sp-f-common">${escapeHtml(L(s, 'common_name') || s.scientific_name || '')}</h2>
      <p class="wp-sci"><em id="sp-f-sci">${escapeHtml(s.scientific_name || '')}</em> · <span id="sp-f-family">${escapeHtml(s.family || '')}</span></p>
      ${speciesGalleryHtml(s, rest, admin)}
      <div id="sp-f-desc">${L(s, 'description')
        ? paraHtml(L(s, 'description'), 'wp-desc') + descLangNote(s) + descCredit(s)
        : (s.notes ? `<p class="wp-desc">${escapeHtml(s.notes)}</p>` : '')}</div>
      <div class="sp-where">📍 ${wps.length ? `${wps.length} ${wps.length === 1 ? t('sp_here_1') : t('sp_here_n')}` : t('sp_nowhere')}</div>
      ${wps.length ? `${mapImg ? `<img class="sp-map" src="${mapImg}" alt="">` : ''}
        <div class="sp-locs">${wps.map((w) => `<button class="chip" data-wp="${escapeHtml(w.properties.id)}">${escapeHtml(L(w.properties, 'title') || w.properties.title)}</button>`).join('')}</div>` : ''}
      ${admin ? `<div class="sp-admin-actions">
        <button class="wp-nav" id="sp-edit" style="background:var(--deep)">📋 ${t('sp_edit_full')}</button>
        <button class="wp-nav" id="sp-frame" style="background:var(--moss)">🖼️ ${t('sp_frame')}</button>
        ${cover ? `<button class="wp-nav" id="sp-dl" style="background:var(--muted)">⬇️ ${t('sp_dl')}</button>` : ''}
      </div>` : ''}
    </div>`;
  $('#wp-content').innerHTML = html;
  $('#waypoint-card').classList.remove('hidden');
  pushBack('card', closeWaypoint);   // el botón atrás del teléfono cierra la ficha
  state.openWaypointId = null; state.openSpeciesId = s.id;
  $$('#wp-content .sp-gallery .sp-fig[data-full]').forEach((f) => f.onclick = () => openLightbox(f.dataset.full, f.dataset.kind));
  if (admin && isEditing()) wireSpeciesGalleryEdit(s, rest);
  $$('#wp-content .sp-locs .chip').forEach((c) => c.onclick = () => { const w = wpById(c.dataset.wp); closeWaypoint(); if (w) selectSearch(w.properties.id); });
  const ed = $('#sp-edit'); if (ed) ed.onclick = () => { closeWaypoint(); openSpeciesEditor(s.id, () => { refreshSpecies(); renderSpeciesGrid(); }); };
  const fr = $('#sp-frame'); if (fr) fr.onclick = () => openReframe('species', s.id);
  const dl = $('#sp-dl'); if (dl) dl.onclick = () => downloadPhoto(cover.full, L(s, 'common_name') || s.scientific_name);
  if (admin) wireSpeciesInlineEdit(s);
}
// Edición EN SITIO de la ficha de especie: se toca el título y se edita el
// título, sobre la ficha real. El editor modal sigue existiendo para crear,
// borrar y los campos que no se ven en la ficha (estado, IUCN, ★, notas).
//
// Ojo con el idioma: `L()` cae al español cuando falta el inglés, así que editar
// la ficha EN INGLÉS sin comprobarlo sobrescribiría el texto español con lo que
// se escribió en inglés. Por eso el campo que se guarda depende del idioma en
// pantalla, y en inglés se edita `*_en`.
// ---- edición en sitio de las páginas de texto (Historia / Info) ----
// Los elementos marcados con data-ie llevan su RUTA dentro del documento
// (`secciones.2.texto`), así que el guardado no necesita saber nada de la forma
// de cada página: escribe esa ruta y manda el doc entero.
//
// El bloqueo sin señal no es un detalle. `state.historia` es el JSON EMPACADO
// mientras no haya llegado la copia de la nube (loadCloudData se rinde sin
// conexión), así que guardar entonces pisaría con el texto de build todo lo que
// se hubiera escrito antes. Hasta ahora eso no se notaba porque el editor no
// guardaba NADA — al arreglarlo, empezaría a poder pasar de verdad.
const CONTENT_STATE = { historia: 'historia', comercial: 'comercial', reserve_info: 'reserveInfo' };
function contentDoc(key) { return state[CONTENT_STATE[key]]; }
function contentEditBlock() {
  if (!state.contentFromCloud) return t('ie_no_cloud');
  return null;
}
function wireContentInlineEdit(root, key, slotId) {
  if (!root || !isAdminUser()) return;
  const slot = slotId && document.getElementById(slotId);
  if (slot && !slot.firstChild) {
    slot.appendChild(editToggleButton({ label: t('ie_on'), labelOn: t('ie_off'),
      disabledReason: contentEditBlock(), toast,
      onToggle: () => { renderHistoria(); renderVisitInfo(); renderComercial(); } }));
  }
  if (!isEditing() || contentEditBlock()) return;
  root.querySelectorAll('[data-ie]').forEach((el) => {
    const path = el.dataset.ie;
    inlineField(el, {
      type: el.dataset.ieType || 'text',
      value: getPath(contentDoc(key), path) || '',
      placeholder: '…',
      onSave: async (v) => {
        const doc = JSON.parse(JSON.stringify(contentDoc(key) || {}));
        setPath(doc, path, v.trim() || null);
        try {
          const res = await saveRow('content', { id: key, doc });
          applyLocalRow('content', res.row);
          toast(res.queued ? '💾 Guardado en el teléfono — se subirá con señal' : '✓ Guardado');
        } catch (e) { toast(`⚠️ ${(e && e.message) || e}`); }
        renderHistoria(); renderVisitInfo(); renderComercial();
      },
    });
  });
}
// Acciones de foto sobre la galería de la ficha. Reutilizan las mismas
// funciones que el panel de Fotos (mediaActions en admin.js): clasificar,
// borrar y subir tienen que encolarse igual desde los dos sitios.
function wireSpeciesGalleryEdit(s, rest) {
  const repaint = () => { const cur = state.species.find((x) => x.id === s.id) || s; showSpecies(cur); renderSpeciesGrid(); };
  $$('#wp-content .sp-gallery .sp-act').forEach((b) => b.onclick = async (ev) => {
    ev.preventDefault(); ev.stopPropagation();   // no abrir el visor al tocar un botón
    const m = rest[+b.dataset.i]; if (!m) return;
    try {
      if (b.dataset.a === 'cover') await mediaActions.cover(m, s.id, repaint);
      else if (b.dataset.a === 'class') mediaActions.reclassify(m, repaint);
      else if (b.dataset.a === 'del') await mediaActions.remove(m, repaint);
      else if (b.dataset.a === 'adopt') await mediaActions.adopt(m, s.id, repaint);
    } catch (e) { toast(`⚠️ ${(e && e.message) || e}`); }
  });
  const add = $('#sp-add-photo');
  if (add) add.onclick = (ev) => { ev.stopPropagation(); mediaActions.add(s.id, repaint); };
}
function wireSpeciesInlineEdit(s) {
  const en = LANG === 'en';
  const save = async (patch) => {
    try {
      const row = await saveSpeciesPatch(s, patch);
      Object.assign(s, patch);
      renderSpeciesGrid(); showSpecies(state.species.find((x) => x.id === s.id) || s);
      return row;
    } catch (e) { toast(`⚠️ ${(e && e.message) || e}`); }
  };
  const f = (sel, opts) => inlineField($(sel), opts);
  f('#sp-f-common', { value: (en ? s.common_name_en : s.common_name) || '',
    placeholder: en ? 'Common name (EN)' : 'Nombre común',
    onSave: (v) => save(en ? { common_name_en: v.trim() || null } : { common_name: v.trim() || null }) });
  f('#sp-f-sci', { value: s.scientific_name || '', placeholder: 'Nombre científico',
    onSave: (v) => save({ scientific_name: v.trim() || null }) });
  f('#sp-f-family', { value: s.family || '', placeholder: 'Familia',
    onSave: (v) => save({ family: v.trim() || null }) });
  f('#sp-f-desc', { type: 'area', value: (en ? s.description_en : s.description) || '',
    placeholder: en ? 'Technical description (EN)' : 'Descripción técnica',
    onSave: (v) => save(en ? { description_en: v.trim() || null } : { description: v.trim() || null }) });
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
  const close = () => { popBack('lightbox'); ov.classList.remove('open'); };
  pushBack('lightbox', () => ov.classList.remove('open'));
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
    startVisitorTourOnce();   // una sola vez; después queda el ? del header
  };
}

// ---------- planea tu visita ----------
function renderVisitInfo() {
  const el = $('#visit-info');
  if (!el) return;
  const info = state.reserveInfo;
  if (!info) { el.innerHTML = ''; return; }
  const pending = `<span class="v-pending">${t('v_pending')}</span>`;
  const enL = LANG === 'en';
  // Cada valor lleva la RUTA del campo que edita, con el sufijo del idioma en
  // pantalla: editar la ficha en ingles no puede escribir sobre el texto español.
  const val = (field) => { const v = L(info, field); const k = enL ? `${field}_en` : field;
    return `<span data-ie="${k}" data-ie-type="area">${v ? escapeHtml(v) : pending}</span>`; };
  const phone = info.phone || '';
  const wa = (info.whatsapp || '').replace(/[^\d]/g, '');
  const contactBits = [];
  if (phone) contactBits.push(`<a class="v-link" href="tel:${escapeAttr(phone)}">${t('v_call')} ${escapeHtml(phone)}</a>`);
  if (wa) contactBits.push(`<a class="v-link" href="https://wa.me/${wa}" target="_blank" rel="noopener">${t('v_whatsapp')}</a>`);
  const contactHtml = contactBits.length ? contactBits.join(' · ') : pending;
  const rules = L(info, 'rules') || [];

  el.innerHTML = `
    ${isAdminUser() ? `<div class="ce-admin-bar"><span id="vi-ie-slot"></span><button class="ce-edit-btn" id="vi-edit">🗂️ ${t('ce_sections')}</button></div>` : ''}
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
    </div>` : ''}`;
  // El bloque de seguridad («si te pierdes» + 123) se quitó: la reserva es
  // pequeña y con guía, y ese panel ocupaba la mitad de la pantalla con algo que
  // nadie va a leer en el momento en que haría falta. Los campos siguen en
  // reserve_info.json por si vuelve.
  const veb = $('#vi-edit'); if (veb) veb.onclick = () => openContentEditor('reserve_info');
  wireContentInlineEdit(el, 'reserve_info', 'vi-ie-slot');
}
// ---------- Nuestra Historia (data/historia.json) ----------
// TODO el texto viene transcrito de documentos de la reserva; la app sólo lo pinta.
function renderHistoria() {
  const el = $('#historia'); if (!el) return;
  const h = state.historia;
  if (!h) { el.innerHTML = ''; return; }
  // Secciones: se pintan en el orden del JSON. Añadir texto = añadir un objeto.
  const en = LANG === 'en';
  const editing = isAdminUser() && isEditing();
  const blk = (b, i) => {
    const titulo = L(b, 'titulo'), texto = L(b, 'texto');
    if (!titulo && !texto && !editing) return '';   // slot vacío → no ocupa espacio
    return `<section class="panel hist-panel">
      ${b.foto ? `<img class="hist-foto" src="${escapeAttr(b.foto)}" alt="" loading="lazy">` : ''}
      <h2 class="hist-h" data-ie="secciones.${i}.${en ? 'titulo_en' : 'titulo'}">${escapeHtml(titulo)}</h2>
      <div data-ie="secciones.${i}.${en ? 'texto_en' : 'texto'}" data-ie-type="area">${texto ? paraHtml(texto, 'hist-p') : ''}</div>
      ${b.pie ? `<p class="hist-pie">${escapeHtml(b.pie)}</p>` : ''}
    </section>`;
  };
  const items = (h.hitos && h.hitos.items) || [];
  const hitos = items.length ? `<section class="panel hist-panel hist-tl-panel">
      <h2 class="hist-h">${escapeHtml(L(h.hitos, 'titulo') || '')}</h2>
      <ol class="hist-timeline">${items.map((it, i) => `<li class="${it.hito ? 'is-key' : ''}">
        <span class="ht-date">${escapeHtml(it.fecha || '')}</span>
        <span class="ht-text" data-ie="hitos.items.${i}.${en ? 'texto_en' : 'texto'}" data-ie-type="area">${escapeHtml(L(it, 'texto') || '')}</span></li>`).join('')}</ol>
    </section>` : '';
  el.innerHTML = `${isAdminUser() ? `<div class="ce-admin-bar"><span id="hist-ie-slot"></span><button class="ce-edit-btn" id="hist-edit">🗂️ ${t('ce_sections')}</button></div>` : ''}
    <figure class="hist-quote"><blockquote data-ie="${en ? 'lead_en' : 'lead'}" data-ie-type="area">${escapeHtml(L(h, 'lead') || '')}</blockquote></figure>
    ${(h.secciones || []).map(blk).join('')}${hitos}`;
  const eb = $('#hist-edit'); if (eb) eb.onclick = () => openContentEditor('historia');
  wireContentInlineEdit(el, 'historia', 'hist-ie-slot');
}
// Íconos de las apps a las que llevan los enlaces. Van EN LÍNEA (SVG, sin red):
// la app tiene que verse igual sin señal, así que nada de cargarlos de un CDN.
// Son glifos simplificados en el color de cada marca, no el logotipo oficial:
// reconocibles de un vistazo y sin apropiarse de la marca de nadie.
const APP_ICONS = {
  airbnb: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 3.6 19.6a2.6 2.6 0 0 0 3.7 3.3L12 20l4.7 2.9a2.6 2.6 0 0 0 3.7-3.3L12 2.5Zm0 5.6 4 8.1a1 1 0 0 1-1.4 1.3L12 15.9l-2.6 1.6A1 1 0 0 1 8 16.2l4-8.1Z"/></svg>',
  wa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .1-1.7-.1-2.7-1-4.5-3.7-4.6-3.9-.1-.2-1.1-1.4-1.1-2.7s.7-1.9 1-2.2c.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 1.9c.1.2 0 .4-.1.5l-.4.5c-.1.2-.3.3-.1.6.1.3.6 1.1 1.4 1.8 1 .9 1.7 1.1 2 1.2.2.1.4.1.6-.1l.7-.8c.2-.2.4-.2.6-.1l1.8.9c.2.1.4.2.4.4v.9Z"/></svg>',
  ig: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.6" y="2.6" width="18.8" height="18.8" rx="5.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.4" cy="6.6" r="1.4"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1.8 2L12 12.2 19.2 7H4.8Z"/></svg>',
};
// Tarjeta grande de enlace: ícono + a dónde va + qué es. Antes eran botones
// pequeños con un emoji, difíciles de acertar con el pulgar.
function linkCard(url, key, title, sub) {
  if (!url) return '';
  const ext = /^https?:/.test(url) ? ' target="_blank" rel="noopener"' : '';
  return `<a class="cm-card cm-${key}" href="${escapeAttr(url)}"${ext}>
    <span class="cm-ico">${APP_ICONS[key] || ''}</span>
    <span class="cm-card-t"><b>${escapeHtml(title)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
  </a>`;
}
// ---------- Info comercial: servicios, tarifas, Airbnb, redes, reseñas ----------
function renderComercial() {
  const el = $('#comercial'); if (!el) return;
  const c = state.comercial;
  if (!c) { el.innerHTML = ''; return; }
  const svc = (s) => `<div class="cm-svc">
      <div class="cm-svc-h"><span class="cm-emoji">${s.emoji || '•'}</span>
        <b>${escapeHtml(LANG === 'en' && s.nombre_en ? s.nombre_en : s.nombre)}</b></div>
      <div class="cm-price">${escapeHtml(s.tarifa || '')}</div>
      <div class="cm-when">${escapeHtml(LANG === 'en' && s.horario_en ? s.horario_en : (s.horario || ''))}</div>
      ${(s.incluye || []).length ? `<ul class="cm-inc">${s.incluye.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
      ${s.nota ? `<p class="tiny muted">${escapeHtml(s.nota)}</p>` : ''}
    </div>`;
  const wa = (c.whatsapp || '').replace(/\D/g, '');
  const rm = c.resenas_meta || {};
  const revs = c.resenas || [];
  el.innerHTML = `
    ${isAdminUser() ? `<button class="ce-edit-btn" id="cm-edit">✏️ ${t('ce_edit_info')}</button>` : ''}
    <div class="panel">
      <h2 class="hist-h">${t('cm_services_h')}</h2>
      <div class="cm-list">${(c.servicios || []).map(svc).join('')}</div>
      ${(c.adicionales || []).length ? `<h3 class="cm-sub">${t('cm_extra_h')}</h3>
        <ul class="cm-inc">${c.adicionales.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : ''}
      <p class="tiny muted">${t('cm_rates_note')}${c._meta && c._meta.vigencia ? ` (${escapeHtml(c._meta.vigencia)})` : ''}</p>
    </div>
    <div class="panel">
      <h2 class="hist-h">${t('cm_book_h')}</h2>
      <div class="cm-links">
        ${linkCard(c.airbnb_url, 'airbnb', t('cm_airbnb'), 'Airbnb')}
        ${wa ? linkCard(`https://wa.me/${wa}`, 'wa', 'WhatsApp', t('cm_wa_sub')) : ''}
        ${linkCard(c.instagram_url, 'ig', 'Instagram', c.instagram_handle || '')}
        ${c.email ? linkCard(`mailto:${c.email}`, 'mail', t('cm_email'), c.email) : ''}
      </div>
    </div>
    <div class="panel">
      <h2 class="hist-h">${t('cm_reviews_h')}</h2>
      ${rm.rating ? `<div class="cm-score">
          <span class="cm-score-n">${escapeHtml(String(rm.rating).replace('.', ','))}</span>
          <span class="cm-stars" aria-hidden="true">★★★★★</span>
          ${rm.total ? `<span class="cm-score-c">${escapeHtml(String(rm.total))} ${t('cm_reviews_n')}</span>` : ''}
        </div>` : ''}
      ${revs.length
        ? `<div class="cm-revs" id="cm-revs">${revs.map((r, i) => `<blockquote class="cm-rev${i >= 3 ? ' is-more' : ''}">
            <p>${escapeHtml(r.texto || '')}</p>
            <footer><span class="cm-rev-who">${escapeHtml(r.autor || '')}</span>${r.origen ? ` · ${escapeHtml(r.origen)}` : ''}${r.fecha ? ` · ${escapeHtml(r.fecha)}` : ''}${r.traducido ? ` · <i>${t('cm_translated')}</i>` : ''}</footer>
          </blockquote>`).join('')}</div>
          ${revs.length > 3 ? `<button class="cm-more" id="cm-more">${t('cm_more')} (${revs.length - 3})</button>` : ''}`
        : `<p class="muted">${t('cm_reviews_empty')}</p>`}
    </div>`;
  // El segundo enlace a Airbnb (bajo las reseñas) se quitó: era el mismo destino
  // que la tarjeta de arriba, y dos botones idénticos hacen dudar de si llevan
  // a sitios distintos.
  const ceb = $('#cm-edit'); if (ceb) ceb.onclick = () => openContentEditor('comercial');
  const more = $('#cm-more');
  if (more) more.onclick = () => {
    $$('#cm-revs .is-more').forEach((n) => n.classList.remove('is-more'));
    more.remove();
  };
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// ---------- cuenta / dashboard ----------
async function renderDashboard() {
  const el = $('#dashboard'); if (!el) return;
  const user = Cloud.currentUser();
  const walks = await listWalks();
  // Cada estampa espera a su foto de fondo; en paralelo, no una tras otra.
  const walkCards = await Promise.all(walks.map((w) => walkCardHTML(w)));
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
    ${walks.length ? `<div class="dash-walks">${walkCards.join('')}</div>` : `<p class="muted">${t('dash_no_walks')}</p>`}
    <h2 class="dash-h2">${t('dash_photos_h')}</h2>
    ${photos.length ? `<div class="dash-photos">${photos.map((ph) => `<figure><img src="${ph.url}" alt="" loading="lazy"><figcaption>${escapeHtml(ph.common)}</figcaption></figure>`).join('')}</div>` : `<p class="muted">${t('dash_no_photos')}</p>`}
    <h2 class="dash-h2">${t('up_h')}</h2>
    ${myMediaHTML()}`;
  const lo = $('#dash-logout'); if (lo) lo.onclick = doLogout;
  const cta = $('#dash-cta'); if (cta) cta.onclick = () => { localStorage.removeItem('cantares_guest'); location.reload(); };
  $$('#dashboard .rec-dl').forEach((b) => b.onclick = () => { const w = walks.find((x) => x.id === b.dataset.id); if (w) downloadWalk(w); });
  wireMyMedia();
}

// ---------- fotos aportadas por el visitante ----------
// Un visitante con cuenta puede subir fotos y clasificarlas. Entran como
// `unclassified` con `origin: 'visitor-upload'` y sólo llegan al inventario
// público cuando un admin las revisa. La política RLS (migración 23) le deja
// editar y borrar LO SUYO mientras siga sin clasificar, y no después: una vez
// publicada, la foto ya no es suya para reapuntarla.
// Id local para una fila nueva (mismo formato que admin.js): la cola offline es
// idempotente por id, así que tiene que generarse en el teléfono, no en el servidor.
const newId = (pfx) => `${pfx}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
function myMedia() {
  const u = Cloud.currentUser();
  if (!u) return [];
  const rank = (m) => (m.status === 'unclassified' ? 0 : 1);   // lo pendiente, primero
  return (state.media.all || []).filter((m) => m.contributor === u.id)
    .sort((a, b) => rank(a) - rank(b));
}
function myMediaHTML() {
  if (!Cloud.isLoggedIn()) return '<p class="muted">' + t('up_need_account') + '</p>';
  const mine = myMedia();
  const cards = mine.map((m) => {
    const sp = m.subject_id && state.species.find((x) => x.id === m.subject_id);
    const unclass = m.status === 'unclassified';
    return `<figure data-id="${escapeHtml(m.id)}">
        <img src="${escapeHtml(m.thumb || m.full)}" alt="" loading="lazy">
        <figcaption>
          <span class="up-state ${unclass ? 'is-unclass' : ''}">${unclass ? t('up_unclass') : t('up_class')}</span>
          ${sp ? escapeHtml(L(sp, 'common_name') || sp.scientific_name || '') : ''}
          ${unclass ? `<span class="up-acts"><button class="up-pick">${t('up_pick')}</button><button class="up-del">${t('up_del')}</button></span>` : ''}
        </figcaption></figure>`;
  }).join('');
  return `<p class="tiny muted">${t('up_hint')}</p>
    <button class="dash-cta up-add" id="up-add">${t('up_add')}</button>
    <input id="up-file" type="file" accept="image/*" capture="environment" hidden />
    ${mine.length ? `<div class="dash-photos up-grid">${cards}</div>` : `<p class="muted">${t('up_none')}</p>`}`;
}
function wireMyMedia() {
  const add = $('#up-add'), file = $('#up-file');
  if (add && file) {
    add.onclick = () => file.click();
    file.onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const blob = await compressImage(f);
      // Entra SIN clasificar a propósito: el visitante elige la especie después
      // y, si no lo hace, decide un admin. Nunca se adivina por él.
      const row = { id: newId('media'), kind: 'photo', origin: 'visitor-upload',
        status: 'unclassified', subject_type: null, subject_id: null,
        is_primary: false, sort: 100, reviewed: false,
        taken_at: new Date().toISOString(),
        lat: state.userPos ? state.userPos[1] : null,
        lng: state.userPos ? state.userPos[0] : null };
      try {
        const r = await saveRow('media', row, { url: blob });   // la clave = la COLUMNA destino
        applyLocalRow('media', r.row);
        toast(r.queued ? t('up_queued') : t('up_saved'));
      } catch (err) { toast('⚠️ ' + ((err && err.message) || 'error')); }
      renderDashboard();
    };
  }
  $$('#dashboard .up-pick').forEach((b) => b.onclick = () => pickSpeciesFor(b.closest('figure').dataset.id));
  $$('#dashboard .up-del').forEach((b) => b.onclick = async () => {
    if (!confirm(t('up_del_sure'))) return;
    const id = b.closest('figure').dataset.id;
    try { await deleteRow('media', id); removeLocalRow('media', id); }
    catch (e) { toast('⚠️ ' + e.message); }
    renderDashboard();
  });
}
// Selector de especie para una foto propia. Con buscador porque el inventario
// tiene ~740 entradas: una lista sin filtro no se puede usar en un teléfono.
function pickSpeciesFor(mediaId) {
  const m = state.media.byId[mediaId];
  if (!m) return;
  const ov = document.createElement('div');
  ov.id = 'up-picker'; ov.className = 'fm-assign';
  document.body.appendChild(ov);
  const close = () => { popBack('picker'); ov.remove(); };
  const render = (q) => {
    const query = (q || '').trim().toLowerCase();
    const list = state.species.filter((sp) => !query
      || (L(sp, 'common_name') || '').toLowerCase().includes(query)
      || (sp.scientific_name || '').toLowerCase().includes(query)).slice(0, 60);
    const box = ov.querySelector('#up-list');
    box.innerHTML = list.map((sp) =>
      `<button class="fm-assign-item" data-sp="${escapeHtml(sp.id)}"><b>${escapeHtml(L(sp, 'common_name') || sp.scientific_name || sp.id)}</b> <span>${escapeHtml(sp.scientific_name || '')}</span></button>`).join('');
    box.querySelectorAll('.fm-assign-item').forEach((b) => b.onclick = async () => {
      close();
      try {
        // La procedencia se CONSERVA: es un hecho histórico de la foto, no algo
        // que se recalcule al clasificar. Sólo cambian el sujeto y el estado.
        // Sigue `unclassified`: quien publica al inventario es el admin.
        const r = await saveRow('media', Object.assign(mediaRowFrom(m), {
          subject_type: 'species', subject_id: b.dataset.sp, status: 'unclassified' }));
        applyLocalRow('media', r.row);
      } catch (e) { toast('⚠️ ' + e.message); }
      renderDashboard();
    });
  };
  ov.innerHTML = `<div class="fm-assign-box">
      <h3>${t('up_pick_h')}</h3>
      <input id="up-q" class="gm-input" placeholder="${t('up_search')}" autocomplete="off" />
      <div class="fm-assign-list" id="up-list"></div>
      <button class="admin-cancel" id="up-x">✕</button>
    </div>`;
  pushBack('picker', () => ov.remove());
  ov.querySelector('#up-x').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.querySelector('#up-q').oninput = (e) => render(e.target.value);
  render('');
}
// Registro normalizado -> fila de `media`, conservando la procedencia. Espejo de
// mediaRow() en admin.js; se duplica aquí para no cargar el módulo de admin
// desde el panel de un visitante.
function mediaRowFrom(m) {
  // Ver assertUploadable() en admin.js: un `blob:` es una referencia de sesión,
  // no una URL. Persistirla deja la fila apuntando a nada.
  if (typeof m.full === 'string' && m.full.startsWith('blob:')) {
    throw new Error(t('up_wait_upload'));
  }
  return { id: m.id, kind: m.kind || 'photo', url: m.full,
    thumb: (m.thumb && m.thumb !== m.full) ? m.thumb : null, poster: m.poster || null,
    subject_type: m.subject_type, subject_id: m.subject_id,
    is_primary: !!m.is_primary, sort: m.sort || 0, focal_x: m.focal_x, focal_y: m.focal_y,
    caption: m.caption || null, caption_en: m.caption_en || null, credit: m.credit || null,
    origin: m.origin || 'visitor-upload', content_hash: m.content_hash || null,
    lat: m.lat, lng: m.lng, taken_at: m.taken_at, walk_id: m.walk_id,
    species_hint: m.species_hint || null, hint_confidence: m.hint_confidence,
    reviewed: !!m.reviewed, status: m.status };
}

// ---------- botón «atrás» del teléfono ----------
// Sin esto, «atrás» sale de la app aunque haya una ficha abierta o estés en otra
// pestaña. Modelo: una pila de cosas que atrás debe deshacer + UNA entrada
// "centinela" en el historial. Al pulsar atrás se consume el centinela, se
// deshace un paso y se vuelve a armar. Con la pila vacía no se arma: el
// siguiente atrás sí sale de la app (que es lo que el usuario espera en el mapa).
const backStack = [];       // [{ name, undo }] — el tope es lo último abierto
let _sentinel = false;      // ¿hay entrada centinela en el historial?
let _undoing = false;       // dentro de popstate: no re-empujar historial
function armBack() {
  if (_sentinel) return;
  try { history.pushState({ cantares: 1 }, ''); _sentinel = true; } catch (e) { /* file:// */ }
}
function pushBack(name, undo) {
  if (_undoing) return;
  const i = backStack.findIndex((b) => b.name === name);
  if (i >= 0) backStack.splice(i, 1);   // reabrir la misma capa no la duplica
  backStack.push({ name, undo });
  armBack();
}
// Cierre programático (botón ×, tap fuera, cambio de pestaña): sólo saca la capa
// de la pila; el cierre visual lo hace quien llama. El centinela se queda armado
// a propósito: consumirlo con history.back() aquí es asíncrono y pisaba el
// pushState del cambio de pestaña que ocurre justo después (atrás rebotaba solo).
// Coste: tras cerrar la última capa con ×, el primer atrás no hace nada visible
// y el segundo sale de la app.
function popBack(name) {
  const i = backStack.findIndex((b) => b.name === name);
  if (i >= 0) backStack.splice(i, 1);
}
window.addEventListener('popstate', () => {
  _sentinel = false;                       // el centinela se acaba de consumir
  const it = backStack.pop();
  if (!it) return;                         // nada que deshacer → atrás sale de la app
  _undoing = true;
  try { it.undo(); } catch (e) { console.warn('back', e && e.message); }
  finally { _undoing = false; }
  if (backStack.length) armBack();         // aún queda algo que deshacer: rearmar
});

// ---------- navigation ----------
function switchView(name) {
  const prev = currentView();
  // La ficha es un overlay de nivel superior: al cambiar de pestaña, ciérrala
  // (antes vivía dentro de Recorridos y se ocultaba sola con la vista).
  if (state.openWaypointId || state.openSpeciesId) closeWaypoint();
  $$('.view').forEach((v) => v.classList.remove('is-active'));
  $(`#view-${name}`).classList.add('is-active');
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === name));
  const acc = $('#account-btn'); if (acc) acc.classList.toggle('active', name === 'cuenta');
  if (name === 'recorridos' && state.map) setTimeout(() => state.map.resize(), 60);
  if (name === 'cuenta') renderDashboard();
  if (name === 'juego') refreshGameUI();
  // Atrás vuelve a la pestaña anterior. Volver a Recorridos (la de inicio) no
  // apila nada: desde ahí atrás debe salir de la app.
  if (prev === name) return;
  if (name === 'recorridos') popBack('view');
  else pushBack('view', () => switchView(prev));
}
function currentView() {
  const v = $$('.view').find((x) => x.classList.contains('is-active'));
  return v ? v.id.replace('view-', '') : 'recorridos';
}

// ---------- búsqueda de puntos ----------
function openSearch() {
  $('#search-panel').classList.remove('hidden');
  pushBack('search', closeSearch);
  const inp = $('#search-input'); inp.value = ''; renderSearch(''); setTimeout(() => inp.focus(), 60);
}
function closeSearch() { popBack('search'); $('#search-panel').classList.add('hidden'); }
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
  // Recta dentro de la zona de recorrido libre; la distancia se recalcula sobre
  // el trazado ya simplificado para no anunciar metros que nadie va a caminar.
  const coords = freeRoamPath([from, ...path, to]);
  return { coords, distM: pathLengthM(coords), onTrail: true };
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
  // ¿Ya había un service worker mandando en esta pestaña ANTES de registrar? Si
  // lo había y de repente lo reemplaza otro, es que se desplegó una versión
  // nueva. En la primera visita no hay nada viejo que reemplazar.
  const had = !!navigator.serviceWorker.controller;
  try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW', e); return; }
  if (!had) return;
  // El shell se sirve stale-while-revalidate ARCHIVO POR ARCHIVO: al desplegar,
  // esta pestaña ya pintó con los archivos viejos y el SW nuevo trae los nuevos.
  // Mezclar las dos versiones es lo que rompió v62 (index.html nuevo + app.js
  // viejo). Por eso, cuando el SW nuevo toma el control, se recarga una vez.
  let done = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (done) return;
    done = true;
    // …salvo si hay algo abierto: recargar mientras se escribe una descripción o
    // se elige un punto tira ese trabajo por la ventana. Ahí se avisa y decide
    // la persona. La cola offline ya guardó lo confirmado; lo a medias, no.
    const busy = document.querySelector('#ce-ov, .gm-overlay, #fm-assign')
      || document.body.classList.contains('admin-open')
      || document.body.classList.contains('picking-points');
    if (busy) { toast(t('sw_new_version')); return; }
    location.reload();
  });
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
// Abrir la leyenda hacia ARRIBA cuando desplegarla hacia abajo se saldría de la
// pantalla. Sólo puede pasar tras arrastrarla: en su sitio de origen está anclada
// por `bottom` y crece hacia arriba sola; makeDraggable la pasa a `top`.
// El botón no se mueve al abrir ni al cerrar — se recoloca la caja para
// compensar, o el dedo iría a buscarlo donde ya no está.
function toggleLegend() {
  const el = $('#legend'), tg = $('#legend-toggle');
  const parent = el.offsetParent || document.body;
  const dragged = !!el.style.top;
  const yBefore = el.offsetTop + tg.offsetTop;
  el.classList.toggle('collapsed');
  el.classList.remove('up');
  if (dragged && !el.classList.contains('collapsed')
      && el.offsetTop + el.offsetHeight > parent.clientHeight - 8) {
    el.classList.add('up');
  }
  if (!dragged) return;
  const yAfter = el.offsetTop + tg.offsetTop;
  if (yAfter !== yBefore) el.style.top = (el.offsetTop + yBefore - yAfter) + 'px';
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
  // Si el elemento no está en el DOM, no hay nada que arrastrar — y sobre todo,
  // no se puede tumbar el arranque entero por eso. Pasó de verdad al desplegar
  // v62: el service worker sirve stale-while-revalidate POR ARCHIVO, así que
  // hubo una ventana con el index.html nuevo (sin #base-toggle) y el app.js
  // viejo (que aún lo buscaba). handle era null, `main()` lanzaba en esta línea
  // y la app se quedaba en «Error: Cannot read properties of null» — sin mapa,
  // sin admin y sin cola de sincronización. Un widget que falta debe ser un
  // widget que falta, no una app muerta.
  if (!el || !handle) { console.warn('[ui] makeDraggable: falta el elemento', key); return; }
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
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $('#lang-toggle').textContent = LANG === 'es' ? 'EN' : 'ES';
  const h = $('#bc-handle'); if (h) h.setAttribute('aria-label', t('base_compare_a11y'));
  const hb = $('#help-btn'); if (hb) { hb.title = t('help_a11y'); hb.setAttribute('aria-label', t('help_a11y')); }
}
function setLang(lang) {
  LANG = lang; localStorage.setItem('cantares_lang', lang);
  applyStaticI18n(); renderRouteBar(); selectRoute(state.activeRoute);
  renderSpeciesFilters(); renderSpeciesGrid(); renderCarbon(); renderOfflineStatus(); renderLegend(); refreshGameUI(); renderVisitInfo(); renderHistoria(); renderComercial();
  if (state.openWaypointId) { const wp = state.waypoints.find((w) => w.properties.id === state.openWaypointId); if (wp) showWaypoint(wp); }
  if (state.watchId == null) setGps('off', t('gps'));
}

// ---------- init ----------
async function main() {
  // Volver de Dropbox: canjear el código y limpiar la URL ANTES de nada. Si se
  // deja para después, la puerta de entrada o el service worker pueden recargar
  // y el código —de un solo uso— se pierde.
  try { await dropboxHandleRedirect(); } catch (e) { console.warn('dropbox', e && e.message); }
  $$('.tab').forEach((tab) => tab.onclick = () => switchView(tab.dataset.view));
  $('#wp-close').onclick = closeWaypoint;
  $('#lang-toggle').onclick = () => setLang(LANG === 'es' ? 'en' : 'es');
  $('#account-btn').onclick = () => switchView('cuenta');   // Cuenta pasó del tabbar al header
  // Tap fuera del recuadro (sobre el fondo oscuro) lo cierra.
  $('#waypoint-card').addEventListener('click', (e) => { if (e.target.id === 'waypoint-card') closeWaypoint(); });
  $('#search-btn').onclick = openSearch;
  // Buscador de la pestaña Especies. Se filtra al teclear (744 especies en
  // memoria: no hace falta ni debounce ni ir al servidor) y la ✕ sólo aparece
  // cuando hay algo escrito, para no ofrecer un botón que no hace nada.
  const spQ = $('#species-q'), spX = $('#species-q-x');
  if (spQ) {
    const applyQ = () => { speciesQuery = spQ.value; if (spX) spX.hidden = !spQ.value; renderSpeciesGrid(); };
    spQ.oninput = applyQ;
    if (spX) spX.onclick = () => { spQ.value = ''; applyQ(); spQ.focus(); };
  }
  $('#search-close').onclick = closeSearch;
  $('#search-input').oninput = (e) => renderSearch(e.target.value);
  // Legend and GPS button: draggable (tap still collapses / locates).
  makeDraggable($('#legend'), $('#legend-toggle'), 'cantares_pos_legend', toggleLegend);
  // Menos desorden en móvil: la leyenda arranca colapsada (un tap la abre).
  if (window.matchMedia && window.matchMedia('(max-width: 560px)').matches) $('#legend').classList.add('collapsed');
  makeDraggable($('#locate-btn'), $('#locate-btn'), 'cantares_pos_locate', locate);
  // El pellizco de página ya NO se bloquea (ver el viewport en index.html): era
  // el otro cerrojo que impedía agrandar la letra. Se sigue bloqueando sobre el
  // mapa, que tiene su propio zoom y donde el gesto del navegador estorba.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
    $('#map').addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  window.addEventListener('online', renderOfflineStatus);
  window.addEventListener('offline', renderOfflineStatus);
  window.addEventListener('cantares:recstate', renderRouteBar);   // refresca el chip "Recorrido libre"

  // Register the PMTiles protocol (for an optional local orthophoto layer).
  if (window.pmtiles && maplibregl.addProtocol) {
    try { maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile); } catch (e) { /* already registered */ }
  }
  // La ortofoto local, si existe, pasa a ser la imagen ACTUAL del mapa (drop it at
  // tiles/ortho.pmtiles). La cortina compara siempre el primer paso con esta.
  try {
    const r = await fetch('tiles/ortho.pmtiles', { method: 'HEAD' });
    if (r.ok) { CONFIG.baseStops.push({ key: 'ortho', pmtiles: true }); state.baseIndex = CONFIG.baseStops.length - 1; }
  } catch (e) { /* no ortho yet */ }

  // Ningún archivo de datos puede tumbar la app entera: si `species.json` (546 KB)
  // no alcanzó a descargarse antes de perder la señal, el mapa, los senderos y
  // los recorridos NO dependen de él y tienen que seguir funcionando. Lo que
  // falte se avisa abajo, en vez de dejar una pantalla en blanco.
  const missing = [];
  const loadOr = (key, fallback) => loadJSON(CONFIG.data[key]).catch(() => { missing.push(key); return fallback; });
  const [routesDoc, speciesDoc, reserveInfo, mediaDoc, groupsDoc, historiaDoc, comercialDoc] = await Promise.all([
    loadOr('routes', { routes: [] }), loadOr('species', { species: [] }),
    loadJSON(CONFIG.data.reserveInfo).catch(() => null),
    loadJSON(CONFIG.data.media).catch(() => null),
    loadJSON(CONFIG.data.speciesGroups).catch(() => null),
    loadJSON(CONFIG.data.historia).catch(() => null),
    loadJSON(CONFIG.data.comercial).catch(() => null),
  ]);
  state.historia = historiaDoc;
  state.comercial = comercialDoc;
  state.speciesGroups = (groupsDoc && Array.isArray(groupsDoc.groups) && groupsDoc.groups.length) ? groupsDoc.groups : SPECIES_GROUPS_FALLBACK;
  state.routes = routesDoc.routes || [];
  state.staticRoutes = state.routes;   // respaldo para el merge con la nube
  state.routesById = Object.fromEntries(state.routes.map((r) => [r.id, r]));
  state.species = speciesDoc.species || [];
  state.staticSpecies = state.species;   // respaldo para el merge con la nube
  if (missing.length) toast(t('data_missing'));
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
  renderRouteBar(); renderSpeciesFilters(); renderSpeciesGrid(); renderOfflineStatus(); renderCarbon(); renderLegend(); renderVisitInfo(); renderHistoria(); renderComercial();

  // El resto del arranque ocurre DESPUÉS de la puerta de entrada (login/invitado).
  const enterApp = async () => {
    // La puerta de entrada pudo cambiar el idioma (botón English): sincronizar.
    const gateLang = localStorage.getItem('cantares_lang');
    if (gateLang && gateLang !== LANG) setLang(gateLang);
    await loadCloudData();                       // preferir datos de la nube (ediciones del admin)
    renderSpeciesFilters(); renderSpeciesGrid(); renderLegend();
    if (!localStorage.getItem('cantares_onboarded')) showOnboarding();
    await initGame({ state, t, L, toast, rerenderSpecies: () => renderSpeciesGrid(), pushBack, popBack,
      hasAccount,   // funcion, no valor: `user` era una foto fija del init y se
                    // quedaba obsoleta si la sesion caducaba a media caminata
      cloud: { enabled: Cloud.cloudConfigured() && Cloud.isLoggedIn(), user: Cloud.currentUser(),
        currentUser: Cloud.currentUser, rankingRows: Cloud.rankingRows,
        addSighting: Cloud.addSighting, mySightings: Cloud.mySightings, uploadImage: Cloud.uploadImage } });
    if (!new URLSearchParams(location.search).has('nomap')) {
      await initMap();
      renderLegend(); applyWaypointFilter(); selectRoute(null);
      initCompare();
      onStyleReady(state.map, () => { try { gameAddMapLayer(); } catch (e) { console.warn('gameAddMapLayer', e); } });
      initAdmin({ state, map: state.map, t, L, LANG, toast, makeDraggable,
        typeColor: (tp) => typeMeta(tp).color,
        refreshWaypoints, refreshSpecies, refreshRoutes, refreshTrails, refreshMedia,
        applyLocalRow, removeLocalRow, pushBack, popBack, applyWaypointFilter, openLightbox,
        showPointPopup: (id) => { const w = wpById(id); if (w) miniPopup(w); },   // mismo popup que fuera del modo edición (con "más info" + "Editar")
        pointTypes: () => Object.keys(TYPE_META).map((tp) => ({ tipo: tp, emoji: TYPE_META[tp].emoji, color: TYPE_META[tp].color, label: typeLabel(tp), es: TYPE_META[tp].es, en: TYPE_META[tp].en })),
        registerPointType, savePointType,
        ensureGps: () => { if (state.watchId == null) locate(); },   // GPS caliente para marcar sin esperar
        orderPointsAlongSegments,   // guiones en el orden del recorrido (editor de recorridos)
        freeRoam: () => state.freeroam,
        // ¿Está el punto dentro de la zona de recorrido libre? Lo usa el editor
        // para no dejar dibujar un trazo libre fuera de ella. Sin zona definida
        // devuelve true (falla abierto): el editor no puede bloquear por algo
        // que el admin todavía no ha dibujado.
        inFreeRoam: (pt) => { const ring = freeRoamRing(); return ring ? inPolygon(pt, ring) : true; },
        setFreeRoam: (doc) => { state.freeroam = doc; if (state.activeRoute) selectRoute(state.activeRoute); },
        redrawActiveRoute: () => { if (state.activeRoute) selectRoute(state.activeRoute); } });
      initRecorder({ state, t, L, toast, ensureGps: () => { if (state.watchId == null) locate(); },
      tileUrl: () => { const s = CONFIG.baseStops.filter((x) => x.tiles).pop(); return s ? s.tiles : null; } });
    }
    // Fuera del bloque del mapa: con ?nomap el ? seguiria existiendo en el header
    // y no haria nada. Los pasos que senalan el mapa caen a tarjeta solos.
    initGuide({ state, switchView, currentView, pushBack, popBack, selectRoute, openAdminAt, closeAdmin,
      ensureGps: () => { if (state.watchId == null) locate(); },
      // La guia manda en la pantalla mientras enseña: cualquier caja de la app
      // (ficha del recorrido, aviso del GPS, popup de un punto) tapaba el paso
      // siguiente. Se despeja antes de cada paso; el que necesite una caja
      // abierta la abre en su propio `go`.
      clearBoxes: () => {
        const ri = $('#route-info'); if (ri) ri.classList.add('hidden');
        const pt = $('#proximity-toast'); if (pt) pt.classList.add('hidden');
        closeWaypoint(); removePopup();
      },
      openLegend: () => { const l = $('#legend'); if (l) l.classList.remove('collapsed'); },
      routeInfoOpen: () => { const ri = $('#route-info'); return !!ri && !ri.classList.contains('hidden'); } });
    // Cola offline: reflejar cambios pendientes de sesiones sin señal y
    // subirlos automáticamente cuando vuelva el internet.
    await applyPendingLocally();
    initSync({
      onSynced: async (n) => {
        toast(`☁️ ${n} cambio(s) sincronizado(s)`);
        await refreshRoutes(); await refreshTrails(); await refreshWaypoints(); await refreshSpecies(); await refreshMedia();
        try { const cpt = await Cloud.listPointTypes(); applyCloudTypes(cpt); } catch (e) { /* tipos: sin conexión */ }
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
  // Sin internet no se intenta siquiera: `main` espera a que esto termine antes
  // de pintar el mapa, y con una barra de señal (`navigator.onLine` dice true y
  // miente) las siete peticiones se quedan colgadas del timeout mientras el
  // visitante mira una pantalla vacía. Los refrescos posteriores ya lo hacían.
  if (!navigator.onLine) return;
  try {
    const [cw, cs, cr, ct, cm, cpt, cc, cts] = await Promise.all([
      Cloud.listWaypoints().catch(() => null), Cloud.listSpecies().catch(() => null),
      Cloud.listRoutes().catch(() => null), Cloud.listTrails().catch(() => null),
      Cloud.listMedia().catch(() => null), Cloud.listPointTypes().catch(() => null),
      Cloud.listContent().catch(() => null),
      Cloud.listRouteTimeStats().catch(() => null),
    ]);
    // La marca va aquí y no dentro de applyCloudContent: lo que habilita editar
    // es que la CONSULTA haya funcionado, no que haya filas. Una tabla vacía es
    // un estado legítimo (todavía no se ha guardado nada) y con la marca dentro
    // se quedaba bloqueada la edición para siempre.
    if (cc) state.contentFromCloud = true;
    if (cc && cc.length) applyCloudContent(cc);   // textos de Historia / Info editados por el admin
    // Tiempos medidos: mientras no haya 3 caminatas completas de un recorrido no
    // hay fila, y routeDuration se queda con el modelo. Es lo normal al principio.
    if (cts && cts.length) { state.routeStats = {}; cts.forEach((r) => { state.routeStats[r.route_id] = r; }); }
    if (cpt && cpt.length) applyCloudTypes(cpt);   // tipos de punto ANTES de coloreado/leyenda
    if (cw && cw.length) applyCloudWaypoints(cw);
    if (cs && cs.length) applyCloudSpecies(cs);
    if (cr && cr.length) applyCloudRoutes(cr);
    if (ct && ct.length) { const fc = { type: 'FeatureCollection', features: ct.map(cloudTrailToFeature) }; normalizeFeatures(fc); state.trails = fc.features; }
    if (cm) applyCloudMedia(cm);   // tabla de medios (fotos + videos) sobre las estáticas
    renderHistoria(); renderComercial();
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
    renderSpeciesGrid(); refreshOpenCard();   // los puntos por especie cambiaron
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
      const f = fc.features[0];
      // Conservar los atributos que sólo viven en el estático (sci, family, tag,
      // altitud): la fila de la nube no los guarda y, sin este merge, editar un
      // árbol le borraba el nombre científico hasta recargar. Mismo criterio que
      // applyCloudWaypoints.
      const base = (state.staticWaypoints || []).find((w) => w.properties.id === row.id);
      if (base) f.properties = { ...base.properties, ...cleanProps(f.properties) };
      const i = state.waypoints.findIndex((w) => w.properties.id === row.id);
      if (i >= 0) state.waypoints[i] = f; else state.waypoints.push(f);
      const src = state.map && state.map.getSource('waypoints');
      if (src) src.setData({ type: 'FeatureCollection', features: state.waypoints });
      renderLegend(); applyWaypointFilter();
      // Cambiar los species_ids de un punto cambia QUÉ especies tienen puntos:
      // la pestaña Especies (y la ficha abierta) deben reflejarlo al instante.
      renderSpeciesGrid(); refreshOpenCard();
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
    } else if (table === 'content') {
      applyCloudContent([row]);
      renderHistoria(); renderComercial(); renderVisitInfo();
    } else if (table === 'point_types') {
      mergePointType(row);
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
      renderSpeciesGrid(); refreshOpenCard();   // el punto ya no cuenta para su especie
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

// Cantares — «Expedición Cantares»: juego de registro de especies con fotos.
//
// GUARDA PRIMERO, IDENTIFICA DESPUÉS. La captura se escribe en cuanto existe la
// foto —sin clasificar, 0 puntos— y la identificación llega después y parchea la
// fila. Así el juego funciona igual con un identificador de 200 ms, con un
// contenedor frío de 3 minutos o sin ninguno, y en el bosque sin señal no se
// pierde nada. El identificador vive detrás del enrutador de idengine.js: el
// juego no sabe qué backend contesta.
//
// Todo vive además en el dispositivo (IndexedDB, fotos incluidas) y se exporta a
// CSV/JSON en Darwin Core para que la reserva mantenga el inventario vivo.
//
// Cada registro guarda: hora exacta, especie, coordenadas GPS + precisión,
// foto (comprimida), jugador y desglose de puntos.

import { saveRow, patchRow, deleteRow, compressImage } from './sync.js';
import { currentWalkId } from './recorder.js';
import { identify, idAvailableFor, verdictText } from './idengine.js';
// Misma identidad de foto que usa la ingesta masiva del admin y 26_sync_media.py.
import { sha256Hex } from './archive-intake.js';
// El geocerco vive en auth-ui.js (ya en el shell); aqui se consulta con el fix
// que la captura YA toma, sin pedir uno nuevo.
import { inReserve } from './auth-ui.js';

// ---------- configuración del juego ----------
const GAME_CFG = {
  // La identificación vive detrás del enrutador de idengine.js: el juego no
  // sabe (ni nombra) qué backend contesta, así que añadir aves no se nota aquí.
  photoMaxPx: 1280, photoQuality: 0.82,
  // Puntos base por grupo. La fauna vale más: es más difícil de fotografiar
  // y en Cantares toda la fauna está aún SIN confirmar en campo.
  // Anfibios: crípticos, nocturnos, indicadores de salud del ecosistema y
  // globalmente amenazados → alto valor. Toda la fauna de Cantares aún sin confirmar.
  basePoints: { flora: 10, ave: 25, mamifero: 40, anfibio: 45, otro: 15 },
  flagshipBonus: 10,     // especie bandera ★
  confirmMultiplier: 3,  // especie con status 'possible' → ¡primera confirmación!
  firstEverBonus: 15,    // primer registro histórico de esa especie en este dispositivo
  repeatPoints: 0,       // recapturar la MISMA especie no suma (pero se registra:
                         //   la foto puede servirle al archivo aunque no puntúe)
  unknownPoints: 5,      // «no sé qué es»: plano a propósito. Por grupo, «di ave
                         //   y llévate 25» sería la estrategia dominante.
  newFindingPoints: 50,  // hallazgo: especie que NO está en el inventario
  dailyMultiplier: 2,    // especie del día
  // Sin premios. Los puntos los escribe el cliente y `sightings_insert` no puede
  // comprobarlos, así que un premio físico convertía el ranking en algo que vale
  // la pena falsear. Sin premio, falsear te da un número en una lista.
};

// ---------- i18n (se fusiona con el I18N de app.js) ----------
export const GAME_I18N = {
  es: {
    g_title: 'Expedición Cantares',
    g_intro: 'Fotografía plantas y animales, gana puntos por rareza y ayuda a mantener vivo el inventario de la reserva. La fauna aún no confirmada en campo vale <strong>triple</strong>: tu foto es evidencia real.',
    g_create: '🎒 Crear explorador', g_your_name: 'Tu nombre', g_pick_avatar: 'Elige tu avatar',
    g_start: '¡Empezar!', g_points: 'puntos', g_rank: 'Puesto', g_species_n: 'especies',
    g_capture: '📸 Registrar avistamiento', g_ranking: '🏆 Ranking', g_badges: '🎖 Logros', g_records: '📒 Mis registros',
    g_daily: 'Especie del día', g_daily_x: 'puntos dobles hoy',
    g_recent: 'Últimas capturas',
    g_no_captures_yet: 'Aún no hay capturas. La primera foto abre tu cuaderno.',
    g_next_badge: 'Próximo logro', g_all_badges: '¡Todos los logros conseguidos!',
    g_step_photo: 'La foto', g_take_photo: '📷 Tomar foto', g_upload_photo: '🖼️ Subir foto',
    g_photo_hint: 'Al TOMAR la foto se guarda la hora y tu ubicación GPS. Al SUBIR una del carrete no se registra ubicación.',
    g_cam_need_account: 'Entra con tu cuenta para tomar fotos en la reserva. Sin cuenta puedes subir fotos del carrete.',
    g_locating: 'Obteniendo ubicación…', g_loc_ok: 'Ubicación registrada', g_loc_none: 'Sin ubicación (puedes guardar igual)',
    g_loc_upload: 'Foto subida — sin ubicación',
    g_step_id: '¿Qué es?',
    g_auto_fail: 'No se pudo identificar automáticamente. Elígela a mano.',
    g_auto_pick: 'Sugerencias — toca la correcta:', g_auto_outside: 'fuera del inventario',
    g_auto_only_plants: 'La identificación automática todavía sólo funciona con plantas.',
    g_identifying: 'Identificando…',
    g_unknown: '❓ No sé qué es',
    g_unknown_note: 'Se guarda sin clasificar. La reserva la identificará.',
    g_pending_id: 'sin identificar',
    g_dup_photo: 'Esa misma foto ya está registrada.',
    g_need_reserve: '🔒 Los registros se hacen dentro de la reserva.',
    g_locked_account: 'Crea tu cuenta en la reserva para jugar.',
    g_locked_outside: '🔒 Estás fuera de la reserva. Puedes ver tus registros, pero no añadir nuevos.',
    g_saved_pending: 'Foto guardada. Ahora dinos qué es.',
    g_new_record: '🔭 Posible especie nueva para la reserva',
    g_new_record_go: 'Registrar como hallazgo',
    g_not_in_inv: 'No está en el inventario de Cantares.',
    g_conflict: 'El identificador propone otra cosa. Elige tú — lo revisará la reserva.',
    g_engine_says: 'El identificador dice',
    g_you_said: 'Tú dijiste',
    g_corrected: 'corregido por la reserva',
    g_search_ph: 'Busca por nombre común o científico…',
    g_group_q: 'Tipo de ser vivo:', g_g_flora: '🌳 Planta', g_g_ave: '🐦 Ave', g_g_mamifero: '🐾 Mamífero', g_g_anfibio: '🐸 Anfibio', g_g_otro: '🦋 Otro',
    g_not_listed: '➕ No está en la lista — registrar hallazgo nuevo',
    g_finding_name: 'Nombre (si lo conoces) o descripción corta',
    g_step_confirm: 'Paso 3 · Confirmar', g_save: '💾 Guardar avistamiento', g_back: '← Atrás',
    g_confirm_bonus: '¡Primera confirmación en campo!', g_flagship_line: 'Especie bandera ★',
    g_base_line: 'Avistamiento', g_first_ever: 'Primer registro histórico en la app',
    g_repeat_line: 'Especie repetida (ya la habías registrado)', g_daily_line: 'Especie del día ×2',
    g_finding_line: '¡Posible especie nueva para el inventario!',
    g_finding_note: 'Quedará pendiente de revisión por la reserva.',
    g_saved: '¡Avistamiento guardado!', g_you_earned: 'ganaste',
    g_new_badge: '¡Nuevo logro!',
    g_leader_sub: 'Ranking histórico de visitantes en este dispositivo. Los primeros puestos reclaman premio en la entrada.',
    g_prize: 'Premio', g_you: 'tú', g_no_players: 'Aún no hay exploradores. ¡Sé el primero!',
    g_export_csv: '⬇ Exportar CSV', g_export_json: '⬇ Exportar JSON',
    g_export_note: 'Exporta los registros (hora, especie, GPS, puntos) para actualizar el inventario oficial o subirlos a iNaturalist.',
    g_records_empty: 'Todavía no tienes registros. ¡Sal al sendero y captura tu primera especie!',
    g_delete: 'Borrar', g_delete_sure: '¿Seguro?', g_captured: 'capturada',
    g_no_photo: 'Primero toma o elige una foto.',
    g_pending: 'pendiente de revisión',
    g_badges_sub: 'Logros de tu expedición.',
    b_primera: 'Primera captura', b_primera_d: 'Registra tu primer avistamiento',
    b_botanico: 'Botánico', b_botanico_d: '8 especies de flora distintas',
    b_ornitologo: 'Ornitólogo', b_ornitologo_d: '3 especies de aves',
    b_rastreador: 'Rastreador', b_rastreador_d: 'Fotografía un mamífero',
    b_confirmador: 'Confirmador', b_confirmador_d: 'Confirma una especie aún no registrada en campo',
    b_madrugador: 'Madrugador', b_madrugador_d: 'Un registro antes de las 7:00',
    b_nocturno: 'Nocturno', b_nocturno_d: 'Un registro después de las 19:00',
    b_coleccionista: 'Coleccionista', b_coleccionista_d: '15 especies distintas',
    b_descubridor: 'Descubridor', b_descubridor_d: 'Registra un hallazgo nuevo para el inventario',
    b_constante: 'Constante', b_constante_d: 'Registros en 3 días distintos',
  },
  en: {
    g_title: 'Cantares Expedition',
    g_intro: 'Photograph plants and animals, earn points for rarity, and help keep the reserve inventory alive. Fauna not yet field-confirmed is worth <strong>triple</strong>: your photo is real evidence.',
    g_create: '🎒 Create explorer', g_your_name: 'Your name', g_pick_avatar: 'Pick your avatar',
    g_start: 'Start!', g_points: 'points', g_rank: 'Rank', g_species_n: 'species',
    g_capture: '📸 Log a sighting', g_ranking: '🏆 Leaderboard', g_badges: '🎖 Badges', g_records: '📒 My records',
    g_daily: 'Species of the day', g_daily_x: 'double points today',
    g_recent: 'Latest captures',
    g_no_captures_yet: 'No captures yet. Your first photo opens the notebook.',
    g_next_badge: 'Next badge', g_all_badges: 'All badges earned!',
    g_step_photo: 'The photo', g_take_photo: '📷 Take photo', g_upload_photo: '🖼️ Upload photo',
    g_photo_hint: 'TAKING a photo stores the time and your GPS location. UPLOADING one from your gallery records no location.',
    g_cam_need_account: 'Sign in to take photos at the reserve. Without an account you can still upload photos.',
    g_locating: 'Getting location…', g_loc_ok: 'Location recorded', g_loc_none: 'No location (you can still save)',
    g_loc_upload: 'Uploaded photo — no location',
    g_step_id: 'What is it?',
    g_auto_fail: 'Automatic ID failed. Pick it by hand.',
    g_auto_pick: 'Suggestions — tap the right one:', g_auto_outside: 'not in inventory',
    g_auto_only_plants: 'Automatic identification only works for plants so far.',
    g_identifying: 'Identifying…',
    g_unknown: "❓ I don't know what it is",
    g_unknown_note: 'Saved unclassified. The reserve will identify it.',
    g_pending_id: 'unidentified',
    g_dup_photo: 'That same photo is already logged.',
    g_need_reserve: '🔒 Sightings are logged inside the reserve.',
    g_locked_account: 'Create your account at the reserve to play.',
    g_locked_outside: "🔒 You're outside the reserve. You can review your records, but not add new ones.",
    g_saved_pending: 'Photo saved. Now tell us what it is.',
    g_new_record: '🔭 Possibly a new species for the reserve',
    g_new_record_go: 'Log as a finding',
    g_not_in_inv: 'Not in the Cantares inventory.',
    g_conflict: 'The identifier suggests something else. You choose — the reserve will review it.',
    g_engine_says: 'The identifier says',
    g_you_said: 'You said',
    g_corrected: 'corrected by the reserve',
    g_search_ph: 'Search by common or scientific name…',
    g_group_q: 'Kind of living thing:', g_g_flora: '🌳 Plant', g_g_ave: '🐦 Bird', g_g_mamifero: '🐾 Mammal', g_g_anfibio: '🐸 Amphibian', g_g_otro: '🦋 Other',
    g_not_listed: '➕ Not on the list — log a new finding',
    g_finding_name: 'Name (if you know it) or short description',
    g_step_confirm: 'Step 3 · Confirm', g_save: '💾 Save sighting', g_back: '← Back',
    g_confirm_bonus: 'First field confirmation!', g_flagship_line: 'Flagship species ★',
    g_base_line: 'Sighting', g_first_ever: 'First historical record in the app',
    g_repeat_line: 'Repeated species (already logged by you)', g_daily_line: 'Species of the day ×2',
    g_finding_line: 'Possible new species for the inventory!',
    g_finding_note: 'It will await review by the reserve.',
    g_saved: 'Sighting saved!', g_you_earned: 'you earned',
    g_new_badge: 'New badge!',
    g_leader_sub: 'All-time visitor ranking on this device. Top ranks claim a prize at the entrance.',
    g_prize: 'Prize', g_you: 'you', g_no_players: 'No explorers yet. Be the first!',
    g_export_csv: '⬇ Export CSV', g_export_json: '⬇ Export JSON',
    g_export_note: 'Export the records (time, species, GPS, points) to update the official inventory or upload to iNaturalist.',
    g_records_empty: 'No records yet. Hit the trail and capture your first species!',
    g_delete: 'Delete', g_delete_sure: 'Sure?', g_captured: 'captured',
    g_no_photo: 'Take or choose a photo first.',
    g_pending: 'pending review',
    g_badges_sub: 'Badges from your expedition.',
    b_primera: 'First capture', b_primera_d: 'Log your first sighting',
    b_botanico: 'Botanist', b_botanico_d: '8 different plant species',
    b_ornitologo: 'Ornithologist', b_ornitologo_d: '3 bird species',
    b_rastreador: 'Tracker', b_rastreador_d: 'Photograph a mammal',
    b_confirmador: 'Confirmer', b_confirmador_d: 'Confirm a species not yet recorded in the field',
    b_madrugador: 'Early bird', b_madrugador_d: 'A record before 7:00',
    b_nocturno: 'Night owl', b_nocturno_d: 'A record after 19:00',
    b_coleccionista: 'Collector', b_coleccionista_d: '15 different species',
    b_descubridor: 'Discoverer', b_descubridor_d: 'Log a finding new to the inventory',
    b_constante: 'Steady', b_constante_d: 'Records on 3 different days',
  },
};

// ---------- estado del módulo ----------
let CTX = null;          // { state, t, L, toast, rerenderSpecies }
let T = (k) => k;        // atajo a t()
// El idioma actual. game.js no recibe LANG en su contexto; el <html lang> lo
// mantiene app.js (applyStaticI18n) y ya se usa así en los premios.
const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'es');
let allObs = [];         // todos los registros (todos los jugadores), sin blobs pesados en memoria aparte
let allPlayers = [];     // todos los jugadores históricos del dispositivo
let capMap = new Map();  // speciesId → nº capturas del jugador actual (para el grid)

const AVATARS = ['🦜', '🐸', '🦋', '🦉', '🐿️', '🌺', '🍄', '🦔'];

// ---------- IndexedDB ----------
const DB_NAME = 'cantares-game', DB_VER = 1;
let dbPromise = null;
function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('players')) db.createObjectStore('players', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('obs')) db.createObjectStore('obs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function dbPut(store, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbDelete(store, key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbAll(store) {
  const db = await idb();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// Los nombres de especie los edita el admin desde la nube: van escapados.
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- jugador ----------
function currentPlayer() {
  const id = localStorage.getItem('cantares_player');
  return allPlayers.find((p) => p.id === id) || null;
}
function playerObs(pid) { return allObs.filter((o) => o.playerId === pid); }
function playerPoints(pid) { return playerObs(pid).reduce((s, o) => s + (o.points || 0), 0); }
function distinctSpecies(pid) {
  return new Set(playerObs(pid).filter((o) => o.speciesId).map((o) => o.speciesId)).size;
}
function ranking() {
  return allPlayers
    .map((p) => ({ ...p, points: playerPoints(p.id), nSpecies: distinctSpecies(p.id) }))
    .sort((a, b) => b.points - a.points || b.nSpecies - a.nSpecies);
}
function rebuildCapMap() {
  capMap = new Map();
  const p = currentPlayer();
  if (!p) return;
  playerObs(p.id).forEach((o) => {
    if (o.speciesId) capMap.set(o.speciesId, (capMap.get(o.speciesId) || 0) + 1);
  });
}

// Insignia «capturada» para las tarjetas del grid de especies (app.js la llama).
export function capturedBadge(speciesId) {
  const n = capMap.get(speciesId);
  return n ? `<span class="cap-badge" title="${T('g_captured')}">📸${n > 1 ? '×' + n : ''}</span>` : '';
}

// ---------- API para el dashboard de cuenta ----------
export function accountSummary() {
  const p = currentPlayer();
  if (!p) return { points: 0, nSpecies: 0, nObs: 0 };
  return { points: playerPoints(p.id), nSpecies: distinctSpecies(p.id), nObs: playerObs(p.id).length };
}
export function capturedPhotos(limit = 24) {
  const p = currentPlayer();
  if (!p) return [];
  return playerObs(p.id).filter((o) => o.photo).slice(-limit).reverse()
    // photo puede ser un Blob (captura local) o una URL pública (rehidratada de la nube)
    .map((o) => ({ url: typeof o.photo === 'string' ? o.photo : URL.createObjectURL(o.photo), common: o.common || o.sci || '', group: o.group || '', time: o.time, lat: o.lat, lon: o.lon }));
}

// ---------- especie del día (determinista por fecha) ----------
// Rota entre TODOS los grupos, no sólo flora: con el clasificador cubriendo
// también aves, dejarlo en plantas desperdiciaba el 82% del inventario.
function speciesOfDay() {
  const list = CTX.state.species.filter((s) => s.scientific_name);
  if (!list.length) return null;
  // Fecha LOCAL (no UTC): en Colombia (UTC-5) la especie del día cambiaba a
  // las 7 pm; con la fecha local cambia a medianoche, como se espera.
  const now = new Date();
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let h = 0;
  for (const c of d) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

// ---------- puntuación ----------
function scoreCapture(species, { repeat, firstEver, isDaily }) {
  const lines = [];
  let pts = GAME_CFG.basePoints[species.group] || GAME_CFG.basePoints.otro;
  lines.push([`${T('g_base_line')} (${T('grp_' + species.group) || species.group})`, pts]);
  if (species.flagship) { lines.push([T('g_flagship_line'), GAME_CFG.flagshipBonus]); pts += GAME_CFG.flagshipBonus; }
  if (species.status === 'possible') {
    const bonus = pts * (GAME_CFG.confirmMultiplier - 1);
    lines.push([T('g_confirm_bonus') + ` ×${GAME_CFG.confirmMultiplier}`, bonus]);
    pts += bonus;
  }
  if (repeat) {
    // La misma especie otra vez no suma. Se sigue registrando —una segunda foto
    // mejor le sirve al archivo— pero no da puntos, así que fotografiar el mismo
    // yarumo veinte veces no escala el ranking.
    lines.length = 0;
    lines.push([T('g_repeat_line'), GAME_CFG.repeatPoints]);
    return { pts: GAME_CFG.repeatPoints, lines };
  }
  if (firstEver) {
    lines.push([T('g_first_ever'), GAME_CFG.firstEverBonus]);
    pts += GAME_CFG.firstEverBonus;
  }
  if (isDaily) { lines.push([T('g_daily_line'), pts]); pts *= GAME_CFG.dailyMultiplier; }
  return { pts, lines };
}

// ---------- logros ----------
const ACHIEVEMENTS = [
  { id: 'primera', emoji: '📸', test: (o) => o.length >= 1 },
  { id: 'botanico', emoji: '🌿', test: (o) => nDistinct(o, 'flora') >= 8 },
  { id: 'ornitologo', emoji: '🐦', test: (o) => nDistinct(o, 'ave') >= 3 },
  { id: 'rastreador', emoji: '🐾', test: (o) => o.some((x) => x.group === 'mamifero') },
  { id: 'confirmador', emoji: '✅', test: (o) => o.some((x) => x.confirmedPossible) },
  { id: 'madrugador', emoji: '🌅', test: (o) => o.some((x) => new Date(x.time).getHours() < 7) },
  { id: 'nocturno', emoji: '🌙', test: (o) => o.some((x) => new Date(x.time).getHours() >= 19) },
  { id: 'coleccionista', emoji: '🗂️', test: (o) => new Set(o.filter((x) => x.speciesId).map((x) => x.speciesId)).size >= 15 },
  { id: 'descubridor', emoji: '🔭', test: (o) => o.some((x) => x.kind === 'finding') },
  { id: 'constante', emoji: '📅', test: (o) => new Set(o.map((x) => (x.time || '').slice(0, 10))).size >= 3 },
];
function nDistinct(obs, group) {
  return new Set(obs.filter((x) => x.group === group && x.speciesId).map((x) => x.speciesId)).size;
}
function earnedBadges(pid) {
  const obs = playerObs(pid);
  return ACHIEVEMENTS.filter((a) => a.test(obs));
}

// La compresión vive en sync.js: `compressImage` usa createImageBitmap, que
// respeta la orientación EXIF. La versión que había aquí dibujaba un <img> en un
// canvas y la ignoraba, así que los retratos se guardaban tumbados.

// ---------- ubicación en el momento de la captura ----------
function snapLocation() {
  const fromState = () => {
    const p = CTX.state.userPos;
    return p ? { lat: p[1], lon: p[0], acc: null } : null;
  };
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(fromState());
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) }),
      () => resolve(fromState()),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  });
}


// ---------- modales ----------
// Los modales del juego entran en la pila del botón «atrás»: sin esto, atrás con
// el asistente de captura abierto saltaba de pestaña o cerraba la app entera —
// con la foto dentro. Es el gesto que más repiten los niños.
function closeModal() {
  document.querySelectorAll('.gm-overlay').forEach((n) => n.remove());
  if (CTX && CTX.popBack) CTX.popBack('gm');
}
function openModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'gm-overlay';
  ov.innerHTML = `<div class="gm-modal"><button class="gm-close" aria-label="Cerrar">×</button><div class="gm-body">${html}</div></div>`;
  ov.querySelector('.gm-close').onclick = closeModal;
  ov.onclick = (e) => { if (e.target === ov) closeModal(); };
  document.body.appendChild(ov);
  if (CTX && CTX.pushBack) CTX.pushBack('gm', closeModal);
  return ov.querySelector('.gm-body');
}

// El avatar sale del uid, no de un selector: el juego exige cuenta, así que la
// cuenta ES el perfil. Determinista, para que sea el mismo en todos los teléfonos.
function avatarFor(id) {
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

// ---------- captura: guarda primero, identifica después ----------
// El asistente de 3 pasos ya no existe. La foto se guarda en cuanto se toma —sin
// clasificar y con 0 puntos— y la identificación (automática o a mano) parchea
// esa fila después. Así una captura sobrevive a que el identificador esté lento,
// caído, sin cuota o sin señal, y nadie pierde la foto por cerrar la app.
let cap = null;

function captureHost() { return document.querySelector('#game-tab'); }

/** ¿Está esta foto ya registrada por este jugador? Misma identidad de contenido
 *  que usa la ingesta del admin: el mismo archivo con otro nombre no cuela. */
function isDuplicatePhoto(pid, hash) {
  return !!hash && playerObs(pid).some((o) => o.hash === hash);
}

function startCapture() {
  const player = currentPlayer();
  if (!player) return;
  cap = { obs: null, url: null, group: null, search: '', engine: null, busy: false, confirmed: false };
  CTX.pushBack('gmcap', closeCapture);
  renderCapture();
  // El input se pincha solo: quien tocó «Registrar» ya dijo que quiere la cámara.
  const inp = captureHost().querySelector('#gm-file-cam');
  if (inp) inp.click();
}
function closeCapture() {
  if (cap && cap.url) URL.revokeObjectURL(cap.url);
  cap = null;
  CTX.popBack('gmcap');
  renderGameTab();
}

/** Escribe la captura YA: IndexedDB primero (verdad local), luego la nube por la
 *  cola offline. Sin especie y sin puntos — eso llega después. */
async function saveCapture(blob, hash, loc) {
  const player = currentPlayer();
  const obs = {
    id: uid(), playerId: player.id, kind: 'capture',
    speciesId: null, sci: '', common: '', group: null,
    confirmedPossible: false,
    time: new Date().toISOString(),
    lat: loc ? loc.lat : null, lon: loc ? loc.lon : null, acc: loc ? loc.acc : null,
    points: 0, breakdown: [], photo: blob, hash,
    idPending: true,      // aún nadie ha dicho qué es
    engineSci: null,      // lo que propuso el motor, aparte de lo que dijo la persona
  };
  await dbPut('obs', obs);
  allObs.push(obs);
  if (obs.lat != null && obs.lon != null)
    window.dispatchEvent(new CustomEvent('cantares:capture', { detail: { lng: obs.lon, lat: obs.lat, name: '' } }));
  pushCloud(obs);
  return obs;
}

/** Sube (o encola) las dos filas de una observación. Idempotente por
 *  `client_id` / `id`, así que llamarla otra vez tras identificar no duplica:
 *  la cola reemplaza la operación pendiente de la misma clave. */
function pushCloud(obs) {
  if (!(CTX.cloud && CTX.cloud.enabled)) return;
  (async () => {
    try {
      await saveRow('sightings', {
        client_id: obs.id, species_id: obs.speciesId, common: obs.common, sci: obs.sci,
        group: obs.group, lat: obs.lat, lng: obs.lon,
        taken_at: new Date(obs.time).toISOString(), photo: null, points: obs.points,
      }, obs.photo instanceof Blob ? obs.photo : null);
    } catch (e) { console.warn('[cloud] sighting', e && e.message); }
    try {
      if (!(obs.photo instanceof Blob)) return;   // `media.url` es NOT NULL y la rellena el blob
      await saveRow('media', {
        id: 'gm-' + obs.id, kind: 'photo',
        // NINGUNA foto de visitante se publica sola, ni cuando eligió una especie
        // del inventario: quien toca una tarjeta no está confirmando una
        // identificación (los niños tocan lo que sea). Entra SIEMPRE sin
        // clasificar y el admin la publica con un toque desde la bandeja.
        subject_type: obs.speciesId ? 'species' : null,
        subject_id: obs.speciesId || null,
        status: 'unclassified',
        origin: 'game-capture', walk_id: currentWalkId(),
        lat: obs.lat, lng: obs.lon, taken_at: new Date(obs.time).toISOString(),
        content_hash: obs.hash || null,
        // `species_hint` es la conjetura del MOTOR y `subject_id` la elección de
        // la PERSONA. Antes las dos llevaban lo mismo (lo que dijo la persona),
        // así que una discrepancia era invisible en la bandeja y no había nada
        // que revisar. Separadas, el desacuerdo se ve solo.
        species_hint: obs.engineSci || null,
        caption: obs.common || obs.sci || null,
        is_primary: false, sort: 100, reviewed: false,
      }, { url: obs.photo });
    } catch (e) { console.warn('[cloud] media', e && e.message); }
  })();
}

/** Aplica una identificación sobre una observación ya guardada y la repuntúa. */
async function applyId(obs, { species, finding, unknown }) {
  const player = currentPlayer();
  const daily = speciesOfDay();
  if (species) {
    // «repeat» y «firstEver» se miden contra el resto, no contra sí misma.
    const others = playerObs(player.id).filter((o) => o.id !== obs.id);
    const repeat = others.some((o) => o.speciesId === species.id);
    const firstEver = !allObs.some((o) => o.id !== obs.id && o.speciesId === species.id);
    const scored = scoreCapture(species, { repeat, firstEver, isDaily: !!daily && daily.id === species.id });
    Object.assign(obs, {
      kind: 'capture', speciesId: species.id, sci: species.scientific_name || '',
      common: species.common_name || '', group: species.group || 'otro',
      confirmedPossible: species.status === 'possible',
      points: scored.pts, breakdown: scored.lines, idPending: false,
    });
  } else if (finding) {
    Object.assign(obs, {
      kind: 'finding', speciesId: null, sci: '', common: finding,
      group: (cap && cap.group) || 'otro',
      points: GAME_CFG.newFindingPoints,
      breakdown: [[T('g_finding_line'), GAME_CFG.newFindingPoints]], idPending: false,
    });
  } else if (unknown) {
    Object.assign(obs, {
      kind: 'capture', speciesId: null, sci: '', common: '',
      group: (cap && cap.group) || 'otro',
      points: GAME_CFG.unknownPoints,
      breakdown: [[T('g_unknown'), GAME_CFG.unknownPoints]], idPending: false,
    });
  }
  await dbPut('obs', obs);
  pushCloud(obs);
  rebuildCapMap(); CTX.rerenderSpecies(); refreshObsMapLayer();
}

/** Lanza el motor sobre una captura ya guardada. Nunca lanza: un fallo de
 *  identificación es normal, no excepcional. */
async function runEngine(obs, group) {
  cap.engine = { state: 'busy' };
  renderCapture();
  const r = await identify(obs.photo, group, CTX.state.species, lang());
  // Se enruta por VEREDICTO, no por un umbral de confianza propio. El filtro de
  // 0.70 que había aquí se tragaba los `outside-inventory`: el mejor momento del
  // juego —«puede que hayas encontrado algo nuevo»— no le salía nunca a nadie.
  const cands = (r.candidates || []).slice(0, 5);
  obs.engineSci = cands.length ? cands[0].sci : null;
  obs.idPending = (r.verdict === 'unavailable' || r.verdict === 'quota');
  await dbPut('obs', obs);
  if (!cap) return;
  cap.engine = { state: 'done', verdict: r.verdict, cands, text: verdictText(r, lang()) };
  renderCapture();
}

const GROUPS = () => [['flora', T('g_g_flora')], ['ave', T('g_g_ave')], ['mamifero', T('g_g_mamifero')],
  ['anfibio', T('g_g_anfibio')], ['otro', T('g_g_otro')]];

function renderCapture() {
  const host = captureHost();
  if (!host || !cap) return;
  const obs = cap.obs;
  if (!obs) {
    host.innerHTML = `
      <div class="gm-panel">
        <h2>${T('g_step_photo')}</h2>
        <div class="gm-photo-drop" id="gm-drop"><span>📷</span></div>
        <p class="tiny muted">${T('g_photo_hint')}</p>
        <input id="gm-file-cam" type="file" accept="image/*" capture="environment" hidden />
        <button id="gm-cancel" class="gm-linkbtn">${T('g_back')}</button>
      </div>`;
    const inp = host.querySelector('#gm-file-cam');
    host.querySelector('#gm-drop').onclick = () => inp.click();
    host.querySelector('#gm-cancel').onclick = closeCapture;
    inp.onchange = () => onPhoto(inp);
    return;
  }
  const eng = cap.engine;
  const top = eng && eng.cands && eng.cands[0];
  let engHTML = '';
  if (eng && eng.state === 'busy') engHTML = `<p class="tiny muted">⏳ ${T('g_identifying')}</p>`;
  else if (eng && eng.verdict === 'outside-inventory' && top) engHTML = `
        <div class="gm-newrec">
          <b>${T('g_new_record')}</b>
          <p class="gm-sp-title">${esc(top.sci)} <span class="gm-score">${Math.round((top.score || 0) * 100)}%</span></p>
          <p class="tiny muted">${T('g_not_in_inv')}</p>
          <button id="gm-newrec-go" class="gm-primary">${T('g_new_record_go')} → +${GAME_CFG.newFindingPoints}</button>
        </div>`;
  else if (eng && eng.verdict === 'ok') engHTML = `<p class="tiny">${T('g_auto_pick')}</p>`;
  else if (eng) engHTML = `<p class="tiny muted">⚠️ ${eng.text || T('g_auto_fail')}</p>`;

  host.innerHTML = `
    <div class="gm-panel">
      <h2>${T('g_step_id')}</h2>
      <div class="gm-mini"><img src="${cap.url}" alt=""></div>
      <p class="tiny muted">✓ ${T('g_saved_pending')}${locLine(obs)}</p>
      <p class="gm-label">${T('g_group_q')}</p>
      <div class="gm-groups">${GROUPS().map(([k, l]) =>
        `<button class="gm-chip${cap.group === k ? ' sel' : ''}" data-g="${k}">${l}</button>`).join('')}</div>
      <div id="gm-auto-out">${engHTML}</div>
      <input id="gm-search" class="gm-input" placeholder="${T('g_search_ph')}" value="${esc(cap.search)}" autocomplete="off" />
      <div id="gm-candidates" class="gm-candidates"></div>
      <button id="gm-unknown" class="gm-secondary">${T('g_unknown')}</button>
      <p class="tiny muted">${T('g_unknown_note')}</p>
      <button id="gm-finding" class="gm-linkbtn">${T('g_not_listed')}</button>
      <div id="gm-finding-box" class="hidden">
        <input id="gm-finding-name" class="gm-input" placeholder="${T('g_finding_name')}" />
        <button id="gm-finding-go" class="gm-primary">→</button>
      </div>
    </div>`;

  host.querySelectorAll('.gm-chip').forEach((b) => b.onclick = () => {
    const g = b.dataset.g;
    cap.group = cap.group === g ? null : g;
    cap.engine = null;
    renderCapture();
    // Tocar 🌳 identifica directamente: un toque en vez de dos. Sólo se dispara
    // con el grupo elegido, para no gastar cuota de plantas en fotos de aves.
    if (cap.group && idAvailableFor(cap.group)) runEngine(cap.obs, cap.group);
  });
  host.querySelector('#gm-search').oninput = (e) => { cap.search = e.target.value; renderCandidates(); };
  host.querySelector('#gm-unknown').onclick = () => finish({ unknown: true });
  host.querySelector('#gm-finding').onclick = () => host.querySelector('#gm-finding-box').classList.toggle('hidden');
  host.querySelector('#gm-finding-go').onclick = () => {
    const name = host.querySelector('#gm-finding-name').value.trim();
    if (name) finish({ finding: name });
  };
  const nr = host.querySelector('#gm-newrec-go');
  if (nr) nr.onclick = () => finish({ finding: `${top.common || ''} (${top.sci})`.trim() });
  renderCandidates();
}

function renderCandidates() {
  const host = captureHost();
  const el = host && host.querySelector('#gm-candidates');
  if (!el || !cap) return;
  const eng = cap.engine;
  const sug = (eng && eng.state === 'done' && eng.verdict === 'ok' ? eng.cands : []).filter((s) => s.speciesId);
  const q = cap.search.trim().toLowerCase();
  let list = CTX.state.species;
  if (cap.group && cap.group !== 'otro') list = list.filter((s) => s.group === cap.group);
  // `scientific_name` puede faltar (especies creadas a mano desde el admin). Sin
  // el `|| ''` esto lanzaba dentro del oninput y el buscador NO filtraba nada.
  if (q) list = list.filter((s) =>
    (CTX.L(s, 'common_name') || '').toLowerCase().includes(q) ||
    (s.common_name || '').toLowerCase().includes(q) ||
    (s.scientific_name || '').toLowerCase().includes(q));
  el.innerHTML = sug.map((s, i) => `
      <button class="gm-cand gm-sug" data-i="${i}"><b>${esc(s.common || s.sci)}</b> <i>${esc(s.sci)}</i>
        <span class="gm-score">${Math.round((s.score || 0) * 100)}%</span></button>`).join('')
    + list.slice(0, 30).map((s) => `
      <button class="gm-cand" data-id="${esc(s.id)}">
        <b>${esc(CTX.L(s, 'common_name') || s.scientific_name || '')}</b> <i>${esc(s.scientific_name || '')}</i>
        ${s.status === 'possible' ? `<span class="gm-tripla">×${GAME_CFG.confirmMultiplier}</span>` : ''}
        ${s.flagship ? '<span class="gm-star">★</span>' : ''}
      </button>`).join('');
  el.querySelectorAll('.gm-cand[data-id]').forEach((b) => b.onclick = () => {
    const s = CTX.state.species.find((x) => x.id === b.dataset.id);
    if (s) pickSpecies(s);
  });
  el.querySelectorAll('.gm-sug').forEach((b) => b.onclick = () => {
    const s = sug[+b.dataset.i];
    const hit = CTX.state.species.find((x) => x.id === s.speciesId);
    if (hit) finish({ species: hit });   // coincide con el motor: no hay conflicto
  });
}

/** La persona eligió a mano. Si el motor propuso otra cosa se muestra el
 *  desacuerdo y decide ella — pero la fila queda para que la reserva la revise
 *  (`species_hint` ≠ `subject_id` en la bandeja). El motor NUNCA sobrescribe a la
 *  persona: es de conjunto cerrado y fuera de él se equivoca con confianza. */
function pickSpecies(s) {
  const eng = cap.engine;
  const top = eng && eng.state === 'done' && eng.cands && eng.cands[0];
  const disagrees = top && top.speciesId && top.speciesId !== s.id;
  if (!disagrees || cap.confirmed) return finish({ species: s });
  const host = captureHost();
  const box = host.querySelector('#gm-auto-out');
  box.innerHTML = `
    <div class="gm-conflict">
      <p class="tiny">${T('g_conflict')}</p>
      <button class="gm-cand" id="gm-c-mine"><b>${T('g_you_said')}:</b> ${esc(CTX.L(s, 'common_name') || s.scientific_name || '')}</button>
      <button class="gm-cand" id="gm-c-eng"><b>${T('g_engine_says')}:</b> ${esc(top.common || top.sci)}
        <span class="gm-score">${Math.round((top.score || 0) * 100)}%</span></button>
    </div>`;
  box.scrollIntoView({ block: 'nearest' });
  host.querySelector('#gm-c-mine').onclick = () => { cap.confirmed = true; finish({ species: s }); };
  host.querySelector('#gm-c-eng').onclick = () => {
    const hit = CTX.state.species.find((x) => x.id === top.speciesId);
    cap.confirmed = true;
    finish({ species: hit || s });
  };
}

async function finish(what) {
  if (!cap || cap.busy) return;
  cap.busy = true;
  const player = currentPlayer();
  const before = new Set(earnedBadges(player.id).map((a) => a.id));
  const obs = cap.obs;
  await applyId(obs, what);
  const after = earnedBadges(player.id).filter((a) => !before.has(a.id));
  const host = captureHost();
  host.innerHTML = `
    <div class="gm-panel gm-success">
      <div class="gm-burst">🎉</div>
      <h2>${T('g_saved')}</h2>
      <p class="gm-earned">${player.emoji} ${esc(player.name)}, ${T('g_you_earned')} <b>+${obs.points}</b> ${T('g_points')}</p>
      ${after.map((a) => `<p class="gm-badge-new">🎖 ${T('g_new_badge')} ${a.emoji} <b>${T('b_' + a.id)}</b></p>`).join('')}
      <button id="gm-again" class="gm-secondary">${T('g_capture')}</button>
      <button id="gm-done" class="gm-primary">OK</button>
    </div>`;
  host.querySelector('#gm-done').onclick = closeCapture;
  host.querySelector('#gm-again').onclick = () => { closeCapture(); startCapture(); };
}

/** Llega la foto: comprimir → huella → ¿duplicada? → ubicación → ¿dentro? → GUARDAR. */
async function onPhoto(input) {
  const f = input.files && input.files[0];
  if (!f || !cap) return;
  const player = currentPlayer();
  const host = captureHost();
  const drop = host.querySelector('#gm-drop');
  if (drop) drop.innerHTML = '<span>⏳</span>';
  let blob;
  try { blob = await compressImage(f); } catch (e) { blob = f; }
  let hash = null;
  try { hash = await sha256Hex(blob); } catch (e) { /* sin huella se guarda igual */ }
  if (isDuplicatePhoto(player.id, hash)) { CTX.toast(T('g_dup_photo')); closeCapture(); return; }
  const loc = await snapLocation();
  // Gate duro en la ESCRITURA, sobre el fix que la captura ya toma de todos
  // modos. Sin fix se guarda igual: un GPS que no responde bajo el dosel no
  // puede impedir registrar. Con fix y fuera del polígono, no se guarda.
  if (loc && !(await inReserve([loc.lon, loc.lat], loc.acc || 0))) {
    CTX.toast(T('g_need_reserve'));
    renderCapture();
    return;
  }
  cap.obs = await saveCapture(blob, hash, loc);
  cap.url = URL.createObjectURL(blob);
  renderCapture();
}

function locLine(obs) {
  if (!obs || obs.lat == null) return ' · ⚠️ ' + T('g_loc_none');
  return ` · 📍 ${T('g_loc_ok')}${obs.acc ? ` (±${obs.acc} m)` : ''}`;
}

// Reintento de identificación al volver la señal. Una vez: si sigue fallando, la
// captura se queda sin clasificar y la recoge la bandeja del admin, que existe
// justo para eso. Se cuelga de los mismos disparadores que ya usa la cola offline.
async function retryPendingIds() {
  if (!CTX || !navigator.onLine) return;
  const player = currentPlayer();
  if (!player) return;
  for (const o of playerObs(player.id)) {
    if (!o.idPending || !o.group || !(o.photo instanceof Blob)) continue;
    if (!idAvailableFor(o.group)) continue;
    const r = await identify(o.photo, o.group, CTX.state.species, lang());
    if (r.verdict === 'unavailable' || r.verdict === 'quota') return;   // sigue sin poder: no insistir
    const top = (r.candidates || [])[0];
    o.engineSci = top ? top.sci : null;
    o.idPending = false;
    await dbPut('obs', o);
    pushCloud(o);
  }
}

// ---------- ranking ----------
function openLeaderboard() {
  const rows = ranking();
  const me = currentPlayer();
  openModal(`
    <h2>🏆 ${T('g_ranking')}</h2>
    <p class="tiny muted">${T('g_leader_sub')}</p>
    ${rows.length ? `<div class="gm-lb">
      ${rows.map((p, i) => `
        <div class="gm-lb-row${me && p.id === me.id ? ' me' : ''}">
          <span class="gm-lb-rank">${['🥇', '🥈', '🥉'][i] || '#' + (i + 1)}</span>
          <span class="gm-lb-name">${p.emoji} ${p.name}${me && p.id === me.id ? ` <i>(${T('g_you')})</i>` : ''}</span>
          <span class="gm-lb-pts"><b>${p.points}</b> ${T('g_points')} · ${p.nSpecies} ${T('g_species_n')}</span>
        </div>`).join('')}
    </div>` : `<p class="muted">${T('g_no_players')}</p>`}
    <p class="tiny muted" style="margin-top:12px">${T('g_export_note')}</p>
    <div class="gm-row">
      <button id="gm-csv" class="gm-secondary">${T('g_export_csv')}</button>
      <button id="gm-json" class="gm-secondary">${T('g_export_json')}</button>
    </div>`);
  document.querySelector('#gm-csv').onclick = exportCSV;
  document.querySelector('#gm-json').onclick = exportJSON;
}

// ---------- logros ----------
function openBadges() {
  const player = currentPlayer();
  const got = player ? new Set(earnedBadges(player.id).map((a) => a.id)) : new Set();
  openModal(`
    <h2>🎖 ${T('g_badges')}</h2>
    <p class="tiny muted">${T('g_badges_sub')}</p>
    <div class="gm-badges">
      ${ACHIEVEMENTS.map((a) => `
        <div class="gm-badge${got.has(a.id) ? ' got' : ''}">
          <span class="gm-badge-emoji">${a.emoji}</span>
          <b>${T('b_' + a.id)}</b>
          <small>${T('b_' + a.id + '_d')}</small>
        </div>`).join('')}
    </div>`);
}

// ---------- mis registros ----------
function openRecords() {
  const player = currentPlayer();
  const obs = player ? playerObs(player.id).slice().sort((a, b) => b.time.localeCompare(a.time)) : [];
  const body = openModal(`
    <h2>📒 ${T('g_records')}</h2>
    ${obs.length ? `<div class="gm-recs">
      ${obs.map((o) => `
        <div class="gm-rec" data-id="${o.id}">
          <img class="gm-rec-img" data-photo="${o.id}" alt="">
          <div class="gm-rec-info">
            <b>${o.common || o.sci || '—'}</b>
            ${o.sci ? `<i>${o.sci}</i>` : ''}
            <small>🕑 ${new Date(o.time).toLocaleString()}</small>
            ${o.lat != null ? `<small>📍 ${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}${o.acc ? ` (±${o.acc} m)` : ''}</small>` : ''}
            <small>+${o.points} ${T('g_points')}${o.kind === 'finding' ? ' · ' + T('g_pending') : ''}${!o.speciesId && o.kind !== 'finding' ? ' · ' + T('g_pending_id') : ''}</small>
          </div>
          <button class="gm-rec-del" data-id="${o.id}">🗑</button>
        </div>`).join('')}
    </div>` : `<p class="muted">${T('g_records_empty')}</p>`}`);
  // Miniaturas desde los blobs guardados
  obs.forEach((o) => {
    const img = body.querySelector(`[data-photo="${o.id}"]`);
    if (img && o.photo instanceof Blob) img.src = URL.createObjectURL(o.photo);
  });
  // Borrar con confirmación en dos toques (sin diálogos nativos)
  body.querySelectorAll('.gm-rec-del').forEach((b) => b.onclick = async () => {
    if (b.dataset.armed) {
      const id = b.dataset.id;
      await dbDelete('obs', id);
      // ...y en la nube. Antes solo se borraba lo local, asi que la fila de
      // `sightings`, la de `media` y su objeto en Storage quedaban huerfanos.
      // La cola encola por `tabla:id`, asi que borrar algo que aun estaba
      // pendiente de subir colapsa las dos operaciones en una sola.
      if (CTX.cloud && CTX.cloud.enabled) {
        try { await deleteRow('sightings', id); } catch (e) { console.warn('[cloud] del sighting', e && e.message); }
        try { await deleteRow('media', 'gm-' + id); } catch (e) { console.warn('[cloud] del media', e && e.message); }
      }
      allObs = allObs.filter((o) => o.id !== id);
      rebuildCapMap(); renderGameTab(); CTX.rerenderSpecies(); refreshObsMapLayer();
      openRecords();
    } else { b.dataset.armed = '1'; b.textContent = T('g_delete_sure'); }
  });
}

// ---------- exportación (mantiene vivo el inventario) ----------
// Formato Darwin Core: se puede publicar en SiB Colombia → GBIF sin retrabajo.
// Las coordenadas de especies sensibles (orquídeas, endémicas, o marcadas
// "sensitive":true en species.json) se RETIENEN para no exponer su ubicación.
const SENSITIVE_FAMILIES = new Set(['Orchidaceae']);
function speciesRec(id) { return (CTX.state.species || []).find((s) => s.id === id) || null; }
function isSensitive(id) {
  const s = speciesRec(id);
  return !!s && (s.sensitive === true || SENSITIVE_FAMILIES.has(s.family));
}
function obsRowsForExport() {
  const byId = Object.fromEntries(allPlayers.map((p) => [p.id, p]));
  return allObs.map((o) => {
    const s = o.speciesId ? speciesRec(o.speciesId) : null;
    const withhold = o.speciesId && isSensitive(o.speciesId) && o.lat != null;
    const hasCoord = o.lat != null && !withhold;
    return {
      occurrenceID: `cantares:${o.id}`,
      basisOfRecord: 'HumanObservation',
      eventDate: o.time || '',
      scientificName: o.sci || '',
      vernacularName: o.common || '',
      taxonRank: s ? (String(s.scientific_name || '').trim().includes(' ') ? 'species' : 'genus') : '',
      family: (s && s.family) || '',
      kingdom: o.group === 'flora' ? 'Plantae' : (o.group ? 'Animalia' : ''),
      individualCount: 1,
      recordedBy: (byId[o.playerId] || {}).name || o.playerId,
      occurrenceStatus: 'present',
      country: 'Colombia', countryCode: 'CO', stateProvince: 'Caldas',
      locality: 'Reserva Natural Cantares',
      decimalLatitude: hasCoord ? o.lat : '',
      decimalLongitude: hasCoord ? o.lon : '',
      geodeticDatum: hasCoord ? 'EPSG:4326' : '',
      coordinateUncertaintyInMeters: hasCoord && o.acc != null ? o.acc : '',
      identificationVerificationStatus: 'unverified',
      identificationRemarks: o.kind === 'finding'
        ? 'Candidate new record for the reserve; needs review'
        : 'Matched to reserve inventory; not expert-verified',
      informationWithheld: withhold ? 'Coordinates withheld: sensitive species' : '',
      dynamicProperties: JSON.stringify({ gamePoints: o.points, confirmedPossible: !!o.confirmedPossible, group: o.group || '' }),
    };
  });
}
function download(name, mime, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportCSV() {
  const rows = obsRowsForExport();
  if (!rows.length) { CTX.toast(T('g_records_empty')); return; }
  const cols = Object.keys(rows[0]);
  const esc = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  download(`cantares_avistamientos_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', csv);
}
function exportJSON() {
  const rows = obsRowsForExport();
  if (!rows.length) { CTX.toast(T('g_records_empty')); return; }
  download(`cantares_avistamientos_${new Date().toISOString().slice(0, 10)}.json`, 'application/json',
    JSON.stringify({
      reserve: 'Reserva Natural Cantares', exported: new Date().toISOString(),
      standard: 'Darwin Core (Occurrence)', datasetName: 'Expedición Cantares — avistamientos de visitantes',
      note: 'Coordenadas de especies sensibles retenidas (informationWithheld). Apto para SiB Colombia → GBIF.',
      occurrences: rows,
    }, null, 2));
}

// ---------- capa de observaciones en el mapa ----------
function obsGeoJSON() {
  return { type: 'FeatureCollection', features: allObs.filter((o) => o.lat != null).map((o) => ({
    type: 'Feature', properties: { name: o.common || o.sci || '?', time: o.time, group: o.group || 'otro' },
    geometry: { type: 'Point', coordinates: [o.lon, o.lat] },
  })) };
}
export function gameAddMapLayer() {
  const map = CTX && CTX.state.map;
  if (!map || map.getSource('game-obs')) return;
  map.addSource('game-obs', { type: 'geojson', data: obsGeoJSON() });
  map.addLayer({ id: 'game-obs', type: 'circle', source: 'game-obs',
    paint: { 'circle-radius': 5.5,
      'circle-color': ['match', ['get', 'group'], 'flora', '#40916c', 'ave', '#e07a1f', 'mamifero', '#8d6e63', '#c2255c'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.on('click', 'game-obs', (e) => {
    const p = e.features[0].properties;
    CTX.toast(`📸 ${p.name} · ${new Date(p.time).toLocaleString()}`);
  });
}
function refreshObsMapLayer() {
  const map = CTX && CTX.state.map;
  const src = map && map.getSource && map.getSource('game-obs');
  if (src) src.setData(obsGeoJSON());
}

// ---------- panel en la vista Especies ----------
// ---------- la pestaña ----------
// Tres estados. Sin cuenta: bloqueada, pero VISIBLE — esconderla no explicaría
// que el servicio existe. Fuera de la reserva: se ven los registros pero no se
// añaden. Dentro (o sin fix): completa.
//
// El geocerco NO se sondea al entrar: pedir un fix de alta precisión cuesta ~12 s
// de radio bajo el dosel, y la captura ya toma uno. Aquí se usa la última
// posición conocida, que es gratis, y el gate duro vive en el guardado.
let outsideKnown = false;
async function refreshOutside() {
  const p = CTX.state.userPos;
  outsideKnown = p ? !(await inReserve([p[0], p[1]], 0)) : false;
}

function renderGameTab() {
  const el = document.querySelector('#game-tab');
  if (!el) return;
  const daily = speciesOfDay();
  // La especie del día es una sugerencia, no la acción principal: va DEBAJO del
  // botón y en tarjeta clara, para no disputarle la jerarquía.
  const dailyHtml = daily ? `
    <div class="gmx-daily">
      <span class="gmx-k">${T('g_daily')}</span>
      <b class="gmx-daily-name">${esc(CTX.L(daily, 'common_name') || '')}</b>
      <i class="gmx-daily-sci">${esc(daily.scientific_name || '')}</i>
      <span class="gmx-daily-x">×2 · ${T('g_daily_x')}</span>
    </div>` : '';

  if (!CTX.hasAccount || !CTX.hasAccount()) {
    el.innerHTML = `
      <section class="gmx">
        <div class="gmx-hero">
          <h1 class="gmx-title">${T('g_title')}</h1>
          <p class="gmx-lead">${T('g_intro')}</p>
        </div>
        <div class="gmx-dock">
          <button class="gmx-cta gmx-cta-locked" id="gm-capture">🔒 ${T('g_capture')}</button>
          <p class="gmx-lock">${T('g_locked_account')}</p>
        </div>
        ${dailyHtml}
      </section>`;
    el.querySelector('#gm-capture').onclick = () => CTX.toast(T('g_locked_account'));
    return;
  }
  const player = currentPlayer();
  if (!player) {
    el.innerHTML = `<section class="gmx"><div class="gmx-hero"><h1 class="gmx-title">${T('g_title')}</h1></div></section>`;
    return;
  }

  const thumbs = capturedPhotos(8);
  const nRecs = playerObs(player.id).length;
  const nBadges = earnedBadges(player.id).length;
  const rank = ranking().findIndex((p) => p.id === player.id) + 1;

  el.innerHTML = `
    <section class="gmx">
      <div class="gmx-hero">
        <p class="gmx-id"><span class="gmx-avatar" aria-hidden="true">${player.emoji}</span>${esc(player.name)}</p>
        <h1 class="gmx-title">${T('g_title')}</h1>
        <div id="gm-stats"></div>
      </div>

      <div class="gmx-dock">
        <button id="gm-capture" class="gmx-cta${outsideKnown ? ' gmx-cta-locked' : ''}">${outsideKnown ? '🔒 ' : ''}${T('g_capture')}</button>
        ${outsideKnown ? `<p class="gmx-lock">${T('g_locked_outside')}</p>` : ''}
      </div>

      ${dailyHtml}

      <h2 class="gmx-h">${T('g_recent')}</h2>
      ${thumbs.length
        ? `<div class="gmx-strip" id="gm-strip" role="list">${thumbs.map((t) =>
            `<img role="listitem" src="${t.url}" alt="${esc(t.common)}" loading="lazy">`).join('')}</div>`
        : `<p class="gmx-empty">${T('g_no_captures_yet')}</p>`}

      <div class="gmx-nav">
        <button id="gm-lb" class="gmx-nav-btn"><b>${rank ? '#' + rank : '—'}</b><span>${T('g_ranking')}</span></button>
        <button id="gm-bd" class="gmx-nav-btn"><b>${nBadges}/${ACHIEVEMENTS.length}</b><span>${T('g_badges')}</span></button>
        <button id="gm-rc" class="gmx-nav-btn"><b>${nRecs}</b><span>${T('g_records')}</span></button>
      </div>
    </section>`;
  el.querySelector('#gm-capture').onclick = () => {
    if (outsideKnown) { CTX.toast(T('g_need_reserve')); return; }
    startCapture();
  };
  el.querySelector('#gm-lb').onclick = openLeaderboard;
  el.querySelector('#gm-bd').onclick = openBadges;
  el.querySelector('#gm-rc').onclick = openRecords;
  // La tira es un atajo de dedo; el camino accesible por teclado es el botón
  // «Mis registros» de la fila de abajo, que abre exactamente lo mismo.
  const strip = el.querySelector('#gm-strip');
  if (strip) strip.onclick = openRecords;
  renderGameTabStats();
}

// Las cifras se pintan aparte para poder refrescarlas sin rehacer la pestaña.
// Tres números grandes (lo que el visitante quiere saber de un vistazo bajo el
// sol) y una barra hacia el próximo logro, que convierte «tienes 4 logros» en
// «te falta esto y así se consigue».
function renderGameTabStats() {
  const el = document.querySelector('#gm-stats');
  const player = currentPlayer();
  if (!el || !player) return;
  const rows = ranking();
  const rank = rows.findIndex((p) => p.id === player.id) + 1;
  const got = earnedBadges(player.id);
  const gotIds = new Set(got.map((a) => a.id));
  const next = ACHIEVEMENTS.find((a) => !gotIds.has(a.id));
  const pct = Math.round((got.length / ACHIEVEMENTS.length) * 100);
  el.innerHTML = `
    <div class="gmx-rail">
      <div class="gmx-stat"><b>${playerPoints(player.id).toLocaleString()}</b><span>${T('g_points')}</span></div>
      <div class="gmx-stat"><b>${rank ? '#' + rank : '—'}</b><span>${T('g_rank')}</span></div>
      <div class="gmx-stat"><b>${distinctSpecies(player.id)}</b><span>${T('g_species_n')}</span></div>
    </div>
    <div class="gmx-next">
      <div class="gmx-next-head">
        <span class="gmx-k">${next ? T('g_next_badge') : T('g_all_badges')}</span>
        <span class="gmx-next-n">${got.length}/${ACHIEVEMENTS.length}</span>
      </div>
      <div class="gmx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"
           aria-valuenow="${pct}" aria-label="${T('g_badges')}"><i style="width:${pct}%"></i></div>
      ${next ? `<p class="gmx-next-d"><span aria-hidden="true">${next.emoji}</span> <b>${T('b_' + next.id)}</b> — ${T('b_' + next.id + '_d')}</p>` : ''}
    </div>`;
}

// Re-render tras cambio de idioma (app.js lo llama desde setLang) y al entrar en
// la pestaña (switchView). Refresca de paso si seguimos dentro del polígono.
export function refreshGameUI() {
  if (!CTX) return;
  renderGameTab();
  refreshOutside().then(() => { if (!cap) renderGameTab(); });
}

// ---------- init ----------
export async function initGame(ctx) {
  CTX = ctx; T = ctx.t;
  try {
    [allPlayers, allObs] = await Promise.all([dbAll('players'), dbAll('obs')]);
  } catch (e) {
    console.warn('game idb', e);
    allPlayers = []; allObs = [];
  }
  // Cuenta en la nube: liga el jugador a la cuenta y rehidrata los avistamientos
  // del servidor, para que al volver (aunque sea en otro dispositivo) no empiece de cero.
  if (ctx.cloud && ctx.cloud.enabled && ctx.cloud.user) {
    try {
      const u = ctx.cloud.user;
      if (!allPlayers.find((p) => p.id === u.id)) {
        const pl = { id: u.id, name: u.username || 'Visitante', emoji: avatarFor(u.id), created: Date.now() };
        await dbPut('players', pl); allPlayers.push(pl);
      }
      localStorage.setItem('cantares_player', u.id);
      const cloudObs = await ctx.cloud.mySightings();
      const have = new Set(allObs.map((o) => o.id));
      for (const cs of cloudObs) {
        const oid = 'cloud_' + cs.id;
        // client_id = id local original: si esta captura nació en ESTE teléfono
        // (o ya se bajó antes), no duplicarla.
        // Si la captura nacio aqui y la reserva le corrigio la especie al
        // revisarla, se adopta la correccion y se REPUNTUA: los puntos se dieron
        // al vuelo con lo que dijo el visitante, y esta es la unica pasada donde
        // se puede saber que cambiaron de opinion.
        if (cs.client_id && have.has(cs.client_id)) {
          const mine = allObs.find((x) => x.id === cs.client_id);
          if (mine && (cs.species_id || null) !== (mine.speciesId || null)) {
            const sp = cs.species_id && (ctx.state.species || []).find((x) => x.id === cs.species_id);
            if (sp) {
              const sc = scoreCapture(sp, { repeat: false, firstEver: false, isDaily: false });
              Object.assign(mine, { speciesId: sp.id, sci: sp.scientific_name || '', common: sp.common_name || '',
                group: sp.group || 'otro', points: sc.pts, breakdown: sc.lines, corrected: true, idPending: false });
              await dbPut('obs', mine);
            }
          }
          continue;
        }
        if (have.has(oid)) continue;
        const o = { id: oid, playerId: u.id, kind: cs.species_id ? 'capture' : 'finding', speciesId: cs.species_id || null,
          sci: cs.sci || '', common: cs.common || '', group: cs.group || 'otro',
          // time SIEMPRE como string ISO (el resto del código ordena con
          // localeCompare y recorta con slice(0,10) — un número rompe ambos);
          // photo: conservar la URL pública de la nube para la galería.
          time: cs.taken_at ? new Date(cs.taken_at).toISOString() : new Date().toISOString(), lat: cs.lat, lon: cs.lng,
          points: cs.points || 0, photo: cs.photo || null, breakdown: [] };
        await dbPut('obs', o); allObs.push(o);
      }
    } catch (e) { console.warn('[cloud] rehidratar', e && e.message); }
  }
  // Sin cuenta no hay jugador. `cantares_player` sobrevivia al cierre de sesion,
  // asi que en el telefono compartido de la porteria el siguiente visitante
  // abria el juego con las capturas y los puntos del anterior.
  if (!(ctx.cloud && ctx.cloud.enabled && ctx.cloud.user)) localStorage.removeItem('cantares_player');

  rebuildCapMap();
  await refreshOutside();
  renderGameTab();
  ctx.rerenderSpecies();

  // Identificaciones pendientes: los mismos disparadores que ya usa la cola
  // offline, en vez de un temporizador propio.
  const retry = () => retryPendingIds().catch((e) => console.warn('[id] retry', e && e.message));
  window.addEventListener('online', () => setTimeout(retry, 2500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(retry, 3000); });
  setTimeout(retry, 5000);
}

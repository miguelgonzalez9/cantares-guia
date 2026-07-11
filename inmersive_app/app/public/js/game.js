// Cantares — «Expedición Cantares»: juego de registro de especies con fotos.
//
// Sin backend: todo vive en el dispositivo (IndexedDB, fotos incluidas) y se
// exporta a CSV/JSON para que la reserva mantenga el inventario vivo. La
// identificación automática de flora usa la API de Pl@ntNet (clave opcional,
// abajo); siempre hay un identificador manual asistido que funciona offline.
//
// Cada registro guarda: hora exacta, especie, coordenadas GPS + precisión,
// foto (comprimida), jugador y desglose de puntos.

// ---------- configuración del juego ----------
const GAME_CFG = {
  // Clave de Pl@ntNet (gratis en https://my.plantnet.org, 500 peticiones/día).
  // Vacía → el botón de identificación automática no aparece y se usa el
  // identificador manual asistido.
  plantnetApiKey: '',
  photoMaxPx: 1280, photoQuality: 0.82,
  // Puntos base por grupo. La fauna vale más: es más difícil de fotografiar
  // y en Cantares toda la fauna está aún SIN confirmar en campo.
  // Anfibios: crípticos, nocturnos, indicadores de salud del ecosistema y
  // globalmente amenazados → alto valor. Toda la fauna de Cantares aún sin confirmar.
  basePoints: { flora: 10, ave: 25, mamifero: 40, anfibio: 45, otro: 15 },
  flagshipBonus: 10,     // especie bandera ★
  confirmMultiplier: 3,  // especie con status 'possible' → ¡primera confirmación!
  firstEverBonus: 15,    // primer registro histórico de esa especie en este dispositivo
  repeatFactor: 0.2,     // recapturas de la misma especie por el mismo jugador
  newFindingPoints: 50,  // hallazgo: especie que NO está en el inventario
  dailyMultiplier: 2,    // especie del día
  // Premios por puesto en el ranking histórico — edítalos según lo que ofrezca
  // la reserva (se muestran tal cual en el ranking).
  prizes: [
    { rank: 1, emoji: '🥇', es: 'Bebida caliente de cortesía en la próxima visita', en: 'Free hot drink on your next visit' },
    { rank: 2, emoji: '🥈', es: 'Postal ilustrada de la reserva', en: 'Illustrated postcard of the reserve' },
    { rank: 3, emoji: '🥉', es: 'Sticker de la Reserva Cantares', en: 'Cantares Reserve sticker' },
  ],
};

// ---------- i18n (se fusiona con el I18N de app.js) ----------
export const GAME_I18N = {
  es: {
    g_title: 'Expedición Cantares',
    g_intro: 'Fotografía plantas y animales, gana puntos por rareza y ayuda a mantener vivo el inventario de la reserva. La fauna aún no confirmada en campo vale <strong>triple</strong>: tu foto es evidencia real.',
    g_create: '🎒 Crear explorador', g_your_name: 'Tu nombre', g_pick_avatar: 'Elige tu avatar',
    g_start: '¡Empezar!', g_points: 'puntos', g_rank: 'Puesto', g_species_n: 'especies',
    g_capture: '📸 Registrar avistamiento', g_ranking: '🏆 Ranking', g_badges: '🎖 Logros', g_records: '📒 Mis registros',
    g_daily: 'Especie del día', g_daily_x: 'puntos ×2 hoy',
    g_step_photo: 'Paso 1 · La foto', g_take_photo: '📷 Tomar o elegir foto',
    g_photo_hint: 'La app guarda la hora y tu ubicación GPS junto con la foto.',
    g_locating: 'Obteniendo ubicación…', g_loc_ok: 'Ubicación registrada', g_loc_none: 'Sin ubicación (puedes guardar igual)',
    g_step_id: 'Paso 2 · ¿Qué es?', g_auto_id: '🔮 Identificar automáticamente (Pl@ntNet)',
    g_auto_wait: 'Consultando Pl@ntNet…', g_auto_fail: 'No se pudo identificar automáticamente. Usa el buscador.',
    g_auto_pick: 'Sugerencias — toca la correcta:',
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
    g_daily: 'Species of the day', g_daily_x: 'points ×2 today',
    g_step_photo: 'Step 1 · The photo', g_take_photo: '📷 Take or choose photo',
    g_photo_hint: 'The app stores the time and your GPS location with the photo.',
    g_locating: 'Getting location…', g_loc_ok: 'Location recorded', g_loc_none: 'No location (you can still save)',
    g_step_id: 'Step 2 · What is it?', g_auto_id: '🔮 Identify automatically (Pl@ntNet)',
    g_auto_wait: 'Asking Pl@ntNet…', g_auto_fail: 'Automatic ID failed. Use the search box.',
    g_auto_pick: 'Suggestions — tap the right one:',
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

// ---------- especie del día (determinista por fecha) — sólo plantas ----------
function speciesOfDay() {
  const list = CTX.state.species.filter((s) => s.group === 'flora');
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
    const cut = -Math.round(pts * (1 - GAME_CFG.repeatFactor));
    lines.push([T('g_repeat_line'), cut]);
    pts = Math.max(1, pts + cut);
  } else if (firstEver) {
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

// ---------- foto: comprimir a JPEG ----------
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, GAME_CFG.photoMaxPx / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob')), 'image/jpeg', GAME_CFG.photoQuality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
    img.src = url;
  });
}

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

// ---------- Pl@ntNet (identificación automática de flora) ----------
async function plantnetIdentify(blob) {
  const fd = new FormData();
  fd.append('images', blob, 'photo.jpg');
  fd.append('organs', 'auto');
  const url = `https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(GAME_CFG.plantnetApiKey)}&lang=${document.documentElement.lang || 'es'}`;
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) throw new Error('plantnet ' + res.status);
  const json = await res.json();
  return (json.results || []).slice(0, 5).map((r) => ({
    sci: r.species?.scientificNameWithoutAuthor || '',
    common: (r.species?.commonNames || [])[0] || '',
    score: Math.round((r.score || 0) * 100),
  }));
}
// Empareja un nombre científico con el inventario (exacto → mismo género).
function matchInventory(sci) {
  const list = CTX.state.species;
  const s = (sci || '').trim().toLowerCase();
  if (!s) return null;
  let hit = list.find((x) => x.scientific_name.toLowerCase() === s);
  if (hit) return hit;
  const genus = s.split(' ')[0];
  return list.find((x) => x.scientific_name.toLowerCase().split(' ')[0] === genus) || null;
}

// ---------- modales ----------
function closeModal() { document.querySelectorAll('.gm-overlay').forEach((n) => n.remove()); }
function openModal(html) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'gm-overlay';
  ov.innerHTML = `<div class="gm-modal"><button class="gm-close" aria-label="Cerrar">×</button><div class="gm-body">${html}</div></div>`;
  ov.querySelector('.gm-close').onclick = closeModal;
  ov.onclick = (e) => { if (e.target === ov) closeModal(); };
  document.body.appendChild(ov);
  return ov.querySelector('.gm-body');
}

// ---------- alta de jugador ----------
function openProfileModal(after) {
  const body = openModal(`
    <h2>🎒 ${T('g_title')}</h2>
    <p class="gm-lead">${T('g_intro')}</p>
    <label class="gm-label">${T('g_your_name')}</label>
    <input id="gm-name" class="gm-input" maxlength="24" autocomplete="off" />
    <label class="gm-label">${T('g_pick_avatar')}</label>
    <div class="gm-avatars">${AVATARS.map((a, i) => `<button class="gm-avatar${i === 0 ? ' sel' : ''}" data-a="${a}">${a}</button>`).join('')}</div>
    <button id="gm-go" class="gm-primary">${T('g_start')}</button>`);
  let avatar = AVATARS[0];
  body.querySelectorAll('.gm-avatar').forEach((b) => b.onclick = () => {
    body.querySelectorAll('.gm-avatar').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel'); avatar = b.dataset.a;
  });
  body.querySelector('#gm-go').onclick = async () => {
    const name = body.querySelector('#gm-name').value.trim();
    if (!name) { body.querySelector('#gm-name').focus(); return; }
    const player = { id: uid(), name, emoji: avatar, created: new Date().toISOString() };
    await dbPut('players', player);
    allPlayers.push(player);
    localStorage.setItem('cantares_player', player.id);
    rebuildCapMap(); renderGamePanel(); CTX.rerenderSpecies();
    closeModal();
    if (after) after();
  };
}

// ---------- asistente de captura (3 pasos) ----------
let wiz = null;
function openCaptureWizard() {
  const player = currentPlayer();
  if (!player) { openProfileModal(() => openCaptureWizard()); return; }
  wiz = { photoBlob: null, photoUrl: null, loc: undefined, time: null, group: null,
    species: null, isFinding: false, findingName: '', search: '' };
  renderWizardPhoto(openModal(''));
}

function renderWizardPhoto(body) {
  body.innerHTML = `
    <h2>${T('g_step_photo')}</h2>
    <label class="gm-photo-drop${wiz.photoUrl ? ' has' : ''}" id="gm-drop">
      ${wiz.photoUrl ? `<img src="${wiz.photoUrl}" alt="">` : `<span>${T('g_take_photo')}</span>`}
      <input id="gm-file" type="file" accept="image/*" capture="environment" hidden />
    </label>
    <p class="tiny muted">${T('g_photo_hint')}</p>
    <p class="tiny" id="gm-loc">${wiz.loc === undefined ? '' : wiz.loc ? '📍 ' + T('g_loc_ok') + (wiz.loc.acc ? ` (±${wiz.loc.acc} m)` : '') : '⚠️ ' + T('g_loc_none')}</p>
    <button id="gm-next" class="gm-primary" ${wiz.photoBlob ? '' : 'disabled'}>→</button>`;
  const drop = body.querySelector('#gm-drop'), file = body.querySelector('#gm-file');
  drop.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    wiz.time = new Date().toISOString();
    body.querySelector('#gm-loc').textContent = '⏳ ' + T('g_locating');
    try { wiz.photoBlob = await compressPhoto(f); } catch (e) { wiz.photoBlob = f; }
    if (wiz.photoUrl) URL.revokeObjectURL(wiz.photoUrl);
    wiz.photoUrl = URL.createObjectURL(wiz.photoBlob);
    wiz.loc = await snapLocation();
    renderWizardPhoto(body);
  };
  body.querySelector('#gm-next').onclick = () => {
    if (!wiz.photoBlob) { CTX.toast(T('g_no_photo')); return; }
    renderWizardId(body);
  };
}

function renderWizardId(body) {
  const groups = [['flora', T('g_g_flora')], ['ave', T('g_g_ave')], ['mamifero', T('g_g_mamifero')], ['anfibio', T('g_g_anfibio')], ['otro', T('g_g_otro')]];
  const canAuto = !!GAME_CFG.plantnetApiKey && navigator.onLine;
  body.innerHTML = `
    <h2>${T('g_step_id')}</h2>
    <div class="gm-mini"><img src="${wiz.photoUrl}" alt=""></div>
    ${canAuto ? `<button id="gm-auto" class="gm-secondary">${T('g_auto_id')}</button><div id="gm-auto-out"></div>` : ''}
    <p class="gm-label">${T('g_group_q')}</p>
    <div class="gm-groups">${groups.map(([k, l]) => `<button class="gm-chip${wiz.group === k ? ' sel' : ''}" data-g="${k}">${l}</button>`).join('')}</div>
    <input id="gm-search" class="gm-input" placeholder="${T('g_search_ph')}" value="${wiz.search}" autocomplete="off" />
    <div id="gm-candidates" class="gm-candidates"></div>
    <button id="gm-finding" class="gm-linkbtn">${T('g_not_listed')}</button>
    <div id="gm-finding-box" class="hidden">
      <input id="gm-finding-name" class="gm-input" placeholder="${T('g_finding_name')}" value="${wiz.findingName}" />
      <button id="gm-finding-go" class="gm-primary">→</button>
    </div>
    <button id="gm-backb" class="gm-linkbtn">${T('g_back')}</button>`;

  const renderCandidates = () => {
    const q = wiz.search.trim().toLowerCase();
    let list = CTX.state.species;
    if (wiz.group && wiz.group !== 'otro') list = list.filter((s) => s.group === wiz.group);
    if (q) list = list.filter((s) =>
      (CTX.L(s, 'common_name') || '').toLowerCase().includes(q) ||
      (s.common_name || '').toLowerCase().includes(q) ||
      s.scientific_name.toLowerCase().includes(q));
    const el = body.querySelector('#gm-candidates');
    el.innerHTML = list.slice(0, 30).map((s) => `
      <button class="gm-cand" data-id="${s.id}">
        <b>${CTX.L(s, 'common_name')}</b> <i>${s.scientific_name}</i>
        ${s.status === 'possible' ? `<span class="gm-tripla">×${GAME_CFG.confirmMultiplier}</span>` : ''}
        ${s.flagship ? '<span class="gm-star">★</span>' : ''}
      </button>`).join('');
    el.querySelectorAll('.gm-cand').forEach((b) => b.onclick = () => {
      wiz.species = CTX.state.species.find((s) => s.id === b.dataset.id);
      wiz.isFinding = false;
      renderWizardConfirm(body);
    });
  };
  body.querySelectorAll('.gm-chip').forEach((b) => b.onclick = () => {
    wiz.group = wiz.group === b.dataset.g ? null : b.dataset.g;
    body.querySelectorAll('.gm-chip').forEach((x) => x.classList.toggle('sel', x.dataset.g === wiz.group));
    renderCandidates();
  });
  body.querySelector('#gm-search').oninput = (e) => { wiz.search = e.target.value; renderCandidates(); };
  body.querySelector('#gm-finding').onclick = () => body.querySelector('#gm-finding-box').classList.toggle('hidden');
  body.querySelector('#gm-finding-go').onclick = () => {
    wiz.isFinding = true; wiz.species = null;
    wiz.findingName = body.querySelector('#gm-finding-name').value.trim();
    renderWizardConfirm(body);
  };
  body.querySelector('#gm-backb').onclick = () => renderWizardPhoto(body);

  if (canAuto) {
    body.querySelector('#gm-auto').onclick = async () => {
      const out = body.querySelector('#gm-auto-out');
      out.innerHTML = `<p class="tiny muted">⏳ ${T('g_auto_wait')}</p>`;
      try {
        const sug = await plantnetIdentify(wiz.photoBlob);
        if (!sug.length) throw new Error('empty');
        out.innerHTML = `<p class="tiny">${T('g_auto_pick')}</p>` + sug.map((s, i) => `
          <button class="gm-cand gm-sug" data-i="${i}"><b>${s.common || s.sci}</b> <i>${s.sci}</i> <span class="gm-score">${s.score}%</span></button>`).join('');
        out.querySelectorAll('.gm-sug').forEach((b) => b.onclick = () => {
          const s = sug[+b.dataset.i];
          const hit = matchInventory(s.sci);
          if (hit) { wiz.species = hit; wiz.isFinding = false; }
          else { wiz.isFinding = true; wiz.species = null; wiz.findingName = `${s.common || ''} (${s.sci})`.trim(); }
          renderWizardConfirm(body);
        });
      } catch (e) {
        out.innerHTML = `<p class="tiny muted">⚠️ ${T('g_auto_fail')}</p>`;
      }
    };
  }
  renderCandidates();
}

function renderWizardConfirm(body) {
  const player = currentPlayer();
  const daily = speciesOfDay();
  let scored, title, sub;
  if (wiz.isFinding) {
    scored = { pts: GAME_CFG.newFindingPoints, lines: [[T('g_finding_line'), GAME_CFG.newFindingPoints]] };
    title = wiz.findingName || T('g_not_listed').replace('➕ ', '');
    sub = T('g_finding_note');
  } else {
    const s = wiz.species;
    const repeat = playerObs(player.id).some((o) => o.speciesId === s.id);
    const firstEver = !allObs.some((o) => o.speciesId === s.id);
    scored = scoreCapture(s, { repeat, firstEver, isDaily: daily && daily.id === s.id });
    title = `${CTX.L(s, 'common_name')} · ${s.scientific_name}`;
    sub = '';
  }
  const when = new Date(wiz.time);
  body.innerHTML = `
    <h2>${T('g_step_confirm')}</h2>
    <div class="gm-mini"><img src="${wiz.photoUrl}" alt=""></div>
    <p class="gm-sp-title">${title}</p>
    ${sub ? `<p class="tiny muted">${sub}</p>` : ''}
    <p class="tiny muted">🕑 ${when.toLocaleString()} ${wiz.loc ? `· 📍 ${wiz.loc.lat.toFixed(5)}, ${wiz.loc.lon.toFixed(5)}${wiz.loc.acc ? ` (±${wiz.loc.acc} m)` : ''}` : ''}</p>
    <div class="gm-breakdown">
      ${scored.lines.map(([l, p]) => `<div class="gm-bd-row"><span>${l}</span><b>${p > 0 ? '+' : ''}${p}</b></div>`).join('')}
      <div class="gm-bd-row gm-bd-total"><span>Total</span><b>${scored.pts}</b></div>
    </div>
    <button id="gm-save" class="gm-primary">${T('g_save')}</button>
    <button id="gm-backb" class="gm-linkbtn">${T('g_back')}</button>`;
  body.querySelector('#gm-backb').onclick = () => renderWizardId(body);
  body.querySelector('#gm-save').onclick = async () => {
    const before = new Set(earnedBadges(player.id).map((a) => a.id));
    const obs = {
      id: uid(), playerId: player.id,
      kind: wiz.isFinding ? 'finding' : 'capture',
      speciesId: wiz.isFinding ? null : wiz.species.id,
      sci: wiz.isFinding ? '' : wiz.species.scientific_name,
      common: wiz.isFinding ? (wiz.findingName || '') : wiz.species.common_name,
      group: wiz.isFinding ? (wiz.group || 'otro') : wiz.species.group,
      confirmedPossible: !wiz.isFinding && wiz.species.status === 'possible',
      time: wiz.time,
      lat: wiz.loc ? wiz.loc.lat : null, lon: wiz.loc ? wiz.loc.lon : null,
      acc: wiz.loc ? wiz.loc.acc : null,
      points: scored.pts, breakdown: scored.lines,
      photo: wiz.photoBlob,
    };
    await dbPut('obs', obs);
    allObs.push(obs);
    // Avisar al grabador de recorridos (si hay uno activo) dónde se tomó la foto.
    if (obs.lat != null && obs.lon != null)
      window.dispatchEvent(new CustomEvent('cantares:capture', { detail: { lng: obs.lon, lat: obs.lat, name: obs.common || obs.sci || '' } }));
    // Empuje al inventario global (Supabase) — best-effort, no bloquea el juego.
    if (CTX.cloud && CTX.cloud.enabled) (async () => {
      try {
        let photoUrl = null;
        if (obs.photo && CTX.cloud.uploadImage) { try { photoUrl = await CTX.cloud.uploadImage(obs.photo, 'sightings'); } catch (e) { /* sin foto */ } }
        await CTX.cloud.addSighting({ species_id: obs.speciesId, common: obs.common, sci: obs.sci, group: obs.group,
          lat: obs.lat, lng: obs.lon, taken_at: new Date(obs.time).toISOString(), photo: photoUrl, points: obs.points });
      } catch (e) { console.warn('[cloud] sighting', e && e.message); }
    })();
    rebuildCapMap(); renderGamePanel(); CTX.rerenderSpecies(); refreshObsMapLayer();
    const after = earnedBadges(player.id).filter((a) => !before.has(a.id));
    body.innerHTML = `
      <div class="gm-success">
        <div class="gm-burst">🎉</div>
        <h2>${T('g_saved')}</h2>
        <p class="gm-earned">${player.emoji} ${player.name}, ${T('g_you_earned')} <b>+${scored.pts}</b> ${T('g_points')}</p>
        ${after.map((a) => `<p class="gm-badge-new">🎖 ${T('g_new_badge')} ${a.emoji} <b>${T('b_' + a.id)}</b></p>`).join('')}
        <button id="gm-again" class="gm-secondary">${T('g_capture')}</button>
        <button id="gm-done" class="gm-primary">OK</button>
      </div>`;
    body.querySelector('#gm-done').onclick = closeModal;
    body.querySelector('#gm-again').onclick = () => { closeModal(); openCaptureWizard(); };
  };
}

// ---------- ranking ----------
function openLeaderboard() {
  const rows = ranking();
  const me = currentPlayer();
  const prizeFor = (i) => {
    const pz = GAME_CFG.prizes.find((p) => p.rank === i + 1);
    return pz ? `<span class="gm-prize">${pz.emoji} ${pz[document.documentElement.lang === 'en' ? 'en' : 'es']}</span>` : '';
  };
  openModal(`
    <h2>🏆 ${T('g_ranking')}</h2>
    <p class="tiny muted">${T('g_leader_sub')}</p>
    ${rows.length ? `<div class="gm-lb">
      ${rows.map((p, i) => `
        <div class="gm-lb-row${me && p.id === me.id ? ' me' : ''}">
          <span class="gm-lb-rank">${['🥇', '🥈', '🥉'][i] || '#' + (i + 1)}</span>
          <span class="gm-lb-name">${p.emoji} ${p.name}${me && p.id === me.id ? ` <i>(${T('g_you')})</i>` : ''}</span>
          <span class="gm-lb-pts"><b>${p.points}</b> ${T('g_points')} · ${p.nSpecies} ${T('g_species_n')}</span>
          ${prizeFor(i)}
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
            <small>+${o.points} ${T('g_points')}${o.kind === 'finding' ? ' · ' + T('g_pending') : ''}</small>
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
      await dbDelete('obs', b.dataset.id);
      allObs = allObs.filter((o) => o.id !== b.dataset.id);
      rebuildCapMap(); renderGamePanel(); CTX.rerenderSpecies(); refreshObsMapLayer();
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
function renderGamePanel() {
  const el = document.querySelector('#game-panel');
  if (!el) return;
  const player = currentPlayer();
  const daily = speciesOfDay();
  const dailyHtml = daily ? `
    <div class="gm-daily">🌟 <b>${T('g_daily')}:</b> ${CTX.L(daily, 'common_name')}
      <i>${daily.scientific_name}</i> — ${T('g_daily_x')}</div>` : '';
  if (!player) {
    el.innerHTML = `
      <div class="gm-panel">
        <h2>🎒 ${T('g_title')}</h2>
        <p class="gm-lead">${T('g_intro')}</p>
        ${dailyHtml}
        <button id="gm-create" class="gm-primary">${T('g_create')}</button>
      </div>`;
    el.querySelector('#gm-create').onclick = () => openProfileModal();
    return;
  }
  const rows = ranking();
  const rank = rows.findIndex((p) => p.id === player.id) + 1;
  el.innerHTML = `
    <div class="gm-panel">
      <div class="gm-head">
        <span class="gm-player">${player.emoji} <b>${player.name}</b></span>
        <span class="gm-stats"><b>${playerPoints(player.id)}</b> ${T('g_points')} · ${T('g_rank')} #${rank} · ${distinctSpecies(player.id)} ${T('g_species_n')}</span>
      </div>
      ${dailyHtml}
      <button id="gm-capture" class="gm-primary gm-big">${T('g_capture')}</button>
      <div class="gm-row">
        <button id="gm-lb" class="gm-secondary">${T('g_ranking')}</button>
        <button id="gm-bd" class="gm-secondary">${T('g_badges')}</button>
        <button id="gm-rc" class="gm-secondary">${T('g_records')}</button>
      </div>
    </div>`;
  el.querySelector('#gm-capture').onclick = openCaptureWizard;
  el.querySelector('#gm-lb').onclick = openLeaderboard;
  el.querySelector('#gm-bd').onclick = openBadges;
  el.querySelector('#gm-rc').onclick = openRecords;
}

// Re-render tras cambio de idioma (app.js lo llama desde setLang).
export function refreshGameUI() {
  if (!CTX) return;
  renderGamePanel();
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
      if (!allPlayers.find((p) => p.id === u.id)) { const pl = { id: u.id, name: u.username || 'Visitante', created: Date.now() }; await dbPut('players', pl); allPlayers.push(pl); }
      localStorage.setItem('cantares_player', u.id);
      const cloudObs = await ctx.cloud.mySightings();
      const have = new Set(allObs.map((o) => o.id));
      for (const cs of cloudObs) {
        const oid = 'cloud_' + cs.id;
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
  rebuildCapMap();
  renderGamePanel();
  ctx.rerenderSpecies();
}

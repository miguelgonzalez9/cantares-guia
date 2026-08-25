// Cantares — grabador de recorridos del visitante. Trackea la ruta exacta por
// GPS (inicio/stop), calcula distancia y tiempo, guarda un historial local
// (IndexedDB), marca dónde se tomaron las fotos del treasure hunt y exporta una
// imagen descargable (PNG) del recorrido dibujada sobre el contorno de la reserva.

import { keepAwake, releaseAwake } from './wakelock.js';
import { isLoggedIn, listMyWalks } from './cloud.js';
import { saveRow, deleteRow } from './sync.js';

let CTX = null;
let rec = null;     // grabación en curso
let dbP = null;

// ---------- caminatas ↔ nube (siguen al usuario entre dispositivos) ----------
// Muestrear la traza a ≤400 puntos para subirla liviana (la forma se conserva).
function samplePoints(pts, max = 400) {
  if (pts.length <= max) return pts;
  const step = pts.length / max, out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[Math.floor(i)]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}
function walkToCloudRow(w) {
  return { id: w.id, route_id: w.routeId || null, route_name: w.routeName || null,
    started_at: new Date(w.startedAt).toISOString(), ended_at: new Date(w.endedAt).toISOString(),
    duration_ms: w.durationMs, distance_m: w.distanceM,
    points: samplePoints(w.points), photos: w.photos || [] };
}
function cloudRowToWalk(r) {
  return { id: r.id, startedAt: Date.parse(r.started_at), endedAt: Date.parse(r.ended_at),
    durationMs: Number(r.duration_ms) || 0, distanceM: r.distance_m || 0,
    points: r.points || [], photos: r.photos || [], routeId: r.route_id, routeName: r.route_name };
}
// Con sesión: bajar las caminatas de la nube que este teléfono no tenga.
async function rehydrateWalks() {
  if (!isLoggedIn()) return;
  try {
    const local = new Set((await walksAll()).map((w) => w.id));
    for (const r of await listMyWalks()) {
      if (!local.has(r.id)) await walkPut(cloudRowToWalk(r));
    }
  } catch (e) { console.warn('[cloud] walks', e && e.message); }
}

// ---------- strings ----------
const RS = {
  es: { start: '⏺ Grabar recorrido', stop: '⏹ Terminar', history: '📖', hist_h: 'Mis recorridos',
    waiting: 'Buscando señal GPS…', started: 'Grabando tu recorrido…', saved: 'Recorrido guardado',
    dist: 'Distancia', time: 'Tiempo', photos: 'fotos', download: '⬇️ Descargar imagen',
    empty: 'Aún no has grabado recorridos. Dale a «Grabar recorrido» y camina.',
    del: 'Eliminar', del_q: '¿Eliminar este recorrido?', close: 'Cerrar', title: 'Recorrido en Cantares',
    denied: 'Activa el permiso de ubicación para grabar.', none: 'No se pudo obtener la ubicación.',
    keep_q: '¿Guardar este recorrido?', keep_yes: '💾 Guardar', keep_no: '🗑 Descartar',
    keep_sub: 'Si lo descartas no queda nada guardado.', discarded: 'Recorrido descartado' },
  en: { start: '⏺ Record walk', stop: '⏹ Finish', history: '📖', hist_h: 'My walks',
    waiting: 'Waiting for GPS…', started: 'Recording your walk…', saved: 'Walk saved',
    dist: 'Distance', time: 'Time', photos: 'photos', download: '⬇️ Download image',
    empty: 'No walks recorded yet. Tap “Record walk” and go.',
    del: 'Delete', del_q: 'Delete this walk?', close: 'Close', title: 'Walk in Cantares',
    denied: 'Enable the location permission to record.', none: "Couldn't get your location.",
    keep_q: 'Save this walk?', keep_yes: '💾 Save', keep_no: '🗑 Discard',
    keep_sub: 'Discard it and nothing is kept.', discarded: 'Walk discarded' },
};
const RT = (k) => { const l = document.documentElement.lang || 'es'; return (RS[l] && RS[l][k]) || RS.es[k] || k; };

// ---------- utils ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 2) + ' km' : Math.round(m) + ' m';
function fmtDur(ms) {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

// ---------- IndexedDB (historial) ----------
function idb() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    const r = indexedDB.open('cantares-walks', 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('walks')) db.createObjectStore('walks', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbP;
}
async function walksAll() { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction('walks').objectStore('walks').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); }
async function walkPut(w) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('walks', 'readwrite'); tx.objectStore('walks').put(w); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function walkDel(id) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('walks', 'readwrite'); tx.objectStore('walks').delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }

// ---------- init ----------
export function initRecorder(ctx) {
  CTX = ctx;
  buildBar();
  rehydrateWalks();   // caminatas hechas en otro dispositivo (con sesión)
  // Se graba desde el STREAM DE GPS COMPARTIDO (app.js lo emite): así no hay un
  // segundo watchPosition y la grabación funciona igual en recorrido libre o guiado.
  window.addEventListener('cantares:position', onSharedPos);
  // Cuando el juego registra una foto durante la grabación, marca su ubicación.
  window.addEventListener('cantares:capture', (e) => {
    if (!rec || !e.detail) return;
    const { lng, lat, name } = e.detail;
    if (lng != null && lat != null) rec.photos.push({ lng, lat, name: name || '' });
  });
}

function bar() { return document.getElementById('rec-bar'); }
function buildBar() {
  let el = bar();
  if (!el) {
    el = document.createElement('div'); el.id = 'rec-bar'; el.className = 'rec-bar';
    (document.getElementById('view-recorridos') || document.body).appendChild(el);
  }
  renderIdle();
}
// Idle: la barra no muestra nada (menos desorden). El inicio/parada del recorrido
// libre vive en el chip "Recorrido libre" del route-bar; el historial, en Cuenta.
function renderIdle() { const el = bar(); el.className = 'rec-bar hidden'; el.innerHTML = ''; }
function renderRecording() {
  const el = bar();
  el.className = 'rec-bar recording';
  el.innerHTML = `<span class="rec-live"><span class="rec-dot"></span>
      <b id="rec-time">0:00</b> · <b id="rec-dist">0 m</b></span>
    <button class="rec-stop" id="rec-stop">${RT('stop')}</button>`;
  el.querySelector('#rec-stop').onclick = stopWalk;
}

// ---------- grabación (API pública) ----------
export function isRecording() { return !!rec; }
// Id de la caminata en curso, para colgar de ella las fotos que se tomen dentro
// de la app (media.walk_id). null si no se está grabando.
export function currentWalkId() { return rec ? rec.id : null; }
export function startWalk(routeId = null, routeName = null) {
  if (rec) return;
  if (!navigator.geolocation) { CTX.toast(RT('none')); return; }
  rec = { id: uid(), points: [], photos: [], startedAt: Date.now(), dist: 0, last: null, routeId, routeName };
  renderRecording();
  CTX.toast(RT('waiting'));
  keepAwake();                 // el navegador corta el GPS si la pantalla se apaga
  CTX.ensureGps && CTX.ensureGps();   // enciende el GPS compartido (sin segundo watch)
  rec.timer = setInterval(tick, 1000);
  tick();
  window.dispatchEvent(new Event('cantares:recstate'));
}
function onSharedPos(e) {
  if (!rec || !e.detail) return;
  const { lng, lat, accuracy } = e.detail;
  if (lng == null || lat == null) return;
  const pt = [lng, lat, Date.now()];
  if (rec.last) {
    const d = haversine(rec.last, pt);
    if (d > 1.5 && (accuracy == null || accuracy < 40)) { rec.dist += d; rec.points.push(pt); rec.last = pt; }
  } else { rec.points.push(pt); rec.last = pt; CTX.toast(RT('started')); }
}
function tick() {
  if (!rec) return;
  const td = document.getElementById('rec-time'), dd = document.getElementById('rec-dist');
  if (td) td.textContent = fmtDur(Date.now() - rec.startedAt);
  if (dd) dd.textContent = fmtDist(rec.dist);
}
// ¿La grabación tiene movimiento de verdad? Con el GPS quieto en un bolsillo se
// cuelan puntos por deriva: dos lecturas y 4 m no son un recorrido. Por debajo de
// esto no se pregunta nada — no había nada que guardar.
const MIN_WALK_M = 25;
function walkIsReal(walk) {
  return (walk.points || []).length >= 2 && (walk.distanceM || 0) >= MIN_WALK_M;
}
export async function stopWalk() {
  if (!rec) return;
  releaseAwake();
  clearInterval(rec.timer);
  const walk = { id: rec.id, startedAt: rec.startedAt, endedAt: Date.now(),
    durationMs: Date.now() - rec.startedAt, distanceM: Math.round(rec.dist),
    points: rec.points, photos: rec.photos, routeId: rec.routeId, routeName: rec.routeName };
  rec = null;
  renderIdle();
  window.dispatchEvent(new Event('cantares:recstate'));
  // Nada se guarda todavía: se pregunta. Antes toda parada quedaba en el historial
  // (y en la nube), así que abrir la app y tocar «grabar» sin querer dejaba basura
  // que después había que borrar a mano, una por una.
  if (walkIsReal(walk)) askKeepWalk(walk);
  else CTX.toast(RT('none'));
}
// Guarda de verdad: local primero (es lo del usuario) y luego la nube, que puede
// esperar en la cola sin señal.
async function keepWalk(walk) {
  await walkPut(walk);
  CTX.toast(RT('saved'));
  showSummary(walk);
  if (isLoggedIn()) {
    try { await saveRow('walks', walkToCloudRow(walk)); }
    catch (e) { console.warn('[cloud] walk', e && e.message); }   // queda local igual
  }
}
async function askKeepWalk(walk) {
  const el = overlay();
  const card = await summaryCardHTML(walk, false);
  el.innerHTML = `<div class="rec-sheet">
    <h2>${RT('keep_q')}</h2>
    ${card}
    <p class="rec-empty">${RT('keep_sub')}</p>
    <div class="rec-hactions">
      <button class="rec-dl" id="rec-keep">${RT('keep_yes')}</button>
      <button class="rec-del" id="rec-drop">${RT('keep_no')}</button>
    </div>
  </div>`;
  el.classList.remove('hidden');
  el.querySelector('#rec-keep').onclick = () => keepWalk(walk);
  el.querySelector('#rec-drop').onclick = () => { closeOverlay(); CTX.toast(RT('discarded')); };
}

// ---------- imagen descargable (PNG) ----------
// La traza se dibuja SOBRE la imagen de satélite de la reserva y su límite. La
// imagen es la misma que usa el mapa (Esri Wayback), a baja resolución a
// propósito: esto es una estampa para compartir, no una carta náutica. Si no hay
// señal, si el tile no llega o si el navegador ensucia el canvas, se cae al
// fondo liso de siempre — la traza es lo que importa y nunca se pierde.

// Web Mercator: la MISMA proyección que los tiles, o la traza quedaría corrida
// respecto a la foto (a esta latitud poco, pero corrida).
const lon2px = (lon, z) => (lon + 180) / 360 * 256 * Math.pow(2, z);
const lat2px = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * Math.pow(2, z);
};

function loadImg(src, { cors = false, ms = 4000 } = {}) {
  return new Promise((resolve) => {
    const im = new Image();
    if (cors) im.crossOrigin = 'anonymous';
    const done = (v) => { clearTimeout(tm); resolve(v); };
    const tm = setTimeout(() => done(null), ms);
    im.onload = () => done(im);
    im.onerror = () => done(null);
    im.src = src;
  });
}

// Zoom más alto en el que el recuadro cabe en unos pocos tiles: más que eso son
// muchas descargas para una estampa que se ve a 720 px.
function pickZoom(minX, minY, maxX, maxY, maxTiles = 3) {
  for (let z = 18; z >= 12; z--) {
    const w = (lon2px(maxX, z) - lon2px(minX, z)) / 256;
    const h = (lat2px(minY, z) - lat2px(maxY, z)) / 256;
    if (w <= maxTiles && h <= maxTiles) return z;
  }
  return 12;
}

async function paintBasemap(g, box, area, z) {
  const tpl = CTX.tileUrl && CTX.tileUrl();
  if (!tpl) return false;
  const x0 = lon2px(box.minX, z), x1 = lon2px(box.maxX, z);
  const y0 = lat2px(box.maxY, z), y1 = lat2px(box.minY, z);
  const k = Math.min(area.w / (x1 - x0), area.h / (y1 - y0));
  const t0x = Math.floor(x0 / 256), t1x = Math.floor(x1 / 256);
  const t0y = Math.floor(y0 / 256), t1y = Math.floor(y1 / 256);
  const jobs = [];
  for (let tx = t0x; tx <= t1x; tx++) {
    for (let ty = t0y; ty <= t1y; ty++) {
      const url = tpl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      jobs.push(loadImg(url, { cors: true }).then((im) => ({ im, tx, ty })));
    }
  }
  const tiles = await Promise.all(jobs);
  const ok = tiles.filter((t) => t.im);
  if (!ok.length) return false;                 // sin señal: fondo liso
  g.save();
  g.beginPath(); g.rect(area.x, area.y, area.w, area.h); g.clip();
  ok.forEach(({ im, tx, ty }) => {
    g.drawImage(im, area.x + (tx * 256 - x0) * k, area.y + (ty * 256 - y0) * k, 256 * k, 256 * k);
  });
  g.restore();
  return true;
}

async function drawWalk(walk, size = 720, withBase = true) {
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#eef3ec'; g.fillRect(0, 0, size, size);
  // bbox de la traza (+ un poco de contexto)
  const pts = walk.points.map((p) => [p[0], p[1]]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
  const padGeo = Math.max((maxX - minX), (maxY - minY), 0.001) * 0.25;
  minX -= padGeo; maxX += padGeo; minY -= padGeo; maxY += padGeo;
  const footer = 92, pad = 24, W = size - pad * 2, H = size - footer - pad * 2;
  // Proyección Mercator encajada en el área de dibujo (la misma para foto y traza).
  const z = pickZoom(minX, minY, maxX, maxY);
  const px0 = lon2px(minX, z), px1 = lon2px(maxX, z);
  const py0 = lat2px(maxY, z), py1 = lat2px(minY, z);
  const s = Math.min(W / (px1 - px0), H / (py1 - py0));
  const offX = pad + (W - s * (px1 - px0)) / 2, offY = pad + (H - s * (py1 - py0)) / 2;
  const X = (lng) => offX + (lon2px(lng, z) - px0) * s;
  const Y = (lat) => offY + (lat2px(lat, z) - py0) * s;
  const area = { x: offX, y: offY, w: s * (px1 - px0), h: s * (py1 - py0) };

  let base = false;
  if (withBase) {
    try { base = await paintBasemap(g, { minX, minY, maxX, maxY }, area, z); }
    catch (e) { console.warn('[recorder] basemap', e && e.message); }
  }

  const drawLine = (coords, style, width) => {
    g.strokeStyle = style; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath(); coords.forEach((c, i) => { const px = X(c[0]), py = Y(c[1]); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.stroke();
  };
  // Sobre la foto, el contorno y los senderos necesitan contraste; sobre el fondo
  // liso, lo contrario: que no le quiten protagonismo a la traza.
  const b = CTX.state.boundary;
  if (b) (b.features || [b]).forEach((f) => {
    const gm = f.geometry || f;
    const polys = gm.type === 'Polygon' ? [gm.coordinates] : gm.type === 'MultiPolygon' ? gm.coordinates : [];
    polys.forEach((poly) => drawLine(poly[0], base ? '#ffffff' : '#b9c9b4', base ? 3 : 2));
  });
  (CTX.state.trails || []).forEach((tr) => drawLine(tr.geometry.coordinates, base ? 'rgba(255,255,255,.55)' : '#cdd8c8', 3));
  // la traza grabada
  drawLine(pts, '#e07a1f', 5);
  // inicio / fin
  const dot = (c, col) => { g.fillStyle = col; g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(X(c[0]), Y(c[1]), 7, 0, 7); g.fill(); g.stroke(); };
  dot(pts[0], '#2f9e44'); dot(pts[pts.length - 1], '#e03131');
  // fotos del treasure hunt
  (walk.photos || []).forEach((ph) => { g.font = '18px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('📷', X(ph.lng), Y(ph.lat)); });
  // pie con datos
  g.fillStyle = '#1b4332'; g.fillRect(0, size - footer, size, footer);
  g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = 'bold 22px system-ui, sans-serif';
  // La marca de la reserva, no un arbolito generico.
  const logo = await loadImg('img/brand/cantares-icon.png');
  let tx = pad;
  if (logo) { const h = 30; g.drawImage(logo, pad, size - footer + 12, h, h); tx = pad + h + 10; }
  g.fillText(RT('title'), tx, size - footer + 34);
  g.font = '16px system-ui, sans-serif'; g.fillStyle = '#d8f3dc';
  const d = new Date(walk.startedAt).toLocaleDateString();
  const line = `${d}   ·   📏 ${fmtDist(walk.distanceM)}   ·   ⏱ ${fmtDur(walk.durationMs)}` + (walk.photos && walk.photos.length ? `   ·   📷 ${walk.photos.length}` : '');
  g.fillText(line, pad, size - footer + 64);
  return cv;
}

// Un canvas con tiles de otro dominio se puede «ensuciar» y entonces toDataURL
// lanza. Si pasa, se rehace sin foto: mejor una estampa sobria que ninguna.
async function walkPNG(walk, size) {
  const cv = await drawWalk(walk, size);
  try { return cv.toDataURL('image/png'); }
  catch (e) {
    console.warn('[recorder] canvas sucio, sin fondo', e && e.message);
    return (await drawWalk(walk, size, false)).toDataURL('image/png');
  }
}

async function downloadWalk(walk) {
  const a = document.createElement('a');
  a.download = `recorrido-cantares-${new Date(walk.startedAt).toISOString().slice(0, 10)}.png`;
  a.href = await walkPNG(walk);
  a.click();
}

// ---------- API para el dashboard de cuenta ----------
export async function listWalks() { return (await walksAll()).sort((a, b) => b.startedAt - a.startedAt); }
export function walkCardHTML(walk) { return summaryCardHTML(walk, true); }   // devuelve una promesa
export { downloadWalk, openHistory };

// ---------- overlays (resumen + historial) ----------
function overlay() {
  let el = document.getElementById('rec-overlay');
  if (!el) { el = document.createElement('div'); el.id = 'rec-overlay'; el.className = 'rec-overlay hidden'; document.body.appendChild(el); }
  return el;
}
function closeOverlay() { overlay().classList.add('hidden'); }
async function summaryCardHTML(walk, withActions) {
  const img = await walkPNG(walk);
  return `<div class="rec-card">
    <img class="rec-img" src="${img}" alt="">
    <div class="rec-meta">
      ${walk.routeName ? `<div class="rec-route">${walk.routeName}</div>` : ''}
      <div class="rec-stats">
        <span>📏 <b>${fmtDist(walk.distanceM)}</b></span>
        <span>⏱ <b>${fmtDur(walk.durationMs)}</b></span>
        ${walk.photos && walk.photos.length ? `<span>📷 <b>${walk.photos.length}</b></span>` : ''}
      </div>
      <div class="rec-date">${new Date(walk.startedAt).toLocaleString()}</div>
    </div>
    ${withActions ? `<button class="rec-dl" data-id="${walk.id}">${RT('download')}</button>` : ''}
  </div>`;
}
async function showSummary(walk) {
  const el = overlay();
  el.innerHTML = `<div class="rec-sheet">
    <button class="rec-x" id="rec-x" aria-label="${RT('close')}">×</button>
    <h2>${RT('saved')} ✓</h2>
    ${await summaryCardHTML(walk, true)}
  </div>`;
  el.classList.remove('hidden');
  el.querySelector('#rec-x').onclick = closeOverlay;
  el.querySelector('.rec-dl').onclick = () => downloadWalk(walk);
}
async function openHistory() {
  const walks = (await walksAll()).sort((a, b) => b.startedAt - a.startedAt);
  // Las estampas se pintan en paralelo: en serie, diez recorridos con foto de
  // fondo dejarian la hoja en blanco un buen rato.
  const cards = await Promise.all(walks.map((w) => summaryCardHTML(w, false)));
  const el = overlay();
  el.innerHTML = `<div class="rec-sheet">
    <button class="rec-x" id="rec-x" aria-label="${RT('close')}">×</button>
    <h2>${RT('hist_h')}</h2>
    ${walks.length ? `<div class="rec-list">${walks.map((w, i) => `
      <div class="rec-hitem" data-id="${w.id}">
        ${cards[i]}
        <div class="rec-hactions">
          <button class="rec-dl" data-id="${w.id}">${RT('download')}</button>
          <button class="rec-del" data-id="${w.id}">${RT('del')}</button>
        </div>
      </div>`).join('')}</div>` : `<p class="rec-empty">${RT('empty')}</p>`}
  </div>`;
  el.classList.remove('hidden');
  el.querySelector('#rec-x').onclick = closeOverlay;
  const byId = (id) => walks.find((w) => w.id === id);
  el.querySelectorAll('.rec-dl').forEach((b) => b.onclick = () => downloadWalk(byId(b.dataset.id)));
  el.querySelectorAll('.rec-del').forEach((b) => b.onclick = async () => {
    if (!confirm(RT('del_q'))) return;
    await walkDel(b.dataset.id);
    if (isLoggedIn()) { try { await deleteRow('walks', b.dataset.id); } catch (e) { console.warn('[cloud] walk del', e && e.message); } }
    openHistory();
  });
}

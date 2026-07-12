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
    denied: 'Activa el permiso de ubicación para grabar.', none: 'No se pudo obtener la ubicación.' },
  en: { start: '⏺ Record walk', stop: '⏹ Finish', history: '📖', hist_h: 'My walks',
    waiting: 'Waiting for GPS…', started: 'Recording your walk…', saved: 'Walk saved',
    dist: 'Distance', time: 'Time', photos: 'photos', download: '⬇️ Download image',
    empty: 'No walks recorded yet. Tap “Record walk” and go.',
    del: 'Delete', del_q: 'Delete this walk?', close: 'Close', title: 'Walk in Cantares',
    denied: 'Enable the location permission to record.', none: "Couldn't get your location." },
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
  if (walk.points.length >= 2) {
    await walkPut(walk); CTX.toast(RT('saved')); showSummary(walk);
    // Con cuenta: subirla (o encolarla sin señal) para que siga al usuario.
    if (isLoggedIn()) {
      try { await saveRow('walks', walkToCloudRow(walk)); }
      catch (e) { console.warn('[cloud] walk', e && e.message); }   // queda local igual
    }
  }
  else CTX.toast(RT('none'));
}

// ---------- imagen descargable (PNG) ----------
function drawWalk(walk, size = 720) {
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
  const sx = W / (maxX - minX || 1), sy = H / (maxY - minY || 1), s = Math.min(sx, sy);
  const offX = pad + (W - s * (maxX - minX)) / 2, offY = pad + (H - s * (maxY - minY)) / 2;
  const X = (lng) => offX + (lng - minX) * s;
  const Y = (lat) => offY + (maxY - lat) * s;   // invertir Y
  const drawLine = (coords, style, width) => {
    g.strokeStyle = style; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath(); coords.forEach((c, i) => { const px = X(c[0]), py = Y(c[1]); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.stroke();
  };
  // contorno de la reserva + senderos (contexto tenue)
  const b = CTX.state.boundary;
  if (b) (b.features || [b]).forEach((f) => { const gm = f.geometry || f; const polys = gm.type === 'Polygon' ? [gm.coordinates] : gm.type === 'MultiPolygon' ? gm.coordinates : []; polys.forEach((poly) => drawLine(poly[0], '#b9c9b4', 2)); });
  (CTX.state.trails || []).forEach((tr) => drawLine(tr.geometry.coordinates, '#cdd8c8', 3));
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
  g.fillText('🌲 ' + RT('title'), pad, size - footer + 34);
  g.font = '16px system-ui, sans-serif'; g.fillStyle = '#d8f3dc';
  const d = new Date(walk.startedAt).toLocaleDateString();
  const line = `${d}   ·   📏 ${fmtDist(walk.distanceM)}   ·   ⏱ ${fmtDur(walk.durationMs)}` + (walk.photos && walk.photos.length ? `   ·   📷 ${walk.photos.length}` : '');
  g.fillText(line, pad, size - footer + 64);
  return cv;
}
function downloadWalk(walk) {
  const cv = drawWalk(walk);
  const a = document.createElement('a');
  a.download = `recorrido-cantares-${new Date(walk.startedAt).toISOString().slice(0, 10)}.png`;
  a.href = cv.toDataURL('image/png'); a.click();
}

// ---------- API para el dashboard de cuenta ----------
export async function listWalks() { return (await walksAll()).sort((a, b) => b.startedAt - a.startedAt); }
export function walkCardHTML(walk) { return summaryCardHTML(walk, true); }
export { downloadWalk, openHistory };

// ---------- overlays (resumen + historial) ----------
function overlay() {
  let el = document.getElementById('rec-overlay');
  if (!el) { el = document.createElement('div'); el.id = 'rec-overlay'; el.className = 'rec-overlay hidden'; document.body.appendChild(el); }
  return el;
}
function closeOverlay() { overlay().classList.add('hidden'); }
function summaryCardHTML(walk, withActions) {
  const img = drawWalk(walk).toDataURL('image/png');
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
function showSummary(walk) {
  const el = overlay();
  el.innerHTML = `<div class="rec-sheet">
    <button class="rec-x" id="rec-x" aria-label="${RT('close')}">×</button>
    <h2>${RT('saved')} ✓</h2>
    ${summaryCardHTML(walk, true)}
  </div>`;
  el.classList.remove('hidden');
  el.querySelector('#rec-x').onclick = closeOverlay;
  el.querySelector('.rec-dl').onclick = () => downloadWalk(walk);
}
async function openHistory() {
  const walks = (await walksAll()).sort((a, b) => b.startedAt - a.startedAt);
  const el = overlay();
  el.innerHTML = `<div class="rec-sheet">
    <button class="rec-x" id="rec-x" aria-label="${RT('close')}">×</button>
    <h2>${RT('hist_h')}</h2>
    ${walks.length ? `<div class="rec-list">${walks.map((w) => `
      <div class="rec-hitem" data-id="${w.id}">
        ${summaryCardHTML(w, false)}
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

// Cantares — grabador de recorridos del visitante. Trackea la ruta exacta por
// GPS (inicio/stop), calcula distancia y tiempo, guarda un historial local
// (IndexedDB), marca dónde se tomaron las fotos del treasure hunt y exporta una
// imagen descargable (PNG) del recorrido dibujada sobre el contorno de la reserva.

import { keepAwake, releaseAwake } from './wakelock.js';

let CTX = null;
let rec = null;     // grabación en curso
let dbP = null;

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
function renderIdle() {
  const el = bar();
  el.className = 'rec-bar';
  el.innerHTML = `<button class="rec-go" id="rec-go">${RT('start')}</button>
    <button class="rec-hist" id="rec-hist" title="${RT('hist_h')}">${RT('history')}</button>`;
  el.querySelector('#rec-go').onclick = start;
  el.querySelector('#rec-hist').onclick = openHistory;
}
function renderRecording() {
  const el = bar();
  el.className = 'rec-bar recording';
  el.innerHTML = `<span class="rec-live"><span class="rec-dot"></span>
      <b id="rec-time">0:00</b> · <b id="rec-dist">0 m</b></span>
    <button class="rec-stop" id="rec-stop">${RT('stop')}</button>`;
  el.querySelector('#rec-stop').onclick = stop;
}

// ---------- grabación ----------
function start() {
  if (!navigator.geolocation) { CTX.toast(RT('none')); return; }
  rec = { id: uid(), points: [], photos: [], startedAt: Date.now(), dist: 0, last: null,
    routeId: CTX.state.activeRoute || null,
    routeName: CTX.state.activeRoute && CTX.state.routesById[CTX.state.activeRoute] ? CTX.L(CTX.state.routesById[CTX.state.activeRoute], 'name') : null };
  renderRecording();
  CTX.toast(RT('waiting'));
  keepAwake();   // el navegador corta el GPS si la pantalla se apaga
  rec.watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 });
  rec.timer = setInterval(tick, 1000);
  tick();
}
function onPos(pos) {
  if (!rec) return;
  const c = pos.coords, pt = [c.longitude, c.latitude, Date.now()];
  if (rec.last) {
    const d = haversine(rec.last, pt);
    if (d > 1.5 && (c.accuracy == null || c.accuracy < 40)) { rec.dist += d; rec.points.push(pt); rec.last = pt; }
  } else { rec.points.push(pt); rec.last = pt; if (rec.points.length === 1) CTX.toast(RT('started')); }
}
function onErr(e) { if (rec && e.code === 1) { CTX.toast(RT('denied')); } }
function tick() {
  if (!rec) return;
  const td = document.getElementById('rec-time'), dd = document.getElementById('rec-dist');
  if (td) td.textContent = fmtDur(Date.now() - rec.startedAt);
  if (dd) dd.textContent = fmtDist(rec.dist);
}
async function stop() {
  if (!rec) return;
  releaseAwake();
  navigator.geolocation.clearWatch(rec.watchId); clearInterval(rec.timer);
  const walk = { id: rec.id, startedAt: rec.startedAt, endedAt: Date.now(),
    durationMs: Date.now() - rec.startedAt, distanceM: Math.round(rec.dist),
    points: rec.points, photos: rec.photos, routeId: rec.routeId, routeName: rec.routeName };
  rec = null;
  renderIdle();
  if (walk.points.length >= 2) { await walkPut(walk); CTX.toast(RT('saved')); showSummary(walk); }
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
export { downloadWalk };

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
  el.querySelectorAll('.rec-del').forEach((b) => b.onclick = async () => { if (confirm(RT('del_q'))) { await walkDel(b.dataset.id); openHistory(); } });
}

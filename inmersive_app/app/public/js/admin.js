// Cantares — editor de administrador (sin código). Permite a los dueños añadir y
// cambiar puntos del mapa, textos, imágenes y especies del inventario, escribiendo
// directo a Supabase. Sólo se activa para cuentas con rol 'admin'.
import { isAdmin } from './cloud.js';
import { saveRow, deleteRow, compressImage } from './sync.js';
import { doLogout } from './auth-ui.js';

let CTX = null;
let _pointDraft = null, moveMarker = null;
const TIPOS = ['mirador', 'avistamiento', 'agua', 'flora', 'servicio', 'punto'];
const GROUPS = ['flora', 'ave', 'mamifero', 'anfibio', 'otro'];
const PALETTE = ['#2b8cbe', '#d94801', '#238b45', '#c2255c', '#1098ad', '#6a4c93', '#3b5bdb', '#e07a1f', '#0f766e', '#b45309', '#7c3aed', '#0b7285'];
const EMOJIS = ['💧', '🐦', '🌳', '🌸', '🏞️', '🌱', '🦉', '🐾', '🦋', '🌿', '⛰️', '🍃'];
const rid = (pfx) => `${pfx}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;

// ctx: { state, map, t, L, LANG, toast, refreshWaypoints, refreshSpecies }
export function initAdmin(ctx) {
  CTX = ctx;
  // Sin señal la nube no puede confirmar el rol; el rol cacheado del último
  // login mantiene las herramientas (los cambios esperan en la cola offline).
  if (!isAdmin() && localStorage.getItem('cantares_role') !== 'admin') return;
  document.body.classList.add('is-admin');
  const fab = document.createElement('button');
  fab.id = 'admin-fab'; fab.className = 'admin-fab'; fab.title = 'Administrar';
  fab.textContent = '🛠️';
  (document.getElementById('view-recorridos') || document.body).appendChild(fab);
  if (CTX.makeDraggable) CTX.makeDraggable(fab, fab, 'cantares_pos_admin', openPanel);
  else fab.onclick = openPanel;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function panelEl() {
  let el = document.getElementById('admin-panel');
  if (!el) { el = document.createElement('div'); el.id = 'admin-panel'; el.className = 'admin-panel hidden'; document.body.appendChild(el); }
  return el;
}
let tab = 'puntos';
function openPanel() { renderPanel(); panelEl().classList.remove('hidden'); }
function closePanel() { panelEl().classList.add('hidden'); }

function renderPanel() {
  const el = panelEl();
  el.innerHTML = `
    <div class="admin-head">
      <strong>🛠️ Administración</strong>
      <div class="admin-head-r">
        <button class="admin-logout" id="admin-logout">Salir</button>
        <button class="admin-x" id="admin-x" aria-label="Cerrar">×</button>
      </div>
    </div>
    <div class="admin-tabs">
      <button class="admin-tab ${tab === 'puntos' ? 'sel' : ''}" data-t="puntos">Puntos</button>
      <button class="admin-tab ${tab === 'senderos' ? 'sel' : ''}" data-t="senderos">Senderos</button>
      <button class="admin-tab ${tab === 'recorridos' ? 'sel' : ''}" data-t="recorridos">Recorridos</button>
      <button class="admin-tab ${tab === 'especies' ? 'sel' : ''}" data-t="especies">Especies</button>
    </div>
    <div class="admin-body" id="admin-body"></div>`;
  el.querySelector('#admin-x').onclick = closePanel;
  el.querySelector('#admin-logout').onclick = doLogout;
  el.querySelectorAll('.admin-tab').forEach((b) => b.onclick = () => { tab = b.dataset.t; renderPanel(); });
  ({ puntos: renderPuntos, senderos: renderSenderos, recorridos: renderRecorridos, especies: renderEspecies }[tab] || renderPuntos)();
}

// ---------------- PUNTOS ----------------
function renderPuntos() {
  clearHighlight();
  const body = document.getElementById('admin-body');
  const pts = CTX.state.waypoints.slice().sort((a, b) => (a.properties.title || '').localeCompare(b.properties.title || ''));
  body.innerHTML = `
    <button class="admin-add" id="pt-add">＋ Nuevo punto</button>
    <div class="admin-list">${pts.map((w) => `
      <div class="admin-row" data-id="${esc(w.properties.id)}">
        <span class="admin-dot" style="background:${CTX.typeColor(w.properties.tipo)}"></span>
        <span class="admin-row-t">${esc(CTX.L(w.properties, 'title') || w.properties.title)}</span>
        <button class="admin-edit" data-id="${esc(w.properties.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#pt-add').onclick = () => editPunto(null);
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = () => editPunto(b.dataset.id));
}

function editPunto(id) {
  const body = document.getElementById('admin-body');
  const existing = id ? CTX.state.waypoints.find((w) => w.properties.id === id) : null;
  const restore = _pointDraft && ((id && _pointDraft.id === id) || (!id && _pointDraft._new));
  const p = restore ? _pointDraft.props : (existing ? { ...existing.properties } : { id: rid('punto'), routes: [], species_ids: [], tipo: 'punto' });
  const coords = restore ? _pointDraft.loc : (existing ? existing.geometry.coordinates : null);
  const draftBlob = restore ? _pointDraft.photoBlob : null;
  _pointDraft = null;
  const routeChecks = CTX.state.routes.map((r) => `
    <label class="admin-chk"><input type="checkbox" value="${r.id}" ${(p.routes || []).includes(r.id) ? 'checked' : ''}> ${esc(CTX.L(r, 'name'))}</label>`).join('');
  body.innerHTML = `
    <div class="admin-form">
      <label>Título (ES)</label><input id="f-title" value="${esc(p.title)}">
      <label>Title (EN)</label><input id="f-title-en" value="${esc(p.title_en)}">
      <label>Descripción (ES)</label><textarea id="f-desc" rows="3">${esc(p.description)}</textarea>
      <label>Description (EN)</label><textarea id="f-desc-en" rows="3">${esc(p.description_en)}</textarea>
      <label>Tipo</label>
      <select id="f-tipo">${TIPOS.map((tp) => `<option value="${tp}" ${p.tipo === tp ? 'selected' : ''}>${tp}</option>`).join('')}</select>
      <label>Recorridos</label><div class="admin-checks">${routeChecks}</div>
      <label>Especies (ids o nombre científico, separadas por coma)</label>
      <input id="f-species" value="${esc((p.species_ids || []).join(', '))}">
      <label>Foto</label>
      <div class="admin-photo">
        <div class="admin-photo-prev" id="f-photo-prev" style="${p.photo ? `background-image:url('${esc(p.photo)}')` : ''}"></div>
        <input type="file" id="f-photo" accept="image/*">
      </div>
      <label>Ubicación</label>
      <div class="admin-loc">
        <span id="f-loc">${coords ? `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}` : 'sin fijar'}</span>
        <div class="admin-loc-btns">
          <button type="button" class="admin-pick gps" id="f-gps">📡 Mi ubicación</button>
          <button type="button" class="admin-pick" id="f-pick">📍 En el mapa</button>
          <button type="button" class="admin-pick" id="f-move">✥ Arrastrar</button>
        </div>
      </div>
      <input id="f-coords" placeholder="o escribe coordenadas: lat, lng (ej: 5.08181, -75.45031)" value="${coords ? `${coords[1]}, ${coords[0]}` : ''}">
      <div class="admin-err" id="f-err"></div>
      <div class="admin-actions">
        <button class="admin-save" id="f-save">Guardar</button>
        ${id ? '<button class="admin-del" id="f-del">Eliminar</button>' : ''}
        <button class="admin-cancel" id="f-cancel">Cancelar</button>
      </div>
    </div>`;
  let loc = coords ? coords.slice() : null;
  let photoUrl = p.photo || null;
  let photoBlob = draftBlob || null;   // foto nueva comprimida; se sube al Guardar
  if (photoBlob) { const pv = body.querySelector('#f-photo-prev'); if (pv) pv.style.backgroundImage = `url('${URL.createObjectURL(photoBlob)}')`; }
  const setLoc = (lng, lat) => { loc = [lng, lat]; const s = body.querySelector('#f-loc'); if (s) s.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`; };
  const coordsInput = body.querySelector('#f-coords');
  if (coordsInput) coordsInput.oninput = (e) => {
    const p = e.target.value.split(',').map((s) => parseFloat(s.trim()));
    if (p.length === 2 && isFinite(p[0]) && isFinite(p[1])) setLoc(p[1], p[0]);   // lat, lng
  };

  body.querySelector('#f-gps').onclick = () => {
    if (!navigator.geolocation) { CTX.toast('GPS no disponible'); return; }
    const btn = body.querySelector('#f-gps'); const orig = btn.textContent; btn.disabled = true;
    // El primer fijo del GPS suele ser malo: observar hasta 10 s y quedarse con
    // el más preciso (o cortar antes si ya baja de ±8 m).
    let best = null, done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer); navigator.geolocation.clearWatch(wid);
      btn.textContent = orig; btn.disabled = false;
      if (best) { setLoc(best.coords.longitude, best.coords.latitude); CTX.toast(`📡 Ubicación fijada (±${Math.round(best.coords.accuracy)} m)`); }
      else CTX.toast('No se pudo obtener ubicación');
    };
    const wid = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        btn.textContent = `📡 ±${Math.round(pos.coords.accuracy)} m…`;
        if (pos.coords.accuracy <= 8) finish();
      },
      (e) => { if (!best) { done = true; clearTimeout(timer); navigator.geolocation.clearWatch(wid); btn.textContent = orig; btn.disabled = false; CTX.toast(e.code === 1 ? 'Permiso de ubicación denegado' : 'No se pudo obtener ubicación'); } },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    const timer = setTimeout(finish, 10000);
  };
  const v = (sel) => body.querySelector(sel).value;
  const saveDraftPoint = () => { _pointDraft = { id: p.id, _new: !id, loc, photoBlob,
    props: { ...p, title: v('#f-title'), title_en: v('#f-title-en'), description: v('#f-desc'), description_en: v('#f-desc-en'),
      tipo: v('#f-tipo'), routes: [...body.querySelectorAll('.admin-checks input:checked')].map((c) => c.value),
      species_ids: v('#f-species').split(',').map((s) => s.trim()).filter(Boolean), photo: photoUrl } }; };
  body.querySelector('#f-pick').onclick = () => {
    saveDraftPoint();
    CTX.toast('Toca el mapa para fijar el punto');
    closePanel();
    CTX.map.getCanvas().style.cursor = 'crosshair';
    CTX.map.once('click', (e) => {
      CTX.map.getCanvas().style.cursor = '';
      _pointDraft.loc = [e.lngLat.lng, e.lngLat.lat];
      openPanel(); editPunto(id);   // reabrir con la ubicación fijada (formulario preservado)
    });
  };
  body.querySelector('#f-move').onclick = () => { saveDraftPoint(); startMovePoint(id, loc); };
  body.querySelector('#f-photo').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const errEl = body.querySelector('#f-err');
    errEl.textContent = 'Preparando foto…';
    // Comprimir aquí (rápido, sin red); la subida ocurre al Guardar — y si no
    // hay señal, la foto espera en la cola offline junto con el punto.
    photoBlob = await compressImage(file);
    body.querySelector('#f-photo-prev').style.backgroundImage = `url('${URL.createObjectURL(photoBlob)}')`;
    errEl.textContent = '';
  };
  body.querySelector('#f-cancel').onclick = renderPuntos;
  if (id) body.querySelector('#f-del').onclick = async () => {
    if (!confirm('¿Eliminar este punto?')) return;
    try {
      const res = await deleteRow('waypoints', id);
      CTX.removeLocalRow('waypoints', id); renderPuntos();
      CTX.toast(res.queued ? '💾 Eliminado — se sincronizará con señal' : 'Punto eliminado');
    } catch (err) { body.querySelector('#f-err').textContent = err.message; }
  };
  body.querySelector('#f-save').onclick = async () => {
    if (!loc) { body.querySelector('#f-err').textContent = 'Fija la ubicación en el mapa.'; return; }
    const routes = [...body.querySelectorAll('.admin-checks input:checked')].map((c) => c.value);
    const species_ids = body.querySelector('#f-species').value.split(',').map((s) => s.trim()).filter(Boolean);
    const row = {
      id: p.id,
      title: body.querySelector('#f-title').value.trim() || null,
      title_en: body.querySelector('#f-title-en').value.trim() || null,
      description: body.querySelector('#f-desc').value.trim() || null,
      description_en: body.querySelector('#f-desc-en').value.trim() || null,
      tipo: body.querySelector('#f-tipo').value,
      routes, species_ids, lng: loc[0], lat: loc[1], photo: photoUrl,
    };
    body.querySelector('#f-err').textContent = 'Guardando…';
    try {
      const res = await saveRow('waypoints', row, photoBlob);
      CTX.applyLocalRow('waypoints', res.row); renderPuntos();
      CTX.toast(res.queued ? '💾 Guardado en el teléfono — se subirá con señal' : 'Punto guardado');
    } catch (err) { body.querySelector('#f-err').textContent = err.message; }
  };
}

// ---------------- ESPECIES ----------------
function renderEspecies() {
  clearHighlight();
  const body = document.getElementById('admin-body');
  const sp = CTX.state.species.slice().sort((a, b) => (a.common_name || '').localeCompare(b.common_name || ''));
  body.innerHTML = `
    <button class="admin-add" id="sp-add">＋ Nueva especie</button>
    <div class="admin-list">${sp.map((s) => `
      <div class="admin-row">
        <span class="admin-row-t">${esc(CTX.L(s, 'common_name'))} <i>${esc(s.scientific_name)}</i></span>
        <button class="admin-edit" data-id="${esc(s.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#sp-add').onclick = () => editEspecie(null);
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = () => editEspecie(b.dataset.id));
}

function editEspecie(id) {
  const body = document.getElementById('admin-body');
  const s = id ? CTX.state.species.find((x) => x.id === id) : { id: rid('sp'), group: 'flora', flagship: false, status: 'documented' };
  let photoUrl = s.photo || null;
  body.innerHTML = `
    <div class="admin-form">
      <label>Nombre común (ES)</label><input id="s-common" value="${esc(s.common_name)}">
      <label>Common name (EN)</label><input id="s-common-en" value="${esc(s.common_name_en)}">
      <label>Nombre científico</label><input id="s-sci" value="${esc(s.scientific_name)}">
      <label>Familia</label><input id="s-family" value="${esc(s.family)}">
      <label>Grupo</label>
      <select id="s-group">${GROUPS.map((g) => `<option value="${g}" ${s.group === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
      <label>Estado</label>
      <select id="s-status">
        <option value="documented" ${s.status !== 'possible' ? 'selected' : ''}>documentada</option>
        <option value="possible" ${s.status === 'possible' ? 'selected' : ''}>posible</option>
      </select>
      <label class="admin-chk"><input type="checkbox" id="s-flag" ${s.flagship ? 'checked' : ''}> Destacada (★)</label>
      <label>Foto</label>
      <div class="admin-photo">
        <div class="admin-photo-prev" id="s-photo-prev" style="${s.photo ? `background-image:url('${esc(s.photo)}')` : ''}"></div>
        <input type="file" id="s-photo" accept="image/*">
      </div>
      <div class="admin-err" id="s-err"></div>
      <div class="admin-actions">
        <button class="admin-save" id="s-save">Guardar</button>
        ${id ? '<button class="admin-del" id="s-del">Eliminar</button>' : ''}
        <button class="admin-cancel" id="s-cancel">Cancelar</button>
      </div>
    </div>`;
  let photoBlob = null;
  body.querySelector('#s-photo').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    body.querySelector('#s-err').textContent = 'Preparando foto…';
    photoBlob = await compressImage(file);
    body.querySelector('#s-photo-prev').style.backgroundImage = `url('${URL.createObjectURL(photoBlob)}')`;
    body.querySelector('#s-err').textContent = '';
  };
  body.querySelector('#s-cancel').onclick = renderEspecies;
  if (id) body.querySelector('#s-del').onclick = async () => {
    if (!confirm('¿Eliminar esta especie?')) return;
    try {
      const res = await deleteRow('species', id);
      CTX.removeLocalRow('species', id); renderEspecies();
      CTX.toast(res.queued ? '💾 Eliminada — se sincronizará con señal' : 'Especie eliminada');
    } catch (err) { body.querySelector('#s-err').textContent = err.message; }
  };
  body.querySelector('#s-save').onclick = async () => {
    const row = {
      id: s.id,
      common_name: body.querySelector('#s-common').value.trim() || null,
      common_name_en: body.querySelector('#s-common-en').value.trim() || null,
      scientific_name: body.querySelector('#s-sci').value.trim() || null,
      family: body.querySelector('#s-family').value.trim() || null,
      group: body.querySelector('#s-group').value,
      status: body.querySelector('#s-status').value,
      flagship: body.querySelector('#s-flag').checked,
      photo: photoUrl,
    };
    body.querySelector('#s-err').textContent = 'Guardando…';
    try {
      const res = await saveRow('species', row, photoBlob);
      CTX.applyLocalRow('species', res.row); renderEspecies();
      CTX.toast(res.queued ? '💾 Guardada en el teléfono — se subirá con señal' : 'Especie guardada');
    } catch (err) { body.querySelector('#s-err').textContent = err.message; }
  };
}

// ---------------- helpers geométricos ----------------
function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function lenM(cs) { let d = 0; for (let i = 1; i < cs.length; i++) d += hav(cs[i - 1], cs[i]); return d; }
function fmtLen(cs) { const m = lenM(cs); return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }

// ---------------- dibujo de senderos en el mapa ----------------
let draw = null;
function drawInit() {
  const map = CTX.map;
  if (!styleReady()) return false;
  if (!map.getSource('admin-draw')) {
    try {
      const empty = { type: 'FeatureCollection', features: [] };
      map.addSource('admin-draw', { type: 'geojson', data: empty });
      map.addSource('admin-draw-v', { type: 'geojson', data: empty });
      map.addLayer({ id: 'admin-draw-line', type: 'line', source: 'admin-draw',
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e07a1f', 'line-width': 5 } });
      map.addLayer({ id: 'admin-draw-v', type: 'circle', source: 'admin-draw-v',
        paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#e07a1f', 'circle-stroke-width': 2 } });
    } catch (e) { return false; }
  }
  return true;
}
function drawUpdate() {
  const map = CTX.map, cs = draw.coords;
  if (!map.getSource('admin-draw')) return;
  map.getSource('admin-draw').setData({ type: 'FeatureCollection', features: cs.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: cs } }] : [] });
  map.getSource('admin-draw-v').setData({ type: 'FeatureCollection', features: cs.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })) });
}
function drawClear() {
  const map = CTX.map;
  if (draw && draw.clickHandler) map.off('click', draw.clickHandler);
  if (draw && draw.watchId != null) navigator.geolocation.clearWatch(draw.watchId);
  if (map.getSource('admin-draw')) { const e = { type: 'FeatureCollection', features: [] }; map.getSource('admin-draw').setData(e); map.getSource('admin-draw-v').setData(e); }
  map.getCanvas().style.cursor = ''; draw = null;
}
function showDrawHud() {
  let h = document.getElementById('admin-draw-hud');
  if (!h) { h = document.createElement('div'); h.id = 'admin-draw-hud'; h.className = 'admin-draw-hud'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
  updateDrawHud();
}
function updateDrawHud() {
  const h = document.getElementById('admin-draw-hud'); if (!h || !draw) return;
  // Reconstruir el HUD sólo cuando cambia su estructura (modo/pausa): si se
  // re-renderiza en cada fijo del GPS, los botones se "escapan" bajo el dedo.
  const key = draw.mode + (draw.paused ? ':p' : '');
  if (h.dataset.k !== key) {
    h.dataset.k = key;
    h.innerHTML = `<span class="adh-n"></span><span class="adh-acc"></span>
      ${draw.mode === 'vertex' ? '<button id="adh-undo">↶</button>' : ''}
      ${draw.mode === 'gps' ? `<button id="adh-pause">${draw.paused ? '▶ Seguir' : '⏸'}</button>` : ''}
      <button id="adh-done" class="adh-done">✓ Terminar</button>
      <button id="adh-cancel">✕</button>`;
    const u = h.querySelector('#adh-undo'); if (u) u.onclick = () => { draw.coords.pop(); drawUpdate(); updateDrawHud(); };
    const pz = h.querySelector('#adh-pause'); if (pz) pz.onclick = () => { draw.paused = !draw.paused; updateDrawHud(); CTX.toast(draw.paused ? '⏸ Grabación en pausa' : '▶ Grabando de nuevo'); };
    h.querySelector('#adh-done').onclick = () => endDraw(true);
    h.querySelector('#adh-cancel').onclick = () => endDraw(false);
  }
  h.querySelector('.adh-n').textContent = `${draw.coords.length} pts · ${fmtLen(draw.coords)}`;
  const accEl = h.querySelector('.adh-acc');
  if (draw.mode === 'gps' && draw.acc != null) {
    accEl.textContent = `±${Math.round(draw.acc)} m`;
    accEl.className = 'adh-acc ' + (draw.acc <= 10 ? 'good' : draw.acc <= 20 ? 'mid' : 'bad');
  } else accEl.textContent = '';
}
function endDraw(keep) {
  const mode = draw.mode, onDone = draw.onDone;
  let coords = draw.coords.slice();
  drawClear();
  const h = document.getElementById('admin-draw-hud'); if (h) h.remove();
  // El trazo GPS conserva algo de zigzag aun filtrado: simplificar (2 m de
  // tolerancia) deja la forma del sendero y quita el ruido.
  if (keep && mode === 'gps' && coords.length > 2) coords = simplifyDP(coords, 2);
  openPanel();
  onDone(keep && coords.length > 1 ? coords : null);
}
// Douglas–Peucker en metros (proyección local): quita el zigzag conservando la forma.
function simplifyDP(cs, tolM) {
  const lat0 = cs[0][1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
  const pts = cs.map((c) => [(c[0] - cs[0][0]) * kx, (c[1] - cs[0][1]) * ky]);
  const keep = new Array(cs.length).fill(false); keep[0] = keep[cs.length - 1] = true;
  const stack = [[0, cs.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const t = len2 ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx - pts[i][0], ay + t * dy - pts[i][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
  }
  return cs.filter((_, i) => keep[i]);
}
function startVertexDraw(onDone) {
  if (!drawInit()) { CTX.toast('Espera a que cargue el mapa'); onDone(null); return; }
  draw = { coords: [], onDone, mode: 'vertex' };
  closePanel();
  CTX.map.getCanvas().style.cursor = 'crosshair';
  CTX.toast('Toca el mapa para trazar el sendero');
  draw.clickHandler = (e) => { draw.coords.push([e.lngLat.lng, e.lngLat.lat]); drawUpdate(); updateDrawHud(); };
  CTX.map.on('click', draw.clickHandler);
  showDrawHud();
}
function startGpsDraw(onDone) {
  if (!navigator.geolocation) { CTX.toast('GPS no disponible'); return; }
  if (!drawInit()) { CTX.toast('Espera a que cargue el mapa'); onDone(null); return; }
  draw = { coords: [], onDone, mode: 'gps', ema: null, acc: null, warm: 0, paused: false };
  closePanel();
  CTX.toast('Grabando… camina el sendero (los primeros segundos calibran el GPS)');
  draw.watchId = navigator.geolocation.watchPosition((p) => {
    if (!draw) return;
    draw.acc = p.coords.accuracy;
    const c = [p.coords.longitude, p.coords.latitude];
    // 1) Sólo fijos precisos (≤25 m) y descartando el arranque en frío del GPS.
    const okAcc = p.coords.accuracy == null || p.coords.accuracy <= 25;
    if (!draw.paused && okAcc && draw.warm++ >= 2) {
      // 2) Suavizado exponencial: amortigua el zigzag entre fijos.
      draw.ema = draw.ema ? [draw.ema[0] + (c[0] - draw.ema[0]) * 0.45, draw.ema[1] + (c[1] - draw.ema[1]) * 0.45] : c;
      // 3) Añadir punto sólo si avanzó más que el ruido esperado del GPS
      //    (parado en un sitio NO se acumulan puntos falsos).
      const last = draw.coords[draw.coords.length - 1];
      const gate = Math.max(4, (p.coords.accuracy || 10) * 0.5);
      if (!last || hav(last, draw.ema) > gate) { draw.coords.push(draw.ema.slice()); drawUpdate(); }
    }
    updateDrawHud();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  showDrawHud();
}

// ---------------- resaltar senderos en el mapa ----------------
const trailFeat = (id) => CTX.state.trails.find((t) => t.properties.id === id);
function orderColor(i, n) {
  if (n <= 1) return '#2f9e44';
  const hue = 130 - (i / (n - 1)) * 130;   // verde (inicio) → rojo (fin) = dirección
  return `hsl(${Math.round(hue)}, 75%, 45%)`;
}
const styleReady = () => CTX.map && CTX.map.isStyleLoaded && CTX.map.isStyleLoaded();
function ensureHl() {
  const map = CTX.map;
  if (!styleReady()) return false;   // evita "Style is not done loading" y no rompe el resto
  if (!map.getSource('admin-hl')) {
    try {
      map.addSource('admin-hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'admin-hl-line', type: 'line', source: 'admin-hl',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['coalesce', ['get', '_c'], '#ffd000'], 'line-width': 7, 'line-opacity': 0.95 } });
    } catch (e) { return false; }   // nunca romper el editor por un estado transitorio del mapa
  }
  return true;
}
function setHl(features) { if (!ensureHl()) return; CTX.map.getSource('admin-hl').setData({ type: 'FeatureCollection', features }); }
function clearHighlight() { const s = styleReady() && CTX.map.getSource('admin-hl'); if (s) s.setData({ type: 'FeatureCollection', features: [] }); }
function highlightSegments(ids, color) {
  setHl(ids.map((tid, i) => { const tr = trailFeat(tid); return tr ? { type: 'Feature', properties: { _c: color || orderColor(i, ids.length) }, geometry: tr.geometry } : null; }).filter(Boolean));
}
// Resaltado tenue (glow) del sendero bajo el mouse, antes de elegirlo.
function ensureHover() {
  const map = CTX.map;
  if (!styleReady()) return false;
  if (!map.getSource('admin-hover')) {
    try {
      map.addSource('admin-hover', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'admin-hover-line', type: 'line', source: 'admin-hover',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 11, 'line-opacity': 0.5, 'line-blur': 1.5 } });
    } catch (e) { return false; }
  }
  return true;
}
function setHover(tid) {
  if (!ensureHover()) return;
  const tr = tid ? trailFeat(tid) : null;
  CTX.map.getSource('admin-hover').setData({ type: 'FeatureCollection', features: tr ? [{ type: 'Feature', properties: {}, geometry: tr.geometry }] : [] });
}
function clearHover() { const s = styleReady() && CTX.map.getSource('admin-hover'); if (s) s.setData({ type: 'FeatureCollection', features: [] }); }

// ---------------- elegir senderos en el mapa (crear recorrido interactivo) ----------------
let pick = null, _routeDraft = null;
function startRoutePick(id) {
  const map = CTX.map;
  closePanel();
  map.getCanvas().style.cursor = 'crosshair';
  CTX.toast('Toca los senderos en orden. Toca uno de nuevo para quitarlo.');
  const seg = _routeDraft.segments;
  pick = { id, orig: seg.slice(), handler: null };
  const update = () => { highlightSegments(seg, _routeDraft.color); updatePickHud(seg.length); };
  pick.handler = (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['trails-all'] });
    if (!f.length) return;
    const tid = f[0].properties.id; if (tid == null) return;
    const i = seg.indexOf(tid);
    if (i >= 0) seg.splice(i, 1); else seg.push(tid);
    update();
  };
  map.on('click', pick.handler);
  // Resaltar el sendero bajo el mouse ANTES de elegirlo (escritorio).
  pick.hover = (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['trails-all'] });
    const tid = f.length ? f[0].properties.id : null;
    map.getCanvas().style.cursor = tid != null ? 'pointer' : 'crosshair';
    setHover(tid);
  };
  map.on('mousemove', pick.hover);
  showPickHud(); update();
}
function showPickHud() {
  let h = document.getElementById('admin-pick-hud');
  if (!h) { h = document.createElement('div'); h.id = 'admin-pick-hud'; h.className = 'admin-draw-hud'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
}
function updatePickHud(n) {
  const h = document.getElementById('admin-pick-hud'); if (!h) return;
  h.innerHTML = `<span class="adh-n">${n} sendero(s)</span><button id="apk-done" class="adh-done">✓ Listo</button><button id="apk-cancel">✕</button>`;
  h.querySelector('#apk-done').onclick = () => endPick(true);
  h.querySelector('#apk-cancel').onclick = () => endPick(false);
}
function endPick(keep) {
  const map = CTX.map, id = pick.id;
  if (!keep) _routeDraft.segments = pick.orig;   // ✕ = descartar cambios de esta sesión
  map.off('click', pick.handler);
  if (pick.hover) map.off('mousemove', pick.hover);
  clearHover(); map.getCanvas().style.cursor = ''; pick = null;
  const h = document.getElementById('admin-pick-hud'); if (h) h.remove();
  openPanel(); editRecorrido(id);
}

// ---------------- arrastrar un punto en el mapa ----------------
function startMovePoint(id, coords) {
  const map = CTX.map;
  closePanel();
  const start = coords || map.getCenter().toArray();
  if (moveMarker) moveMarker.remove();
  moveMarker = new maplibregl.Marker({ draggable: true, color: '#e07a1f' }).setLngLat(start).addTo(map);
  map.easeTo({ center: start, zoom: Math.max(map.getZoom(), 17) });
  CTX.toast('Arrastra el pin al lugar exacto y dale ✓ Listo');
  let h = document.getElementById('admin-move-hud');
  if (!h) { h = document.createElement('div'); h.id = 'admin-move-hud'; h.className = 'admin-draw-hud'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
  h.innerHTML = '<span class="adh-n">Arrastra el pin 📍</span><button id="amv-done" class="adh-done">✓ Listo</button><button id="amv-cancel">✕</button>';
  h.querySelector('#amv-done').onclick = () => endMove(id, true);
  h.querySelector('#amv-cancel').onclick = () => endMove(id, false);
}
function endMove(id, keep) {
  if (moveMarker) {
    if (keep) { const ll = moveMarker.getLngLat(); _pointDraft.loc = [ll.lng, ll.lat]; }
    moveMarker.remove(); moveMarker = null;
  }
  const h = document.getElementById('admin-move-hud'); if (h) h.remove();
  openPanel(); editPunto(id);
}

// ---------------- SENDEROS ----------------
function renderSenderos() {
  clearHighlight();
  const body = document.getElementById('admin-body');
  const trails = CTX.state.trails.slice().sort((a, b) => (a.properties.name || '').localeCompare(b.properties.name || ''));
  body.innerHTML = `
    <button class="admin-add" id="tr-add">＋ Nuevo sendero</button>
    <div class="admin-list">${trails.map((tr) => `
      <div class="admin-row">
        <span class="admin-row-t">${esc(tr.properties.name || tr.properties.id)} <i>${esc((tr.properties.routes || []).join(', '))}</i></span>
        <button class="admin-edit" data-id="${esc(tr.properties.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#tr-add').onclick = () => editSendero(null);
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = () => editSendero(b.dataset.id));
}
function editSendero(id) {
  const body = document.getElementById('admin-body');
  const existing = id ? CTX.state.trails.find((t) => t.properties.id === id) : null;
  const draft = CTX._draftTrail; CTX._draftTrail = null;
  const p = existing ? { ...existing.properties } : { id: (draft && draft.id) || rid('sendero'), routes: [] };
  if (draft) { p.name = draft.name; p.routes = draft.routes; }
  let coords = CTX._draftLine ? CTX._draftLine : (existing ? existing.geometry.coordinates.slice() : null);
  CTX._draftLine = null;
  const routeChecks = CTX.state.routes.map((r) => `<label class="admin-chk"><input type="checkbox" value="${r.id}" ${(p.routes || []).includes(r.id) ? 'checked' : ''}> ${esc(CTX.L(r, 'name'))}</label>`).join('');
  body.innerHTML = `
    <div class="admin-form">
      <label>Nombre</label><input id="tr-name" value="${esc(p.name)}">
      <label>Recorridos a los que pertenece</label><div class="admin-checks">${routeChecks}</div>
      <label>Trazado</label>
      <div class="admin-loc">
        <span id="tr-geo">${coords ? `${coords.length} puntos · ${fmtLen(coords)}` : 'sin trazar'}</span>
        <div class="admin-loc-btns">
          <button type="button" class="admin-pick" id="tr-draw">✏️ Dibujar</button>
          <button type="button" class="admin-pick gps" id="tr-gps">📡 Grabar</button>
        </div>
      </div>
      <div class="admin-err" id="tr-err"></div>
      <div class="admin-actions">
        <button class="admin-save" id="tr-save">Guardar</button>
        ${id ? '<button class="admin-del" id="tr-del">Eliminar</button>' : ''}
        <button class="admin-cancel" id="tr-cancel">Cancelar</button>
      </div>
    </div>`;
  const saveDraft = () => { CTX._draftTrail = { id: p.id, name: body.querySelector('#tr-name').value, routes: [...body.querySelectorAll('.admin-checks input:checked')].map((c) => c.value) }; };
  body.querySelector('#tr-draw').onclick = () => { saveDraft(); startVertexDraw((c) => { if (c) CTX._draftLine = c; editSendero(id); }); };
  body.querySelector('#tr-gps').onclick = () => { saveDraft(); startGpsDraw((c) => { if (c) CTX._draftLine = c; editSendero(id); }); };
  body.querySelector('#tr-cancel').onclick = renderSenderos;
  if (id) body.querySelector('#tr-del').onclick = async () => {
    if (!confirm('¿Eliminar este sendero?')) return;
    try {
      const res = await deleteRow('trails', id);
      CTX.removeLocalRow('trails', id); renderSenderos();
      CTX.toast(res.queued ? '💾 Eliminado — se sincronizará con señal' : 'Sendero eliminado');
    } catch (e) { body.querySelector('#tr-err').textContent = e.message; }
  };
  body.querySelector('#tr-save').onclick = async () => {
    if (!coords || coords.length < 2) { body.querySelector('#tr-err').textContent = 'Traza el sendero primero.'; return; }
    const routes = [...body.querySelectorAll('.admin-checks input:checked')].map((c) => c.value);
    const row = { id: p.id, name: body.querySelector('#tr-name').value.trim() || null, routes, geometry: coords };
    body.querySelector('#tr-err').textContent = 'Guardando…';
    try {
      const res = await saveRow('trails', row);
      CTX.applyLocalRow('trails', row); clearHighlight(); renderSenderos();
      CTX.toast(res.queued ? '💾 Sendero guardado en el teléfono — se subirá con señal' : 'Sendero guardado');
    } catch (e) { body.querySelector('#tr-err').textContent = e.message; }
  };
  // Ilumina en el mapa el sendero que se está editando.
  if (coords && coords.length > 1) setHl([{ type: 'Feature', properties: { _c: '#ffd000' }, geometry: { type: 'LineString', coordinates: coords } }]);
  else clearHighlight();
}

// ---------------- RECORRIDOS ----------------
function renderRecorridos() {
  clearHighlight();
  const body = document.getElementById('admin-body');
  const routes = CTX.state.routes.slice();
  body.innerHTML = `
    <button class="admin-add" id="rt-add">＋ Nuevo recorrido</button>
    <div class="admin-list">${routes.map((r) => `
      <div class="admin-row">
        <span class="admin-dot" style="background:${r.color || '#888'}"></span>
        <span class="admin-row-t">${r.emoji || ''} ${esc(CTX.L(r, 'name') || r.id)}</span>
        <button class="admin-edit" data-id="${esc(r.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#rt-add').onclick = () => editRecorrido(null);
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = () => editRecorrido(b.dataset.id));
}
function editRecorrido(id) {
  const body = document.getElementById('admin-body');
  let r;
  if (_routeDraft && ((id && _routeDraft.id === id) || (!id && _routeDraft._new))) {
    const base = id ? CTX.state.routesById[id] : { color: PALETTE[0], emoji: EMOJIS[0], sort: CTX.state.routes.length };
    r = { ...base, ..._routeDraft };   // restaurar formulario tras elegir en el mapa
  } else {
    r = id ? CTX.state.routesById[id] : { id: rid('rec'), color: PALETTE[0], emoji: EMOJIS[0], segments: [], sort: CTX.state.routes.length };
  }
  _routeDraft = null;
  let segWork = (r.segments || []).slice();
  let color = r.color || PALETTE[0], emoji = r.emoji || EMOJIS[0];
  const wpOpts = (sel) => '<option value="">—</option>' + CTX.state.waypoints.map((w) => `<option value="${w.properties.id}" ${sel === w.properties.id ? 'selected' : ''}>${esc(CTX.L(w.properties, 'title') || w.properties.id)}</option>`).join('');
  body.innerHTML = `
    <div class="admin-form">
      <label>Nombre (ES)</label><input id="rt-name" value="${esc(r.name)}">
      <label>Name (EN)</label><input id="rt-name-en" value="${esc(r.name_en)}">
      <label>Emoji</label><div class="admin-emojis" id="rt-emojis">${EMOJIS.map((e) => `<button type="button" class="admin-emoji ${e === emoji ? 'sel' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
      <label>Color</label><div class="admin-palette" id="rt-palette">${PALETTE.map((c) => `<button type="button" class="admin-sw ${c === color ? 'sel' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <label>Resumen (ES)</label><textarea id="rt-sum" rows="2">${esc(r.summary)}</textarea>
      <label>Summary (EN)</label><textarea id="rt-sum-en" rows="2">${esc(r.summary_en)}</textarea>
      <label>Senderos en orden (define la dirección)</label>
      <button type="button" class="admin-pick map-pick" id="rt-pick">🗺️ Elegir en el mapa</button>
      <div id="rt-segs"></div>
      <label>Punto de inicio</label><select id="rt-start">${wpOpts(r.start_id)}</select>
      <label>Punto de fin</label><select id="rt-end">${wpOpts(r.end_id)}</select>
      <div class="admin-err" id="rt-err"></div>
      <div class="admin-actions">
        <button class="admin-save" id="rt-save">Guardar</button>
        ${id ? '<button class="admin-del" id="rt-del">Eliminar</button>' : ''}
        <button class="admin-cancel" id="rt-cancel">Cancelar</button>
      </div>
    </div>`;
  body.querySelectorAll('#rt-emojis .admin-emoji').forEach((b) => b.onclick = () => { emoji = b.dataset.e; body.querySelectorAll('#rt-emojis .admin-emoji').forEach((x) => x.classList.toggle('sel', x.dataset.e === emoji)); });
  body.querySelectorAll('#rt-palette .admin-sw').forEach((b) => b.onclick = () => { color = b.dataset.c; body.querySelectorAll('#rt-palette .admin-sw').forEach((x) => x.classList.toggle('sel', x.dataset.c === color)); });
  const renderSegs = () => {
    const el = document.getElementById('rt-segs');
    el.innerHTML = `
      <ol class="admin-seglist">${segWork.map((tid, i) => { const tr = CTX.state.trails.find((t) => t.properties.id === tid); return `<li><span>${esc(tr ? tr.properties.name || tid : tid)}</span><span class="admin-seg-btns"><button type="button" data-up="${i}">↑</button><button type="button" data-down="${i}">↓</button><button type="button" data-rm="${i}">✕</button></span></li>`; }).join('')}</ol>
      <select id="rt-segsel"><option value="">＋ añadir sendero…</option>${CTX.state.trails.map((t) => `<option value="${t.properties.id}">${esc(t.properties.name || t.properties.id)}</option>`).join('')}</select>`;
    el.querySelector('#rt-segsel').onchange = (e) => { if (e.target.value) { segWork.push(e.target.value); renderSegs(); } };
    el.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => { const i = +b.dataset.up; if (i > 0) { [segWork[i - 1], segWork[i]] = [segWork[i], segWork[i - 1]]; renderSegs(); } });
    el.querySelectorAll('[data-down]').forEach((b) => b.onclick = () => { const i = +b.dataset.down; if (i < segWork.length - 1) { [segWork[i + 1], segWork[i]] = [segWork[i], segWork[i + 1]]; renderSegs(); } });
    el.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { segWork.splice(+b.dataset.rm, 1); renderSegs(); });
    highlightSegments(segWork, color);   // iluminar solo los elegidos, en el color del recorrido
  };
  renderSegs();
  const saveDraft = () => { _routeDraft = { id: r.id, _new: !id, sort: r.sort,
    name: body.querySelector('#rt-name').value, name_en: body.querySelector('#rt-name-en').value,
    emoji, color, summary: body.querySelector('#rt-sum').value, summary_en: body.querySelector('#rt-sum-en').value,
    start_id: body.querySelector('#rt-start').value, end_id: body.querySelector('#rt-end').value,
    segments: segWork.slice() }; };
  body.querySelector('#rt-pick').onclick = () => { saveDraft(); startRoutePick(id); };
  body.querySelector('#rt-cancel').onclick = () => { clearHighlight(); renderRecorridos(); };
  if (id) body.querySelector('#rt-del').onclick = async () => {
    if (!confirm('¿Eliminar este recorrido?')) return;
    try {
      const res = await deleteRow('routes', id);
      CTX.removeLocalRow('routes', id); renderRecorridos();
      CTX.toast(res.queued ? '💾 Eliminado — se sincronizará con señal' : 'Recorrido eliminado');
    } catch (e) { body.querySelector('#rt-err').textContent = e.message; }
  };
  body.querySelector('#rt-save').onclick = async () => {
    const row = { id: r.id, name: body.querySelector('#rt-name').value.trim() || null, name_en: body.querySelector('#rt-name-en').value.trim() || null,
      emoji, color, summary: body.querySelector('#rt-sum').value.trim() || null, summary_en: body.querySelector('#rt-sum-en').value.trim() || null,
      start_id: body.querySelector('#rt-start').value || null, end_id: body.querySelector('#rt-end').value || null,
      segments: segWork, sort: r.sort || 0 };
    body.querySelector('#rt-err').textContent = 'Guardando…';
    try {
      const res = await saveRow('routes', row);
      CTX.applyLocalRow('routes', row); clearHighlight(); renderRecorridos();
      CTX.toast(res.queued ? '💾 Recorrido guardado en el teléfono — se subirá con señal' : 'Recorrido guardado');
    } catch (e) { body.querySelector('#rt-err').textContent = e.message; }
  };
}

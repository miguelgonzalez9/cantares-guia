// Cantares — editor de administrador (sin código). Permite a los dueños añadir y
// cambiar puntos del mapa, textos, imágenes y especies del inventario, escribiendo
// directo a Supabase. Sólo se activa para cuentas con rol 'admin'.
import { isAdmin } from './cloud.js';
import { saveRow, deleteRow, compressImage, patchRow } from './sync.js';
import { keepAwake, releaseAwake } from './wakelock.js';
import { doLogout } from './auth-ui.js';
import { exportFieldBackup } from './field-export.js';   // respaldo de fotos del juego → SIC (Dropbox)

let CTX = null;
let _pointDraft = null, moveMarker = null;
const TIPOS = ['mirador', 'avistamiento', 'agua', 'flora', 'servicio', 'punto'];
// Etiquetas humanas para los selects (los valores internos no cambian).
const TIPO_LABEL = { mirador: '🔭 Mirador', avistamiento: '🐾 Avistamiento', agua: '💧 Agua', flora: '🌿 Flora', servicio: '🏠 Servicio (casa, cabaña…)', punto: '📍 Otro punto' };
// Vocabulario 1:1 con el Sistema de Información (14_classify_photos.py): aves,
// anfibios, mamíferos, insectos, árboles, flores, plantas.
const GROUPS = ['ave', 'anfibio', 'mamifero', 'insecto', 'arbol', 'flor', 'planta', 'otro'];
const GROUP_LABEL = { ave: '🐦 Ave', anfibio: '🐸 Anfibio', mamifero: '🐾 Mamífero',
  insecto: '🐞 Insecto', arbol: '🌳 Árbol', flor: '🌸 Flor', planta: '🌿 Planta', otro: '❓ Otro' };
// Grupo por defecto en el editor cuando la especie trae un grupo heredado
// ('flora'): usa el campo 'habit' del SIC (arbol/flor), o el link a punto-árbol,
// y cae en 'planta' (fallback).
function editorGroup(s) {
  if (GROUPS.includes(s.group)) return s.group;
  const h = String(s.habit || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (h === 'arbol') return 'arbol';
  if (h === 'flor' || h === 'orquidea') return 'flor';
  if (h === 'arbusto' || h === 'hierba' || h === 'planta') return 'planta';
  const isTree = (CTX && CTX.state.waypoints || []).some((w) => w.properties.tipo === 'arbol'
    && (w.properties.species_ids || []).some((sid) => String(sid).trim().toLowerCase() === String(s.id).toLowerCase()
      || String(sid).trim().toLowerCase() === String(s.scientific_name || '').toLowerCase()));
  return isTree ? 'arbol' : 'planta';
}
// Errores técnicos → mensajes accionables en español (lo técnico va a console).
function friendlyErr(e) {
  const m = (e && e.message) || String(e || '');
  console.warn('[admin]', m);
  if (/row-level security|permission|policy|403/i.test(m)) return 'No tienes permiso para este cambio. ¿Venció tu sesión? Sal y vuelve a entrar con tu usuario de admin.';
  if (/JWT|token|expired|401/i.test(m)) return 'Tu sesión venció — cierra sesión y vuelve a entrar.';
  if (/fetch|network|timeout|conex/i.test(m)) return 'Sin conexión. El cambio quedó guardado en el teléfono y se subirá solo cuando haya señal.';
  if (/duplicate|unique/i.test(m)) return 'Ya existe un elemento con ese identificador.';
  return 'No se pudo guardar: ' + m;
}
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

// Lista de checkboxes de especies (con nombre común) para el editor de puntos.
// Sin escribir ids ni nombres científicos a mano: cero errores de tipeo.
function speciesChecks(selected) {
  const sel = new Set((selected || []).map((s) => String(s).trim().toLowerCase()));
  return CTX.state.species.slice()
    .sort((a, b) => (a.common_name || a.scientific_name || '').localeCompare(b.common_name || b.scientific_name || ''))
    .map((s) => {
      const on = sel.has(String(s.id).toLowerCase()) || sel.has((s.scientific_name || '').toLowerCase());
      // Siempre el nombre científico entre paréntesis para distinguir especies
      // que comparten nombre común (p. ej. varios «Encenillo»).
      const label = s.common_name ? (s.scientific_name ? `${s.common_name} (${s.scientific_name})` : s.common_name) : (s.scientific_name || s.id);
      const search = `${s.common_name || ''} ${s.scientific_name || ''}`.toLowerCase();
      return `<label class="admin-chk" data-n="${esc(search)}"><input type="checkbox" value="${esc(s.id)}" ${on ? 'checked' : ''}> ${esc(label)}</label>`;
    }).join('');
}

function panelEl() {
  let el = document.getElementById('admin-panel');
  if (!el) { el = document.createElement('div'); el.id = 'admin-panel'; el.className = 'admin-panel hidden'; document.body.appendChild(el); }
  return el;
}
let tab = 'puntos';
function openPanel() { renderPanel(); panelEl().classList.remove('hidden'); }
function closePanel() {
  panelEl().classList.add('hidden');
  if (selMarker) { selMarker.remove(); selMarker = null; }   // limpia el resaltado de selección
  _selId = null; try { clearHighlight(); } catch (e) { /* estilo transitorio */ }
}

function renderPanel() {
  const el = panelEl();
  el.innerHTML = `
    <div class="admin-head">
      <strong>🛠️ Administración</strong>
      <div class="admin-head-r">
        <button class="admin-edit-toggle ${editMode ? 'on' : ''}" id="admin-edit">${editMode ? '✏️ Editando' : '✏️ Editar mapa'}</button>
        <button class="admin-logout" id="admin-logout">Salir</button>
        <button class="admin-x" id="admin-x" aria-label="Cerrar">×</button>
      </div>
    </div>
    ${editMode ? `<div class="edit-toolbar">
      <span class="edit-hint">Toca en el mapa para seleccionar y editar. O crea:</span>
      <button class="edit-new" data-new="punto">📍＋ Punto</button>
      <button class="edit-new" data-new="sendero">✎＋ Sendero</button>
      <button class="edit-new" data-new="recorrido">🧭＋ Recorrido</button>
    </div>` : ''}
    <div class="admin-tabs">
      <button class="admin-tab ${tab === 'puntos' ? 'sel' : ''}" data-t="puntos">Puntos</button>
      <button class="admin-tab ${tab === 'senderos' ? 'sel' : ''}" data-t="senderos">Senderos</button>
      <button class="admin-tab ${tab === 'recorridos' ? 'sel' : ''}" data-t="recorridos">Recorridos</button>
      <button class="admin-tab ${tab === 'fotos' ? 'sel' : ''}" data-t="fotos">🖼️ Fotos${unclassifiedCount() ? ` <span class="fm-badge">${unclassifiedCount()}</span>` : ''}</button>
    </div>
    <div class="admin-note" style="margin:6px 10px 0">Las especies se editan en la pestaña 🦋 Especies.</div>
    <div class="admin-body" id="admin-body"></div>`;
  if (tab === 'especies') tab = 'puntos';   // las especies ya no viven en el panel
  el.querySelector('#admin-x').onclick = closePanel;
  el.querySelector('#admin-logout').onclick = doLogout;
  el.querySelector('#admin-edit').onclick = () => toggleEditMode();
  el.querySelectorAll('.edit-new').forEach((b) => b.onclick = () => {
    const kind = b.dataset.new;
    if (kind === 'punto') { editAddMode = 'punto'; CTX.toast('📍 Toca el mapa donde va el punto.'); }
    else if (kind === 'sendero') editSendero(null);
    else editRecorrido(null);
  });
  el.querySelectorAll('.admin-tab').forEach((b) => b.onclick = () => { tab = b.dataset.t; renderPanel(); });
  ({ puntos: renderPuntos, senderos: renderSenderos, recorridos: renderRecorridos, fotos: renderFotos }[tab] || renderPuntos)();
  if (editMode && editSel) { markSelectedRow(editSel.id); updateEditBar(); }
}

// ---------------- selección lista ↔ mapa (buscar / resaltar) ----------------
let _selId = null, selMarker = null;
function markSelectedRow(id) {
  document.querySelectorAll('#admin-body .admin-row').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
}
function fitGeom(geom) {
  const cs = geom.type === 'LineString' ? geom.coordinates : geom.type === 'Point' ? [geom.coordinates] : [];
  if (!cs.length || !CTX.map) return;
  let a = [Infinity, Infinity], b = [-Infinity, -Infinity];
  cs.forEach(([x, y]) => { a[0] = Math.min(a[0], x); a[1] = Math.min(a[1], y); b[0] = Math.max(b[0], x); b[1] = Math.max(b[1], y); });
  try { CTX.map.fitBounds([a, b], { padding: 90, maxZoom: 18, duration: 600 }); } catch (e) { /* bounds degenerados */ }
}
// Selecciona (≠ editar) un item: lo resalta en el mapa (dorado) y lleva el mapa ahí.
function selectOnMap(kind, id) {
  const map = CTX.map; if (!map) return;
  _selId = id;
  if (selMarker) { selMarker.remove(); selMarker = null; }
  clearHighlight();
  if (kind === 'punto') {
    const w = CTX.state.waypoints.find((x) => x.properties.id === id);
    if (w) { selMarker = new maplibregl.Marker({ color: '#fab814' }).setLngLat(w.geometry.coordinates).addTo(map); map.easeTo({ center: w.geometry.coordinates, zoom: Math.max(map.getZoom(), 17.5), duration: 600 }); }
  } else if (kind === 'sendero') {
    const tr = CTX.state.trails.find((x) => x.properties.id === id);
    if (tr) { setHl([{ type: 'Feature', properties: { _c: '#fab814' }, geometry: tr.geometry }]); fitGeom(tr.geometry); }
  } else if (kind === 'recorrido') {
    const r = CTX.state.routesById[id], segs = (r && r.segments) || [];
    highlightSegments(segs, '#fab814');
    const tr = CTX.state.trails.find((x) => segs.includes(x.properties.id));
    if (tr) fitGeom(tr.geometry);
  }
  markSelectedRow(id);
}
// Busca en la lista + hace las filas seleccionables (llevan al mapa).
function wireList(kind) {
  const body = document.getElementById('admin-body');
  const search = body.querySelector('.admin-search');
  if (search) search.oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    body.querySelectorAll('.admin-row').forEach((r) => { r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  };
  body.querySelectorAll('.admin-row').forEach((r) => {
    const t = r.querySelector('.admin-row-t');
    // En modo edición, tocar una fila SELECCIONA la feature (manijas en el mapa);
    // fuera del modo, solo la resalta y lleva el mapa ahí.
    if (t) t.onclick = () => editMode ? editSelect(kind, r.dataset.id) : selectOnMap(kind, r.dataset.id);
  });
}
// Sentido inverso: al tocar un punto en el MAPA con el panel abierto, lleva la
// lista al punto y lo resalta.
export function focusFromMap(id) {
  if (!CTX || panelEl().classList.contains('hidden')) return false;
  if (tab !== 'puntos') { tab = 'puntos'; renderPanel(); }
  _selId = id; markSelectedRow(id);
  const sel = '#admin-body .admin-row';
  const row = [...document.querySelectorAll(sel)].find((r) => r.dataset.id === id);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

// ---------------- PUNTOS ----------------
function renderPuntos() {
  clearHighlight();
  const body = document.getElementById('admin-body');
  const pts = CTX.state.waypoints.slice().sort((a, b) => (a.properties.title || '').localeCompare(b.properties.title || ''));
  body.innerHTML = `
    <button class="admin-add" id="pt-add">＋ Nuevo punto</button>
    <input class="admin-search" placeholder="🔎 Buscar punto… (toca para verlo en el mapa)">
    <div class="admin-list">${pts.map((w) => `
      <div class="admin-row" data-id="${esc(w.properties.id)}">
        <span class="admin-dot" style="background:${CTX.typeColor(w.properties.tipo)}"></span>
        <span class="admin-row-t">${esc(CTX.L(w.properties, 'title') || w.properties.title)}</span>
        <button class="admin-edit" data-id="${esc(w.properties.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#pt-add').onclick = () => editPunto(null);
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = (e) => { e.stopPropagation(); editPunto(b.dataset.id); });
  wireList('punto');
  if (_selId) markSelectedRow(_selId);
}

function editPunto(id) {
  const body = document.getElementById('admin-body');
  const existing = id ? CTX.state.waypoints.find((w) => w.properties.id === id) : null;
  const restore = _pointDraft && ((id && _pointDraft.id === id) || (!id && _pointDraft._new));
  const p = restore ? _pointDraft.props : (existing ? { ...existing.properties } : { id: rid('punto'), routes: [], species_ids: [], tipo: 'punto' });
  const coords = restore ? _pointDraft.loc : (existing ? existing.geometry.coordinates : null);
  const draftBlob = restore ? _pointDraft.photoBlob : null;
  const draftLeafBlob = restore ? _pointDraft.leafBlob : null;
  _pointDraft = null;
  const routeChecks = CTX.state.routes.map((r) => `
    <label class="admin-chk"><input type="checkbox" value="${r.id}" ${(p.routes || []).includes(r.id) ? 'checked' : ''}> ${esc(CTX.L(r, 'name'))}</label>`).join('');
  body.innerHTML = `
    <div class="admin-form">
      <label>Título (ES)</label><input id="f-title" value="${esc(p.title)}">
      <label>Title (EN)</label><input id="f-title-en" value="${esc(p.title_en)}">
      <label>Descripción (ES)</label><textarea id="f-desc" rows="3">${esc(p.description)}</textarea>
      <div class="admin-note">Con descripción, foto o especies, el punto muestra el botón «Más información». Sin nada de eso, solo el título.</div>
      <label>Description (EN)</label><textarea id="f-desc-en" rows="3">${esc(p.description_en)}</textarea>
      <label>Tipo (define el color e ícono del pin)</label>
      <select id="f-tipo">${TIPOS.map((tp) => `<option value="${tp}" ${p.tipo === tp ? 'selected' : ''}>${TIPO_LABEL[tp] || tp}</option>`).join('')}</select>
      <label>Recorridos</label><div class="admin-checks" id="f-routes">${routeChecks}</div>
      <label>Especies en este punto (opcional)</label>
      <input id="f-sp-search" placeholder="🔎 Buscar especie…">
      <div class="admin-checks admin-sp-list" id="f-sp-list">${speciesChecks(p.species_ids)}</div>
      <label>Foto${p.tipo === 'arbol' ? ' del árbol' : ''}</label>
      <div class="admin-photo">
        <div class="admin-photo-prev" id="f-photo-prev" style="${p.photo ? `background-image:url('${esc(p.photo)}')` : ''}"></div>
        <input type="file" id="f-photo" accept="image/*">
      </div>
      ${p.photo ? '<button type="button" class="admin-pick" id="f-dl">⬇️ Descargar foto</button>' : ''}
      <label>Foto de la hoja <span style="font-weight:400;color:var(--muted)">(opcional, para árboles)</span></label>
      <div class="admin-photo">
        <div class="admin-photo-prev" id="f-leaf-prev" style="${p.photo_leaf ? `background-image:url('${esc(p.photo_leaf)}')` : ''}"></div>
        <input type="file" id="f-leaf" accept="image/*">
      </div>
      ${p.photo_leaf ? '<button type="button" class="admin-pick" id="f-leaf-dl">⬇️ Descargar hoja</button>' : ''}
      ${id ? '<button type="button" class="admin-pick fm-open" id="f-media">🖼️ Fotos y videos (galería, portada)…</button>' : ''}
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
      <button type="button" class="admin-save gps-here" id="f-here">📍 Guardar aquí y seguir</button>
      <div class="admin-note">Guarda el punto con tu ubicación actual y sigue caminando: afina la precisión sola mientras estés cerca y la congela al alejarte. No tienes que esperar en pantalla.</div>
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
  let photoLeafUrl = p.photo_leaf || null;
  let photoLeafBlob = draftLeafBlob || null;
  if (photoLeafBlob) { const pv = body.querySelector('#f-leaf-prev'); if (pv) pv.style.backgroundImage = `url('${URL.createObjectURL(photoLeafBlob)}')`; }
  const fmb = body.querySelector('#f-media'); if (fmb) fmb.onclick = () => openMediaFor('waypoint', id);
  const fdl = body.querySelector('#f-dl'); if (fdl) fdl.onclick = () => downloadPhoto(photoUrl, (p.title || 'punto'));
  const fldl = body.querySelector('#f-leaf-dl'); if (fldl) fldl.onclick = () => downloadPhoto(photoLeafUrl, (p.title || 'punto') + '_hoja');
  body.querySelector('#f-leaf').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    photoLeafBlob = await compressImage(file);
    body.querySelector('#f-leaf-prev').style.backgroundImage = `url('${URL.createObjectURL(photoLeafBlob)}')`;
  };
  const setLoc = (lng, lat) => { loc = [lng, lat]; const s = body.querySelector('#f-loc'); if (s) s.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`; };
  const coordsInput = body.querySelector('#f-coords');
  if (coordsInput) coordsInput.oninput = (e) => {
    const p = e.target.value.split(',').map((s) => parseFloat(s.trim()));
    if (p.length === 2 && isFinite(p[0]) && isFinite(p[1])) setLoc(p[1], p[0]);   // lat, lng
  };

  body.querySelector('#f-gps').onclick = () => {
    if (!navigator.geolocation) { CTX.toast('GPS no disponible'); return; }
    const btn = body.querySelector('#f-gps'); const orig = btn.textContent; btn.disabled = true;
    // Exigir ±10 m: observar hasta 45 s (bajo dosel el GPS tarda en converger,
    // pero llega) y quedarse con el fijo MÁS preciso; cortar en cuanto se logre
    // ≤10 m. Si no se logra, se usa el mejor (fallback) avisando la precisión
    // real — no dejamos precisión sobre la mesa.
    const TARGET = 10, MAX_WAIT = 45000;
    let best = null, done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer); navigator.geolocation.clearWatch(wid);
      btn.textContent = orig; btn.disabled = false;
      if (best) {
        setLoc(best.coords.longitude, best.coords.latitude);
        const a = Math.round(best.coords.accuracy);
        CTX.toast(a <= TARGET ? `📡 Ubicación fijada (±${a} m)`
          : `📡 Fijada con ±${a} m (no se logró ±${TARGET} m; a cielo abierto mejora)`);
      } else CTX.toast('No se pudo obtener ubicación');
    };
    const wid = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        btn.textContent = `📡 ±${Math.round(pos.coords.accuracy)} m…`;
        if (pos.coords.accuracy <= TARGET) finish();
      },
      (e) => { if (!best) { done = true; clearTimeout(timer); navigator.geolocation.clearWatch(wid); btn.textContent = orig; btn.disabled = false; CTX.toast(e.code === 1 ? 'Permiso de ubicación denegado' : 'No se pudo obtener ubicación'); } },
      { enableHighAccuracy: true, timeout: 60000, maximumAge: 0 });
    const timer = setTimeout(finish, MAX_WAIT);
  };
  const v = (sel) => body.querySelector(sel).value;
  // Buscador de especies: filtra la lista por nombre común o científico.
  const spSearch = body.querySelector('#f-sp-search');
  if (spSearch) spSearch.oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    body.querySelectorAll('#f-sp-list .admin-chk').forEach((lb) => {
      lb.style.display = !q || (lb.dataset.n || '').includes(q) || lb.querySelector('input').checked ? '' : 'none';
    });
  };
  const pickedRoutes = () => [...body.querySelectorAll('#f-routes input:checked')].map((c) => c.value);
  const pickedSpecies = () => [...body.querySelectorAll('#f-sp-list input:checked')].map((c) => c.value);
  const saveDraftPoint = () => { _pointDraft = { id: p.id, _new: !id, loc, photoBlob, leafBlob: photoLeafBlob,
    props: { ...p, title: v('#f-title'), title_en: v('#f-title-en'), description: v('#f-desc'), description_en: v('#f-desc-en'),
      tipo: v('#f-tipo'), routes: pickedRoutes(), species_ids: pickedSpecies(), photo: photoUrl, photo_leaf: photoLeafUrl } }; };
  body.querySelector('#f-pick').onclick = () => {
    saveDraftPoint();
    closePanel();
    const map = CTX.map;
    map.getCanvas().style.cursor = 'crosshair';
    // HUD con salida visible: antes era un modo "trampa" sin botón de cancelar.
    let h = document.getElementById('admin-pickpt-hud');
    if (!h) { h = document.createElement('div'); h.id = 'admin-pickpt-hud'; h.className = 'admin-draw-hud'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
    h.innerHTML = '<span class="adh-n">📍 Toca el mapa donde va el punto</span><button id="apt-cancel">✕ Cancelar</button>';
    const cleanup = () => { map.off('click', clickH); map.getCanvas().style.cursor = ''; h.remove(); };
    const clickH = (e) => { cleanup(); _pointDraft.loc = [e.lngLat.lng, e.lngLat.lat]; openPanel(); editPunto(id); };
    h.querySelector('#apt-cancel').onclick = () => { cleanup(); openPanel(); editPunto(id); };   // formulario preservado, sin cambiar la ubicación
    map.on('click', clickH);
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
    } catch (err) { body.querySelector('#f-err').textContent = friendlyErr(err); }
  };
  // Construye y guarda la fila con la ubicación `loc` actual. Reutilizado por
  // «Guardar» y «Guardar aquí y seguir».
  const persist = async () => {
    const row = {
      id: p.id,
      title: body.querySelector('#f-title').value.trim() || null,
      title_en: body.querySelector('#f-title-en').value.trim() || null,
      description: body.querySelector('#f-desc').value.trim() || null,
      description_en: body.querySelector('#f-desc-en').value.trim() || null,
      tipo: body.querySelector('#f-tipo').value,
      routes: pickedRoutes(), species_ids: pickedSpecies(), lng: loc[0], lat: loc[1], photo: photoUrl, photo_leaf: photoLeafUrl,
    };
    const res = await saveRow('waypoints', row, { photo: photoBlob, photo_leaf: photoLeafBlob });
    CTX.applyLocalRow('waypoints', res.row);
    return res;
  };
  // «Marca y sigue»: guarda YA con el fijo actual y afina en segundo plano.
  // El GPS se enciende SÓLO al tocar «Guardar aquí y seguir» (no al abrir el
  // editor), para no pedir permiso de ubicación cuando solo editas datos.
  body.querySelector('#f-here').onclick = async () => {
    fieldGpsOn();
    const fix = currentFix();
    if (!fix) { body.querySelector('#f-err').textContent = 'Encendiendo GPS… espera unos segundos al primer fijo y toca de nuevo.'; return; }
    loc = fix.pos;
    body.querySelector('#f-err').textContent = 'Guardando…';
    try {
      await persist();
      registerGeoRefine(p.id, fix.pos, fix.acc);
      renderPuntos();
      CTX.toast(`💾 Punto guardado (±${Math.round(fix.acc)} m). Puedes seguir; afino la ubicación sola.`);
    } catch (err) { body.querySelector('#f-err').textContent = friendlyErr(err); }
  };
  body.querySelector('#f-save').onclick = async () => {
    if (!loc) { body.querySelector('#f-err').textContent = 'Fija la ubicación en el mapa.'; return; }
    body.querySelector('#f-err').textContent = 'Guardando…';
    try {
      const res = await persist(); renderPuntos();
      CTX.toast(res.queued ? '💾 Guardado en el teléfono — se subirá con señal' : 'Punto guardado');
    } catch (err) { body.querySelector('#f-err').textContent = friendlyErr(err); }
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
      <select id="s-group">${GROUPS.map((g) => `<option value="${g}" ${editorGroup(s) === g ? 'selected' : ''}>${GROUP_LABEL[g] || g}</option>`).join('')}</select>
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
    } catch (err) { body.querySelector('#s-err').textContent = friendlyErr(err); }
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
    } catch (err) { body.querySelector('#s-err').textContent = friendlyErr(err); }
  };
}

// ---------------- editor de especies STANDALONE (desde el tab Especies) ----------------
// Modal propio (no requiere el panel admin abierto). onSaved(id) refresca la grilla.
export function openSpeciesEditor(id, onSaved) {
  if (!CTX) return;
  const s = id ? CTX.state.species.find((x) => x.id === id) : { id: rid('sp'), group: 'flora', flagship: false, status: 'documented' };
  let ov = document.getElementById('sp-editor');
  if (!ov) { ov = document.createElement('div'); ov.id = 'sp-editor'; ov.className = 'sp-editor'; document.body.appendChild(ov); }
  let photoUrl = s.photo || null, photoBlob = null;
  ov.innerHTML = `<div class="sp-editor-box">
    <button class="card-close" id="se-x" aria-label="Cerrar">×</button>
    <h2>${id ? 'Editar especie' : 'Nueva especie'}</h2>
    <div class="admin-form">
      <label>Nombre común (ES)</label><input id="se-common" value="${esc(s.common_name)}">
      <label>Common name (EN)</label><input id="se-common-en" value="${esc(s.common_name_en)}">
      <label>Nombre científico</label><input id="se-sci" value="${esc(s.scientific_name)}">
      <label>Familia</label><input id="se-family" value="${esc(s.family)}">
      <label>Grupo</label>
      <select id="se-group">${GROUPS.map((g) => `<option value="${g}" ${editorGroup(s) === g ? 'selected' : ''}>${GROUP_LABEL[g] || g}</option>`).join('')}</select>
      <label>Estado</label>
      <select id="se-status">
        <option value="documented" ${s.status !== 'possible' ? 'selected' : ''}>documentada</option>
        <option value="possible" ${s.status === 'possible' ? 'selected' : ''}>posible</option>
      </select>
      <label>Notas / descripción</label><textarea id="se-notes" rows="3">${esc(s.notes)}</textarea>
      <label class="admin-chk"><input type="checkbox" id="se-flag" ${s.flagship ? 'checked' : ''}> Destacada (★)</label>
      <label>Foto</label>
      <div class="admin-photo">
        <div class="admin-photo-prev" id="se-photo-prev" style="${s.photo ? `background-image:url('${esc(s.photo)}')` : ''}"></div>
        <input type="file" id="se-photo" accept="image/*">
      </div>
      ${s.photo ? `<button type="button" class="admin-pick" id="se-dl">⬇️ Descargar foto</button>` : ''}
      ${id ? '<button type="button" class="admin-pick fm-open" id="se-media">🖼️ Fotos y videos (galería, portada)…</button>' : ''}
      <div class="admin-err" id="se-err"></div>
      <div class="admin-actions">
        <button class="admin-save" id="se-save">Guardar</button>
        ${id ? '<button class="admin-del" id="se-del">Eliminar</button>' : ''}
        <button class="admin-cancel" id="se-cancel">Cancelar</button>
      </div>
    </div></div>`;
  const close = () => ov.remove();
  ov.querySelector('#se-x').onclick = close;
  ov.querySelector('#se-cancel').onclick = close;
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  const dl = ov.querySelector('#se-dl'); if (dl) dl.onclick = () => downloadPhoto(s.photo, (s.common_name || s.scientific_name || 'especie'));
  const smb = ov.querySelector('#se-media'); if (smb) smb.onclick = () => { close(); openMediaFor('species', id); };
  ov.querySelector('#se-photo').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    ov.querySelector('#se-err').textContent = 'Preparando foto…';
    photoBlob = await compressImage(file);
    ov.querySelector('#se-photo-prev').style.backgroundImage = `url('${URL.createObjectURL(photoBlob)}')`;
    ov.querySelector('#se-err').textContent = '';
  };
  if (id) ov.querySelector('#se-del').onclick = async () => {
    if (!confirm('¿Eliminar esta especie?')) return;
    try { const res = await deleteRow('species', id); CTX.removeLocalRow('species', id); close(); onSaved && onSaved(); CTX.toast(res.queued ? '💾 Eliminada — se sincronizará' : 'Especie eliminada'); }
    catch (err) { ov.querySelector('#se-err').textContent = friendlyErr(err); }
  };
  ov.querySelector('#se-save').onclick = async () => {
    const row = { id: s.id,
      common_name: ov.querySelector('#se-common').value.trim() || null,
      common_name_en: ov.querySelector('#se-common-en').value.trim() || null,
      scientific_name: ov.querySelector('#se-sci').value.trim() || null,
      family: ov.querySelector('#se-family').value.trim() || null,
      group: ov.querySelector('#se-group').value, status: ov.querySelector('#se-status').value,
      notes: ov.querySelector('#se-notes').value.trim() || null,
      flagship: ov.querySelector('#se-flag').checked, photo: photoUrl };
    ov.querySelector('#se-err').textContent = 'Guardando…';
    try {
      const res = await saveRow('species', row, photoBlob);
      CTX.applyLocalRow('species', res.row); close(); onSaved && onSaved(res.row.id);
      CTX.toast(res.queued ? '💾 Guardada en el teléfono — se subirá con señal' : 'Especie guardada');
    } catch (err) { ov.querySelector('#se-err').textContent = friendlyErr(err); }
  };
}

// Descarga una foto (punto o especie) forzando el guardado, aun si es de otro
// dominio (Supabase Storage): se baja como blob y se dispara la descarga.
export async function downloadPhoto(url, name) {
  if (!url) return;
  try {
    const res = await fetch(url, { mode: 'cors' });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (String(name).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'foto') + '.jpg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) {
    window.open(url, '_blank');   // respaldo: abrir en pestaña nueva
  }
}
export function isAdminUser() { return isAdmin() || localStorage.getItem('cantares_role') === 'admin'; }

// ============ georreferenciación en segundo plano («marca y sigue») ============
// El usuario guarda el punto YA con el mejor fijo del momento y sigue caminando;
// la ubicación se AFINA sola mientras siga cerca (estacionario), y se CONGELA en
// cuanto se aleja. Requiere el GPS caliente (watch continuo) — por eso se enciende
// al abrir el editor de puntos. Ojo: un punto es «donde estás al marcarlo»; por
// eso no se puede afinar mientras caminas (se afina sólo si te quedas cerca).
let geoQueue = [], geoListening = false;
const GEO_TARGET = 10, GEO_FREEZE_R = 25, GEO_MAX_MS = 90000;
const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
function fieldGpsOn() { if (CTX && CTX.ensureGps) { try { CTX.ensureGps(); } catch (e) { /* sin GPS */ } } }
function currentFix() {
  const s = CTX && CTX.state; if (!s || !s.userPos) return null;
  return { pos: s.userPos.slice(), acc: s.userAccuracy != null ? s.userAccuracy : 999 };
}
function registerGeoRefine(id, pos, acc) {
  geoQueue = geoQueue.filter((g) => g.id !== id);
  geoQueue.push({ id, anchor: pos.slice(), pos: pos.slice(), acc, startTs: nowMs() });
  if (!geoListening) { window.addEventListener('cantares:position', onFieldPos); geoListening = true; }
  updateGeoHud();
}
function onFieldPos(e) {
  if (!geoQueue.length) return;
  const d = e.detail, fix = [d.lng, d.lat], acc = d.accuracy != null ? d.accuracy : 999;
  for (const g of geoQueue.slice()) {
    if (hav(fix, g.anchor) > GEO_FREEZE_R) { finalizeGeo(g); continue; }   // se alejó → congelar
    if (acc < g.acc) { g.pos = fix; g.acc = acc; }                          // mejor fijo cerca → afinar
    if (g.acc <= GEO_TARGET || nowMs() - g.startTs > GEO_MAX_MS) finalizeGeo(g);
  }
  updateGeoHud();
}
function finalizeGeo(g) {
  geoQueue = geoQueue.filter((x) => x.id !== g.id);
  if (geoListening && !geoQueue.length) { window.removeEventListener('cantares:position', onFieldPos); geoListening = false; }
  const w = CTX.state.waypoints.find((x) => x.properties.id === g.id);
  if (w) {
    const row = wpFullRow(w); row.lng = g.pos[0]; row.lat = g.pos[1];
    CTX.applyLocalRow('waypoints', row);   // mueve el punto a la posición afinada
    patchRow('waypoints', g.id, { lng: g.pos[0], lat: g.pos[1] }, () => row).catch((err) => console.warn('[geo] patch', err && err.message));
  }
  CTX.toast(`📍 Ubicación afinada a ±${Math.round(g.acc)} m`);
  updateGeoHud();
}
function updateGeoHud() {
  let h = document.getElementById('geo-hud');
  if (!geoQueue.length) { if (h) h.remove(); return; }
  if (!h) { h = document.createElement('div'); h.id = 'geo-hud'; h.className = 'geo-hud'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
  const worst = Math.round(Math.max(...geoQueue.map((g) => g.acc)));
  h.textContent = `📍 Afinando ${geoQueue.length} punto(s)… ±${worst} m`;
}

// ================= FOTOS / MEDIOS (clasificador manual) =================
// Bandeja de fotos y videos: clasificar las que llegan sin sujeto (o mal
// clasificadas), elegir la portada de cada punto/especie, subir nuevas, borrar.
// Todo pasa por la cola offline (saveRow/deleteRow 'media').
let mediaMode = 'inbox', mediaSubject = null;   // mediaSubject = { type, id }
const VIDEO_WARN = 20 * 1024 * 1024;            // aviso de peso (afecta el espacio gratis)

function allMedia() { return (CTX.state.media && CTX.state.media.all) || []; }
function unclassifiedMedia() {
  // Sólo las que puede tocar el admin (de la nube/subidas), no las curadas build-time.
  return ((CTX.state.media && CTX.state.media.unclassified) || []).filter((m) => m.source !== 'curated');
}
function unclassifiedCount() { try { return unclassifiedMedia().length; } catch (e) { return 0; } }
function subjectMedia(type, id) { return (CTX.state.media && CTX.state.media.bySubject[`${type}:${id}`]) || []; }

function subjectLabel(m) {
  if (!m.subject_id) return '❓ Sin clasificar';
  if (m.subject_type === 'species') { const s = CTX.state.species.find((x) => x.id === m.subject_id); return '🦋 ' + esc(s ? (CTX.L(s, 'common_name') || s.scientific_name || m.subject_id) : m.subject_id); }
  const w = CTX.state.waypoints.find((x) => x.properties.id === m.subject_id);
  return '📍 ' + esc(w ? (CTX.L(w.properties, 'title') || w.properties.title || m.subject_id) : m.subject_id);
}
// Reconstruye la fila de la tabla `media` a partir del registro normalizado + un parche.
function mediaRow(m, patch) {
  return { id: m.id, kind: m.kind || 'photo', url: m.full || null,
    thumb: (m.thumb && m.thumb !== m.full) ? m.thumb : null, poster: m.poster || null,
    subject_type: m.subject_type || null, subject_id: m.subject_id || null,
    is_primary: !!m.is_primary, sort: m.sort || 0, focal_x: m.focal_x != null ? m.focal_x : 0.5,
    focal_y: m.focal_y != null ? m.focal_y : 0.5, caption: m.caption || null, caption_en: m.caption_en || null,
    credit: m.credit || null, source: m.source === 'curated' ? 'admin' : (m.source || 'admin'),
    status: (m.subject_type && m.subject_id) ? 'classified' : 'unclassified', ...patch };
}
async function saveMedia(row, blob) {
  try {
    const res = await saveRow('media', row, blob ? { url: blob } : null);
    CTX.applyLocalRow('media', res.row);
    renderFotos();
    CTX.toast(res.queued ? '💾 Guardado en el teléfono — se subirá con señal' : '🖼️ Guardado');
  } catch (e) { CTX.toast(friendlyErr(e)); }
}
async function classifyMedia(m, type, id) { await saveMedia(mediaRow(m, { subject_type: type, subject_id: id, status: 'classified' })); }
async function setPrimaryMedia(m) {
  const sibs = subjectMedia(m.subject_type, m.subject_id);
  for (const s of sibs) {
    const want = s.id === m.id;
    if (s.is_primary === want || s.source === 'curated') continue;
    try { const r = await saveRow('media', mediaRow(s, { is_primary: want })); CTX.applyLocalRow('media', r.row); }
    catch (e) { console.warn('[media] primary', e && e.message); }
  }
  renderFotos(); CTX.toast('★ Portada actualizada');
}
async function reorderMedia(m, dir) {
  const sibs = subjectMedia(m.subject_type, m.subject_id).slice();
  const i = sibs.findIndex((x) => x.id === m.id), j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  const a = sibs[i], b = sibs[j];
  try {
    const ra = await saveRow('media', mediaRow(a, { sort: b.sort })); CTX.applyLocalRow('media', ra.row);
    const rb = await saveRow('media', mediaRow(b, { sort: a.sort })); CTX.applyLocalRow('media', rb.row);
  } catch (e) { console.warn('[media] reorder', e && e.message); }
  renderFotos();
}
async function delMedia(m) {
  if (m.source === 'curated') { CTX.toast('Esa foto es del catálogo (build-time); edítala con el script.'); return; }
  if (!confirm('¿Eliminar esta foto/video?')) return;
  try { const res = await deleteRow('media', m.id); CTX.removeLocalRow('media', m.id); renderFotos(); CTX.toast(res.queued ? '💾 Eliminado — se sincronizará' : 'Eliminado'); }
  catch (e) { CTX.toast(friendlyErr(e)); }
}
function editCaption(m) {
  const cur = m.caption || '';
  const val = prompt('Pie de foto (ES):', cur);
  if (val == null) return;
  saveMedia(mediaRow(m, { caption: val.trim() || null }));
}
function addMedia(preset) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,video/*';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    const isVid = /^video\//.test(file.type);
    if (isVid && file.size > VIDEO_WARN && !confirm(`El video pesa ${Math.round(file.size / 1048576)} MB. Puede tardar en subir y consume el espacio gratis de la nube. ¿Subir igual?`)) return;
    CTX.toast('Preparando…');
    const blob = isVid ? file : await compressImage(file);
    const id = rid('media');
    const row = { id, kind: isVid ? 'video' : 'photo', url: null,
      subject_type: preset ? preset.type : null, subject_id: preset ? preset.id : null,
      is_primary: false, sort: Date.now() % 100000, focal_x: 0.5, focal_y: 0.5,
      source: 'admin', status: preset ? 'classified' : 'unclassified',
      caption: null, caption_en: null, credit: null };
    await saveMedia(row, blob);
  };
  inp.click();
}

// Tarjeta de un medio (foto/video) con sus acciones.
function mediaCardHTML(m, opts = {}) {
  const thumb = m.kind === 'video'
    ? `<div class="fm-thumb fm-video" style="${m.poster ? `background-image:url('${esc(m.poster)}')` : ''}"><span>▶</span></div>`
    : `<div class="fm-thumb" style="background-image:url('${esc(m.thumb || m.full)}')"></div>`;
  const order = opts.subject ? `<button data-a="up" title="Subir">↑</button><button data-a="down" title="Bajar">↓</button>` : '';
  return `<div class="fm-card" data-id="${esc(m.id)}">
    ${thumb}
    <div class="fm-meta">
      <span class="fm-subj">${subjectLabel(m)}${m.caption ? ` · <i>${esc(m.caption)}</i>` : ''}</span>
      <div class="fm-btns">
        <button data-a="assign">${m.subject_id ? '↻ Reasignar' : '🏷️ Clasificar'}</button>
        ${m.subject_id ? `<button data-a="primary" class="${m.is_primary ? 'on' : ''}" title="Portada">★</button>` : ''}
        ${m.subject_id ? `<button data-a="caption" title="Pie">✎</button>` : ''}
        ${order}
        <button data-a="dl" title="Descargar">⬇️</button>
        <button data-a="del" title="Eliminar">🗑️</button>
      </div>
    </div>
  </div>`;
}
function wireMediaCards(container, opts = {}) {
  container.querySelectorAll('.fm-card').forEach((card) => {
    const m = allMedia().find((x) => x.id === card.dataset.id); if (!m) return;
    card.querySelectorAll('[data-a]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === 'assign') assignPicker(m);
      else if (a === 'primary') setPrimaryMedia(m);
      else if (a === 'caption') editCaption(m);
      else if (a === 'up') reorderMedia(m, -1);
      else if (a === 'down') reorderMedia(m, +1);
      else if (a === 'dl') downloadPhoto(m.full, subjectLabel(m).replace(/[^a-zA-Z0-9]+/g, '_'));
      else if (a === 'del') delMedia(m);
    });
  });
}

// Selector de sujeto (punto o especie) para clasificar/reasignar un medio.
function assignPicker(m) {
  let ov = document.getElementById('fm-assign');
  if (!ov) { ov = document.createElement('div'); ov.id = 'fm-assign'; ov.className = 'fm-assign'; document.body.appendChild(ov); }
  let pt = m.subject_type || 'waypoint';
  const render = () => {
    const items = pt === 'species'
      ? CTX.state.species.slice().sort((a, b) => (a.common_name || a.scientific_name || '').localeCompare(b.common_name || b.scientific_name || ''))
          .map((s) => ({ id: s.id, label: (CTX.L(s, 'common_name') || s.scientific_name || s.id), sub: s.scientific_name || '' }))
      : CTX.state.waypoints.slice().sort((a, b) => (a.properties.title || '').localeCompare(b.properties.title || ''))
          .map((w) => ({ id: w.properties.id, label: (CTX.L(w.properties, 'title') || w.properties.title || w.properties.id), sub: w.properties.tipo || '' }));
    ov.innerHTML = `<div class="fm-assign-box">
      <button class="card-close" id="fa-x" aria-label="Cerrar">×</button>
      <h3>Clasificar foto/video</h3>
      <div class="fm-type-toggle">
        <button data-tp="waypoint" class="${pt === 'waypoint' ? 'sel' : ''}">📍 Punto</button>
        <button data-tp="species" class="${pt === 'species' ? 'sel' : ''}">🦋 Especie</button>
      </div>
      <input class="admin-search" id="fa-search" placeholder="🔎 Buscar…">
      <div class="fm-assign-list" id="fa-list">${items.map((it) => `<button class="fm-assign-item" data-id="${esc(it.id)}"><b>${esc(it.label)}</b>${it.sub ? ` <span>${esc(it.sub)}</span>` : ''}</button>`).join('')}</div>
      ${m.subject_id ? '<button class="admin-cancel" id="fa-unclass">Dejar sin clasificar</button>' : ''}
    </div>`;
    const close = () => ov.remove();
    ov.querySelector('#fa-x').onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    ov.querySelectorAll('.fm-type-toggle button').forEach((b) => b.onclick = () => { pt = b.dataset.tp; render(); });
    ov.querySelector('#fa-search').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      ov.querySelectorAll('.fm-assign-item').forEach((it) => { it.style.display = !q || it.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    };
    ov.querySelectorAll('.fm-assign-item').forEach((it) => it.onclick = async () => { close(); await classifyMedia(m, pt, it.dataset.id); });
    const uc = ov.querySelector('#fa-unclass'); if (uc) uc.onclick = async () => { close(); await saveMedia(mediaRow(m, { subject_type: null, subject_id: null, is_primary: false, status: 'unclassified' })); };
  };
  render();
}

// Abre el clasificador directamente en un punto/especie (desde sus editores).
export function openMediaFor(type, id) {
  if (!id) { CTX && CTX.toast('Guarda primero para poder añadir fotos/videos.'); return; }
  tab = 'fotos'; mediaMode = 'subject'; mediaSubject = { type, id };
  openPanel();
}
function renderFotos() {
  clearHighlight();
  const body = document.getElementById('admin-body');
  const n = unclassifiedMedia().length;
  body.innerHTML = `
    <div class="fm-modes">
      <button data-m="inbox" class="${mediaMode === 'inbox' ? 'sel' : ''}">Sin clasificar${n ? ` (${n})` : ''}</button>
      <button data-m="subject" class="${mediaMode === 'subject' ? 'sel' : ''}">Por punto / especie</button>
    </div>
    <div id="fm-body"></div>`;
  body.querySelectorAll('.fm-modes button').forEach((b) => b.onclick = () => { mediaMode = b.dataset.m; renderFotos(); });
  const fm = document.getElementById('fm-body');
  if (mediaMode === 'inbox') {
    const list = unclassifiedMedia();
    fm.innerHTML = `
      <button class="admin-add" id="fm-add">＋ Añadir foto / video</button>
      <div class="admin-note">Sube o clasifica fotos/videos. Las que llegan sin sujeto se listan aquí para asignarlas a un punto o especie.</div>
      ${list.length ? `<div class="fm-grid">${list.map((m) => mediaCardHTML(m)).join('')}</div>`
        : '<div class="admin-note" style="text-align:center;padding:20px">✓ Nada sin clasificar.</div>'}
      <button class="admin-pick fm-open" id="fm-field-export" style="margin-top:14px">⬇️ Exportar fotos de campo (juego) al sistema</button>
      <div class="admin-note">Descarga el respaldo de las fotos/avistamientos del juego para reingresarlas al sistema local (Dropbox).</div>`;
    document.getElementById('fm-add').onclick = () => addMedia(null);
    document.getElementById('fm-field-export').onclick = async () => {
      try { const n = await exportFieldBackup(); CTX.toast(n ? `⬇️ ${n} registro(s) de campo exportado(s)` : 'No hay fotos de campo del juego aún'); }
      catch (e) { CTX.toast(friendlyErr(e)); }
    };
    wireMediaCards(fm);
  } else {
    renderFotosSubject(fm);
  }
}
function renderFotosSubject(fm) {
  const sub = mediaSubject;
  const label = sub ? (sub.type === 'species'
    ? subjectLabel({ subject_type: 'species', subject_id: sub.id })
    : subjectLabel({ subject_type: 'waypoint', subject_id: sub.id })) : '';
  fm.innerHTML = `
    <div class="fm-subj-pick">
      <div class="fm-type-toggle">
        <button data-tp="waypoint" class="${(!sub || sub.type === 'waypoint') ? 'sel' : ''}">📍 Punto</button>
        <button data-tp="species" class="${sub && sub.type === 'species' ? 'sel' : ''}">🦋 Especie</button>
      </div>
      <input class="admin-search" id="fm-subj-search" placeholder="🔎 Elegir punto/especie…" value="${sub ? esc(label.replace(/^[^ ]+ /, '')) : ''}">
      <div class="fm-assign-list ${sub ? 'hidden' : ''}" id="fm-subj-list"></div>
    </div>
    <div id="fm-subj-media"></div>`;
  let pt = sub ? sub.type : 'waypoint';
  const renderList = (q) => {
    const box = document.getElementById('fm-subj-list');
    const items = pt === 'species'
      ? CTX.state.species.map((s) => ({ id: s.id, label: (CTX.L(s, 'common_name') && s.scientific_name) ? `${CTX.L(s, 'common_name')} (${s.scientific_name})` : (CTX.L(s, 'common_name') || s.scientific_name || s.id) }))
      : CTX.state.waypoints.map((w) => ({ id: w.properties.id, label: CTX.L(w.properties, 'title') || w.properties.title || w.properties.id }));
    const ql = (q || '').trim().toLowerCase();
    box.innerHTML = items.filter((it) => !ql || it.label.toLowerCase().includes(ql)).slice(0, 60)
      .map((it) => `<button class="fm-assign-item" data-id="${esc(it.id)}"><b>${esc(it.label)}</b></button>`).join('');
    box.querySelectorAll('.fm-assign-item').forEach((b) => b.onclick = () => { mediaSubject = { type: pt, id: b.dataset.id }; renderFotos(); });
  };
  fm.querySelectorAll('.fm-type-toggle button').forEach((b) => b.onclick = () => { pt = b.dataset.tp; mediaSubject = null; document.getElementById('fm-subj-list').classList.remove('hidden'); renderList(''); });
  const search = document.getElementById('fm-subj-search');
  search.oninput = (e) => { document.getElementById('fm-subj-list').classList.remove('hidden'); renderList(e.target.value); };
  search.onfocus = () => { document.getElementById('fm-subj-list').classList.remove('hidden'); renderList(search.value); };
  if (!sub) renderList('');
  const mediaBox = document.getElementById('fm-subj-media');
  if (sub) {
    const list = subjectMedia(sub.type, sub.id);
    mediaBox.innerHTML = `
      <button class="admin-add" id="fm-add-subj">＋ Añadir foto / video a ${esc(label)}</button>
      ${list.length ? `<div class="fm-grid">${list.map((m) => mediaCardHTML(m, { subject: true })).join('')}</div>`
        : '<div class="admin-note" style="text-align:center;padding:16px">Aún sin fotos/videos. Añade una arriba.</div>'}`;
    document.getElementById('fm-add-subj').onclick = () => addMedia({ type: sub.type, id: sub.id });
    wireMediaCards(mediaBox, { subject: true });
  }
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
  releaseAwake();   // la pantalla ya puede apagarse
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
  // Simplificar con tolerancia BAJA (1.2 m): quita el ruido colineal pero
  // conserva los vértices de los zig-zags (que se desvían más que eso).
  if (keep && mode === 'gps' && coords.length > 2) coords = simplifyDP(coords, 1.2);
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
  draw = { coords: [], onDone, mode: 'gps', ema: null, acc: null, warm: 0, paused: false, startTs: null, lastGoodTs: null };
  closePanel();
  // Con la pantalla apagada el navegador corta el GPS: mantenerla encendida.
  keepAwake().then((ok) => {
    CTX.toast(ok ? '⏺ Grabando (objetivo ±10 m)… la pantalla quedará encendida. Camina el sendero.'
                 : '⏺ Grabando (objetivo ±10 m)… ⚠️ NO apagues la pantalla (el GPS se corta). Camina el sendero.');
  });
  // Umbral de precisión: exigimos ±10 m; si el GPS no lo logra por un buen rato
  // (30 s — bajo dosel tarda pero llega), relajamos hasta ±FALLBACK para no dejar
  // un HUECO en el trazo (fallback).
  const TARGET = 10, FALLBACK = 20, STALL_MS = 30000;
  draw.watchId = navigator.geolocation.watchPosition((p) => {
    if (!draw) return;
    const acc = p.coords.accuracy;
    draw.acc = acc;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (draw.startTs == null) draw.startTs = now;
    if (acc != null && acc <= TARGET) draw.lastGoodTs = now;
    const c = [p.coords.longitude, p.coords.latitude];
    // ¿Cuánto lleva el GPS sin dar un fijo ≤ TARGET? Si supera STALL_MS, se
    // acepta hasta FALLBACK (con menos confianza) para no cortar el sendero.
    const sinceGood = now - (draw.lastGoodTs != null ? draw.lastGoodTs : draw.startTs);
    // El fallback aplica también al PRIMER punto: si tras 30 s no hay un fijo
    // ≤10 m, empezar a grabar con ±20 m para no perder el sendero entero.
    const threshold = (sinceGood > STALL_MS) ? FALLBACK : TARGET;
    const okAcc = acc == null || acc <= threshold;
    if (!draw.paused && okAcc && draw.warm++ >= 2) {
      // Suavizado exponencial más responsivo (0.6): sigue mejor los cambios de
      // dirección → conserva la forma de los zig-zags en vez de aplanarlos.
      draw.ema = draw.ema ? [draw.ema[0] + (c[0] - draw.ema[0]) * 0.6, draw.ema[1] + (c[1] - draw.ema[1]) * 0.6] : c;
      // Piso de distancia PEQUEÑO (~2.5 m, cerca de la resolución del GPS): así un
      // zig-zag con pasos cortos SÍ se guarda. Parado en un sitio el EMA converge
      // y hav(last,ema) queda < piso, así que no se acumulan puntos falsos.
      const last = draw.coords[draw.coords.length - 1];
      const gate = Math.max(2.5, (acc || 10) * 0.35);
      if (!last || hav(last, draw.ema) > gate) { draw.coords.push(draw.ema.slice()); drawUpdate(); }
    }
    updateDrawHud();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
  showDrawHud();
}

// ---------------- editar vértices + conectar (snap) senderos ----------------
// Arrastra cada vértice; la línea se mueve con él. Al soltar cerca de un vértice
// de OTRO sendero, se engancha (comparte coordenada) → la red queda conectada.
// Tocar la línea inserta un vértice; el modo 🗑️ borra al tocar un vértice.
let vedit = null;
const VX_SNAP_M = 12, VX_INSERT_M = 14;
function otherTrailVertices(exceptId) {
  const out = [];
  (CTX.state.trails || []).forEach((t) => { if (t.properties.id === exceptId) return; (t.geometry.coordinates || []).forEach((c) => out.push(c)); });
  return out;
}
function nearestVertexSnap(c, targets) {
  let best = null, bd = VX_SNAP_M;
  for (const tc of targets) { const d = hav(c, tc); if (d < bd) { bd = d; best = tc; } }
  return best;
}
// Distancia (m) de p al segmento a-b (proyección local plana).
function segDistM(a, b, p) {
  const lat0 = a[1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
  const bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * ky, px = (p[0] - a[0]) * kx, py = (p[1] - a[1]) * ky;
  const len2 = bx * bx + by * by || 1;
  let t = (px * bx + py * by) / len2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(t * bx - px, t * by - py);
}
function nearestSegmentInsert(cs, p, maxM) {
  let best = -1, bd = maxM;
  for (let i = 1; i < cs.length; i++) { const d = segDistM(cs[i - 1], cs[i], p); if (d < bd) { bd = d; best = i; } }
  return best;   // índice donde insertar (después de cs[best-1])
}
function vxRedraw() {
  const map = CTX.map, cs = vedit.coords;
  if (map.getSource('admin-draw')) map.getSource('admin-draw').setData({ type: 'FeatureCollection', features: cs.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: cs } }] : [] });
}
function vxRebuildMarkers() {
  const map = CTX.map;
  vedit.markers.forEach((m) => m.remove());
  vedit.markers = vedit.coords.map((c, i) => {
    const el = makeHandleEl('vx-big' + (i === 0 ? ' vx-start' : i === vedit.coords.length - 1 ? ' vx-end' : '') + (vedit.delMode ? ' vx-del' : ''));
    const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(c).addTo(map);
    m.on('drag', () => { const ll = m.getLngLat(); vedit.coords[i] = [ll.lng, ll.lat]; vxRedraw(); });
    m.on('dragend', () => {
      const ll = m.getLngLat(); let cc = [ll.lng, ll.lat];
      const snap = nearestVertexSnap(cc, otherTrailVertices(vedit.id));
      if (snap) { cc = [snap[0], snap[1]]; m.setLngLat(cc); CTX.toast('🔗 Conectado a otro sendero'); }
      vedit.coords[i] = cc; vxRedraw();
    });
    el.addEventListener('click', (ev) => { if (vedit.delMode) { ev.stopPropagation(); vxRemoveVertex(i); } });
    el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); ev.preventDefault(); vxRemoveVertex(i); });
    return m;
  });
}
function vxRemoveVertex(i) {
  if (vedit.coords.length <= 2) { CTX.toast('El sendero necesita al menos 2 puntos'); return; }
  vedit.coords.splice(i, 1); vxRedraw(); vxRebuildMarkers(); updateVertexHud();
}
function startVertexEdit(id, coordsIn, onDone) {
  const map = CTX.map;
  if (!coordsIn || coordsIn.length < 2) { CTX.toast('Traza el sendero primero'); onDone(null); return; }
  if (!drawInit()) { CTX.toast('Espera a que cargue el mapa'); onDone(null); return; }
  closePanel();
  vedit = { id, coords: coordsIn.map((c) => c.slice()), markers: [], onDone, delMode: false };
  vedit.clickH = (e) => {
    if (vedit.delMode) return;
    const p = [e.lngLat.lng, e.lngLat.lat];
    const ins = nearestSegmentInsert(vedit.coords, p, VX_INSERT_M);
    if (ins >= 0) { vedit.coords.splice(ins, 0, p); vxRedraw(); vxRebuildMarkers(); updateVertexHud(); CTX.toast('➕ Vértice insertado'); }
  };
  map.on('click', vedit.clickH);
  vxRebuildMarkers(); vxRedraw();
  showVertexHud();
  CTX.toast('Arrastra los vértices; suéltalos junto a otro sendero para conectar. Toca la línea para insertar.');
}
function showVertexHud() {
  let h = document.getElementById('admin-vedit-hud');
  if (!h) { h = document.createElement('div'); h.id = 'admin-vedit-hud'; h.className = 'admin-draw-hud'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
  updateVertexHud();
}
function updateVertexHud() {
  const h = document.getElementById('admin-vedit-hud'); if (!h || !vedit) return;
  h.innerHTML = `<span class="adh-n">${vedit.coords.length} vértices</span>
    <button id="ave-del" class="${vedit.delMode ? 'adh-on' : ''}">🗑️ Borrar</button>
    <button id="ave-done" class="adh-done">✓ Terminar</button><button id="ave-cancel">✕</button>`;
  h.querySelector('#ave-del').onclick = () => { vedit.delMode = !vedit.delMode; vxRebuildMarkers(); updateVertexHud(); CTX.toast(vedit.delMode ? '🗑️ Modo borrar: toca un vértice para quitarlo' : 'Modo mover'); };
  h.querySelector('#ave-done').onclick = () => endVertexEdit(true);
  h.querySelector('#ave-cancel').onclick = () => endVertexEdit(false);
}
function endVertexEdit(keep) {
  const map = CTX.map, onDone = vedit.onDone, coords = vedit.coords.slice();
  vedit.markers.forEach((m) => m.remove());
  if (vedit.clickH) map.off('click', vedit.clickH);
  const h = document.getElementById('admin-vedit-hud'); if (h) h.remove();
  if (map.getSource('admin-draw')) map.getSource('admin-draw').setData({ type: 'FeatureCollection', features: [] });
  vedit = null;
  openPanel();
  onDone(keep && coords.length > 1 ? coords : null);
}

// ============================ MODO EDICIÓN (mapa ↔ menú) ============================
// Un modo persistente: seleccionas una feature en el mapa (o en la lista) y la
// editas espacialmente sin cerrar el panel. Punto → arrastrar/conectar; sendero →
// vértices (mover/añadir-desde-vértice/insertar/borrar/snap); recorrido → tocar
// senderos para componer. La lista de la derecha refleja la selección.
let editMode = false, editSel = null, editHandles = [], editActiveVx = -1, editAddMode = null, editCutMode = false, editExtendMode = false;
// Consulta senderos con TOLERANCIA (bbox de ~11 px): la línea es delgada y así es
// mucho más fácil tocarla/seleccionarla y resaltarla al pasar el cursor.
function queryTrailsAt(pt) {
  const map = CTX.map; if (!map || !map.getLayer('trails-all')) return [];
  const r = 11, bbox = [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]];
  try { return map.queryRenderedFeatures(bbox, { layers: ['trails-all'] }); } catch (e) { return []; }
}
const tabForKind = (k) => ({ punto: 'puntos', sendero: 'senderos', recorrido: 'recorridos' }[k] || 'puntos');
const allWaypointCoords = () => (CTX.state.waypoints || []).map((w) => w.geometry.coordinates);
const allTrailVertices = () => { const o = []; (CTX.state.trails || []).forEach((t) => (t.geometry.coordinates || []).forEach((c) => o.push(c))); return o; };
function clearHandleMarkers() { editHandles.forEach((m) => m.remove()); editHandles = []; }
// Manija = área de toque grande transparente con un punto visible pequeño dentro.
function makeHandleEl(cls) { const el = document.createElement('div'); el.className = 'vx-handle' + (cls ? ' ' + cls : ''); el.innerHTML = '<span class="vxd"></span>'; return el; }
function clearEditHandles() { clearHandleMarkers(); editActiveVx = -1; try { clearHighlight(); } catch (e) { /* estilo */ } }

export function isEditMode() { return editMode; }
function toggleEditMode(on) {
  editMode = on != null ? on : !editMode;
  document.body.classList.toggle('edit-mode', editMode);
  panelEl().classList.toggle('as-sheet', editMode);
  const map = CTX.map;
  if (editMode) {
    if (map) { map.on('click', editMapClick); map.on('mousemove', editMapMove); }
  } else {
    if (map) { map.off('click', editMapClick); map.off('mousemove', editMapMove); map.getCanvas().style.cursor = ''; }
    try { clearHover(); } catch (e) { /* estilo transitorio */ }
    clearEditHandles(); editSel = null; editAddMode = null; editCutMode = false; hideEditBar();
  }
  renderPanel();
}
// Resalta (glow) el sendero bajo el cursor y pone cursor de mano sobre features.
function editMapMove(e) {
  const map = CTX.map; if (!map) return;
  const wpL = ['waypoints-pt', 'trees-pt'].filter((l) => map.getLayer(l));
  const overPt = wpL.length && map.queryRenderedFeatures(e.point, { layers: wpL }).length;
  if (overPt) { map.getCanvas().style.cursor = 'pointer'; try { clearHover(); } catch (er) { /* */ } return; }
  const tf = queryTrailsAt(e.point);   // área ancha alrededor de la línea
  const tid = tf.length ? tf[0].properties.id : null;
  map.getCanvas().style.cursor = tid ? 'pointer' : (editCutMode || editExtendMode ? 'crosshair' : '');
  try { setHover(tid); } catch (er) { /* fuente transitoria */ }
}
function editDeselect() { editSel = null; editActiveVx = -1; editCutMode = false; editExtendMode = false; clearEditHandles(); markSelectedRow(null); hideEditBar(); }

function editMapClick(e) {
  const map = CTX.map, p = [e.lngLat.lng, e.lngLat.lat];
  if (editCutMode && editSel && editSel.kind === 'sendero') { editCutAt(p); return; }        // cortar
  if (editExtendMode && editSel && editSel.kind === 'sendero') { editExtendAppend(p); return; } // extender (dibujar)
  if (editAddMode === 'punto') { editAddMode = null; startNewPointAt(p); return; }
  if (editSel && editSel.kind === 'recorrido') {   // componer recorrido tocando senderos
    const tf = queryTrailsAt(e.point);
    if (tf.length) { editRouteToggleTrail(editSel.id, tf[0].properties.id); return; }
    editDeselect(); return;
  }
  // puntos primero
  const wpL = ['waypoints-pt', 'trees-pt'].filter((l) => map.getLayer(l));
  const pf = wpL.length ? map.queryRenderedFeatures(e.point, { layers: wpL }) : [];
  if (pf.length) { editSelect('punto', pf[0].properties.id); return; }
  // senderos (área ancha): si es el ya seleccionado y tocas su línea → insertar vértice
  const tf = queryTrailsAt(e.point);
  if (tf.length) {
    const tid = tf[0].properties.id;
    if (editSel && editSel.kind === 'sendero' && tid === editSel.id) {
      const tr = trailFeat(tid), ins = tr ? nearestSegmentInsert(tr.geometry.coordinates, p, 40) : -1;
      if (ins >= 0) { editTrailSplice(tid, ins, p); CTX.toast('➕ Vértice insertado en la línea'); return; }
    }
    editSelect('sendero', tid); return;
  }
  editDeselect();
}
// Extender DESDE el vértice seleccionado: crea el segmento (vértice→nuevo punto).
// - Si el vértice es un extremo → crece ese sendero por ahí.
// - Si es un vértice del medio → nace una RAMA (sendero nuevo) conectada en él
//   (un LineString no puede bifurcarse; la red se arma con senderos que comparten
//   vértice). Sin selección → extiende por el último vértice.
// Se engancha (snap) si el nuevo punto cae cerca de otro punto/sendero.
function editExtendAppend(p) {
  const id = editSel.id, tr = trailFeat(id); if (!tr) return;
  const c = tr.geometry.coordinates.slice();
  let q = p; const snap = nearestVertexSnap(p, otherTrailVertices(id).concat(allWaypointCoords()));
  if (snap) q = [snap[0], snap[1]];
  let i = editActiveVx; if (i < 0) i = c.length - 1;   // sin vértice activo → desde el último
  if (i === c.length - 1) { c.push(q); editActiveVx = c.length - 1; persistTrailGeom(id, c); if (snap) CTX.toast('🔗 Conectado'); }
  else if (i === 0) { c.unshift(q); editActiveVx = 0; persistTrailGeom(id, c); if (snap) CTX.toast('🔗 Conectado'); }
  else {
    const V = c[i].slice(), newId = rid('sendero');
    const row = { id: newId, name: tr.properties.name ? tr.properties.name + ' (rama)' : null, routes: (tr.properties.routes || []).slice(), geometry: [V, q] };
    CTX.applyLocalRow('trails', row); saveRow('trails', row).catch((e) => CTX.toast(friendlyErr(e)));
    editSelect('sendero', newId); editExtendMode = true; editActiveVx = 1; renderTrailHandles(newId); updateEditBar();
    CTX.toast('➕ Rama nueva conectada al vértice — sigue tocando para extenderla');
  }
}

function editSelect(kind, id) {
  editSel = { kind, id }; editActiveVx = -1; editCutMode = false; editExtendMode = false; _selId = id;
  if (tab !== tabForKind(kind)) { tab = tabForKind(kind); renderPanel(); }   // lleva la lista al tipo correcto
  renderEditSelection();
  markSelectedRow(id); scrollRowIntoView(id); updateEditBar();
}
function scrollRowIntoView(id) {
  const row = [...document.querySelectorAll('#admin-body .admin-row')].find((r) => r.dataset.id === id);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function renderEditSelection() {
  clearEditHandles();
  if (!editSel) return;
  if (editSel.kind === 'punto') renderPointHandle(editSel.id);
  else if (editSel.kind === 'sendero') renderTrailHandles(editSel.id);
  else if (editSel.kind === 'recorrido') renderRouteHandles(editSel.id);
}

// ---- PUNTO: arrastrar para mover + snap a sendero (conectar) ----
function renderPointHandle(id) {
  clearHandleMarkers();
  const map = CTX.map, w = CTX.state.waypoints.find((x) => x.properties.id === id); if (!w) return;
  const el = makeHandleEl('vx-point');
  const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(w.geometry.coordinates).addTo(map);
  m.on('dragend', () => {
    const ll = m.getLngLat(); let c = [ll.lng, ll.lat];
    const snap = nearestVertexSnap(c, allTrailVertices());   // conectar el punto a un sendero
    if (snap) { c = [snap[0], snap[1]]; m.setLngLat(c); CTX.toast('🔗 Punto conectado a un sendero'); }
    persistPointCoords(id, c);
  });
  editHandles.push(m);
  map.easeTo({ center: w.geometry.coordinates, zoom: Math.max(map.getZoom(), 17.5), duration: 500 });
}
function persistPointCoords(id, c) {
  const w = CTX.state.waypoints.find((x) => x.properties.id === id); if (!w) return;
  const row = wpFullRow(w); row.lng = c[0]; row.lat = c[1];
  CTX.applyLocalRow('waypoints', row);
  patchRow('waypoints', id, { lng: c[0], lat: c[1] }, () => row).catch((e) => CTX.toast(friendlyErr(e)));
}

// ---- SENDERO: manijas de vértice (mover/añadir/insertar/borrar/snap) ----
function renderTrailHandles(id) {
  clearHandleMarkers();
  const map = CTX.map, tr = trailFeat(id); if (!tr) return;
  const coords = tr.geometry.coordinates;
  setHl([{ type: 'Feature', properties: { _c: '#fab814' }, geometry: { type: 'LineString', coordinates: coords } }]);
  // Los senderos NO tienen orden (inicio/fin) — son la base cartográfica; el orden
  // vive en los recorridos. Todas las manijas iguales, salvo la activa.
  editHandles = coords.map((c, i) => {
    const el = makeHandleEl('vx-big' + (i === editActiveVx ? ' vx-active' : ''));
    const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(c).addTo(map);
    m.on('drag', () => { const ll = m.getLngLat(); coords[i] = [ll.lng, ll.lat]; setHl([{ type: 'Feature', properties: { _c: '#fab814' }, geometry: { type: 'LineString', coordinates: coords } }]); });
    m.on('dragend', () => {
      const ll = m.getLngLat(); let c2 = [ll.lng, ll.lat];
      const snap = nearestVertexSnap(c2, otherTrailVertices(id).concat(allWaypointCoords()));
      if (snap) { c2 = [snap[0], snap[1]]; m.setLngLat(c2); CTX.toast('🔗 Conectado'); }
      coords[i] = c2; persistTrailGeom(id, coords);
    });
    el.addEventListener('click', (ev) => { ev.stopPropagation(); editActiveVx = (editActiveVx === i ? -1 : i); renderTrailHandles(id); updateEditBar(); });
    el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); ev.preventDefault(); editTrailDeleteVertex(id, i); });
    return m;
  });
}
function persistTrailGeom(id, coords) {
  const tr = trailFeat(id); if (!tr) return;
  const row = { id, name: tr.properties.name || null, routes: (tr.properties.routes || []).slice(), geometry: coords.slice() };
  CTX.applyLocalRow('trails', row);
  saveRow('trails', row).catch((e) => CTX.toast(friendlyErr(e)));
  renderTrailHandles(id);
}
function editTrailSplice(id, at, p) { const tr = trailFeat(id); if (!tr) return; const c = tr.geometry.coordinates.slice(); c.splice(at, 0, p); editActiveVx = at; persistTrailGeom(id, c); }
function editTrailDeleteVertex(id, i) {
  const tr = trailFeat(id); if (!tr) return; const c = tr.geometry.coordinates.slice();
  if (c.length <= 2) { CTX.toast('El sendero necesita al menos 2 puntos'); return; }
  c.splice(i, 1); if (editActiveVx >= c.length) editActiveVx = -1; persistTrailGeom(id, c);
}
// ---- herramientas tipo QGIS: cortar y invertir ----
// Proyección de p sobre el segmento a-b (metros locales) → punto proyectado + t (0..1).
function projectOnSeg(a, b, p) {
  const lat0 = a[1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
  const bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * ky, px = (p[0] - a[0]) * kx, py = (p[1] - a[1]) * ky;
  const len2 = bx * bx + by * by || 1;
  let t = (px * bx + py * by) / len2; t = Math.max(0, Math.min(1, t));
  const proj = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { proj, t, dist: Math.hypot(t * bx - px, t * by - py) };
}
// Segmento más cercano a p en un sendero → { segIdx, proj, dist }.
function nearestPointOnTrail(cs, p) {
  let best = { segIdx: -1, proj: null, dist: Infinity };
  for (let i = 1; i < cs.length; i++) { const r = projectOnSeg(cs[i - 1], cs[i], p); if (r.dist < best.dist) best = { segIdx: i - 1, proj: r.proj, dist: r.dist, t: r.t }; }
  return best;
}
function editCutAt(p) {
  const id = editSel.id, tr = trailFeat(id); if (!tr) return;
  const cs = tr.geometry.coordinates;
  const hit = nearestPointOnTrail(cs, p);
  if (hit.segIdx < 0 || hit.dist > 25) { CTX.toast('Toca SOBRE el sendero para cortarlo'); return; }
  const first = cs.slice(0, hit.segIdx + 1).concat([hit.proj]);
  const second = [hit.proj].concat(cs.slice(hit.segIdx + 1));
  if (first.length < 2 || second.length < 2) { CTX.toast('El corte quedó muy cerca de un extremo'); return; }
  const routes = (tr.properties.routes || []).slice(), name = tr.properties.name || null;
  const row1 = { id, name, routes, geometry: first };
  const newId = rid('sendero');
  const row2 = { id: newId, name: name ? name + ' (2)' : null, routes, geometry: second };
  CTX.applyLocalRow('trails', row1); saveRow('trails', row1).catch((e) => CTX.toast(friendlyErr(e)));
  CTX.applyLocalRow('trails', row2); saveRow('trails', row2).catch((e) => CTX.toast(friendlyErr(e)));
  editCutMode = false;
  CTX.toast('✂️ Sendero cortado en dos');
  renderPanel(); editSelect('sendero', id);
}

// ---- RECORRIDO: tocar senderos para agregar/quitar (orden = toques) ----
function renderRouteHandles(id) {
  const r = CTX.state.routesById[id]; if (!r) return;
  highlightSegments((r.segments || []), r.color || '#fab814');
}
function routeFullRow(r) {
  return { id: r.id, name: r.name || null, name_en: r.name_en || null, emoji: r.emoji || null, color: r.color || null,
    summary: r.summary || null, summary_en: r.summary_en || null, start_id: r.start_id || null, end_id: r.end_id || null,
    segments: (r.segments || []).slice(), sort: r.sort || 0 };
}
function editRouteToggleTrail(routeId, trailId) {
  const r = CTX.state.routesById[routeId]; if (!r) return;
  const segs = (r.segments || []).slice(), i = segs.indexOf(trailId);
  if (i >= 0) segs.splice(i, 1); else segs.push(trailId);
  const row = routeFullRow({ ...r, segments: segs });
  CTX.applyLocalRow('routes', row);
  saveRow('routes', row).catch((e) => CTX.toast(friendlyErr(e)));
  renderRouteHandles(routeId); updateEditBar();
}

// ---- crear un punto tocando el mapa ----
function startNewPointAt(p) {
  _pointDraft = { id: rid('punto'), _new: true, loc: p, photoBlob: null, leafBlob: null,
    props: { id: rid('punto'), routes: [], species_ids: [], tipo: 'punto' } };
  tab = 'puntos'; renderPanel(); editPunto(null);
  CTX.toast('Punto ubicado. Ponle nombre y guarda.');
}

// ---- barra de acción contextual (abajo) ----
function hideEditBar() { const h = document.getElementById('edit-bar'); if (h) h.remove(); }
function updateEditBar() {
  if (!editMode || !editSel) { hideEditBar(); return; }
  let h = document.getElementById('edit-bar');
  if (!h) { h = document.createElement('div'); h.id = 'edit-bar'; h.className = 'admin-draw-hud edit-bar'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
  const k = editSel.kind;
  const mode = editCutMode ? ' · corte' : editExtendMode ? ' · extendiendo' : editActiveVx >= 0 ? ` · vértice ${editActiveVx + 1}` : '';
  const label = k === 'punto' ? '📍 Punto' : k === 'sendero' ? `✎ Sendero${mode}` : '🧭 Recorrido';
  h.innerHTML = `<span class="adh-n">${label}</span>
    <button id="eb-data">Datos</button>
    ${k === 'sendero' ? `<button id="eb-ext" class="${editExtendMode ? 'adh-on' : ''}">➕ Extender</button><button id="eb-cut" class="${editCutMode ? 'adh-on' : ''}">✂️ Cortar</button>` : ''}
    ${k === 'sendero' && editActiveVx >= 0 ? '<button id="eb-del">🗑️ Vértice</button>' : ''}
    <button id="eb-close">✕</button>`;
  const dataBtn = h.querySelector('#eb-data');
  if (dataBtn) dataBtn.onclick = () => { hideEditBar(); const id = editSel.id; if (k === 'punto') editPunto(id); else if (k === 'sendero') editSendero(id); else editRecorrido(id); };
  const ext = h.querySelector('#eb-ext'); if (ext) ext.onclick = () => { editExtendMode = !editExtendMode; editCutMode = false; updateEditBar(); CTX.toast(editExtendMode ? '➕ Toca un vértice y luego el mapa para extender desde ahí (un vértice del medio crea una rama).' : 'Extender: listo'); };
  const cut = h.querySelector('#eb-cut'); if (cut) cut.onclick = () => { editCutMode = !editCutMode; editExtendMode = false; updateEditBar(); CTX.toast(editCutMode ? '✂️ Toca sobre el sendero donde quieres cortarlo' : 'Corte cancelado'); };
  const del = h.querySelector('#eb-del'); if (del) del.onclick = () => editTrailDeleteVertex(editSel.id, editActiveVx);
  h.querySelector('#eb-close').onclick = editDeselect;
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
      // Glow ancho bajo el cursor: banda amplia alrededor de la línea para que sea
      // obvio qué sendero se va a seleccionar (y refuerza el área de toque ancha).
      map.addLayer({ id: 'admin-hover-glow', type: 'line', source: 'admin-hover',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fab814', 'line-width': 22, 'line-opacity': 0.35, 'line-blur': 3 } });
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

// ---------------- elegir punto de inicio/fin (click) y intermedios (recuadro) ----------------
let ptPickHandler = null, marquee = null;
function ptHud(text, onCancel) {
  let h = document.getElementById('admin-ptpick-hud');
  if (!h) { h = document.createElement('div'); h.id = 'admin-ptpick-hud'; h.className = 'admin-draw-hud'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
  h.innerHTML = `<span class="adh-n">${text}</span><button id="ptp-cancel">✕</button>`;
  h.querySelector('#ptp-cancel').onclick = onCancel;
}
function pickRoutePoint(id, kind) {
  const map = CTX.map;
  closePanel();
  map.getCanvas().style.cursor = 'crosshair';
  ptHud(kind === 'start' ? '📍 Toca el punto de INICIO' : '🏁 Toca el punto de FIN', () => finishPtPick(id));
  ptPickHandler = (e) => {
    const layers = ['waypoints-pt', 'trees-pt'].filter((l) => map.getLayer(l));
    const f = map.queryRenderedFeatures(e.point, { layers });
    if (!f.length) return;   // hay que tocar un punto
    const pid = f[0].properties.id;
    if (_routeDraft) {
      if (kind === 'start') _routeDraft.start_id = pid; else _routeDraft.end_id = pid;
      _routeDraft.memberPoints = [...new Set([...(_routeDraft.memberPoints || []), pid])];
    }
    finishPtPick(id);
  };
  map.on('click', ptPickHandler);
}
function finishPtPick(id) {
  const map = CTX.map;
  if (ptPickHandler) { map.off('click', ptPickHandler); ptPickHandler = null; }
  map.getCanvas().style.cursor = '';
  const h = document.getElementById('admin-ptpick-hud'); if (h) h.remove();
  openPanel(); editRecorrido(id);
}
// Selección por recuadro (marquee) de puntos intermedios — como seleccionar archivos.
function marqueePoints(id) {
  const map = CTX.map;
  closePanel();
  map.dragPan.disable();
  const canvasEl = map.getCanvas();
  const box = document.createElement('div'); box.className = 'marquee-box'; box.style.display = 'none'; document.body.appendChild(box);
  ptHud('▦ Arrastra un recuadro sobre los puntos', () => endMarquee(id, null));
  let start = null;
  const pt = (e) => { const t = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0]) || e; return { x: t.clientX, y: t.clientY }; };
  const down = (e) => { start = pt(e); box.style.display = 'block'; if (e.cancelable) e.preventDefault(); };
  const move = (e) => { if (!start) return; const p = pt(e); const x1 = Math.min(start.x, p.x), y1 = Math.min(start.y, p.y);
    box.style.left = x1 + 'px'; box.style.top = y1 + 'px'; box.style.width = Math.abs(p.x - start.x) + 'px'; box.style.height = Math.abs(p.y - start.y) + 'px'; if (e.cancelable) e.preventDefault(); };
  const up = (e) => {
    if (!start) { endMarquee(id, null); return; }
    const p = pt(e), r = canvasEl.getBoundingClientRect();
    const a = [start.x - r.left, start.y - r.top], b = [p.x - r.left, p.y - r.top];
    const bbox = [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
    let ids = [];
    const layers = ['waypoints-pt', 'trees-pt'].filter((l) => map.getLayer(l));
    try { ids = [...new Set(map.queryRenderedFeatures(bbox, { layers }).map((f) => f.properties.id))]; } catch (er) { /* bbox degenerado */ }
    endMarquee(id, ids);
  };
  marquee = { down, move, up, box, canvasEl };
  canvasEl.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  canvasEl.addEventListener('touchstart', down, { passive: false }); window.addEventListener('touchmove', move, { passive: false }); window.addEventListener('touchend', up);
}
function endMarquee(id, ids) {
  const map = CTX.map;
  if (marquee) {
    const m = marquee; marquee = null;
    m.canvasEl.removeEventListener('mousedown', m.down); window.removeEventListener('mousemove', m.move); window.removeEventListener('mouseup', m.up);
    m.canvasEl.removeEventListener('touchstart', m.down); window.removeEventListener('touchmove', m.move); window.removeEventListener('touchend', m.up);
    m.box.remove();
  }
  map.dragPan.enable();
  const h = document.getElementById('admin-ptpick-hud'); if (h) h.remove();
  if (ids && ids.length && _routeDraft) {
    _routeDraft.memberPoints = [...new Set([...(_routeDraft.memberPoints || []), ...ids])];
    CTX.toast(`▦ ${ids.length} punto(s) añadidos al recorrido`);
  }
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
    <input class="admin-search" placeholder="🔎 Buscar sendero… (toca para verlo en el mapa)">
    <div class="admin-list">${trails.map((tr) => `
      <div class="admin-row" data-id="${esc(tr.properties.id)}">
        <span class="admin-row-t">${esc(tr.properties.name || tr.properties.id)} <i>${esc((tr.properties.routes || []).join(', '))}</i></span>
        <button class="admin-edit" data-id="${esc(tr.properties.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#tr-add').onclick = () => editSendero(null);
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = (e) => { e.stopPropagation(); editSendero(b.dataset.id); });
  wireList('sendero');
  if (_selId) markSelectedRow(_selId);
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
          ${coords && coords.length > 1 ? '<button type="button" class="admin-pick" id="tr-vedit">✎ Editar vértices</button>' : ''}
        </div>
      </div>
      ${coords && coords.length > 1 ? '<div class="admin-note">Editar vértices: arrastra un punto para moverlo; suéltalo junto a otro sendero para conectarlos. Toca la línea para insertar un vértice; usa 🗑️ para borrar.</div>' : ''}
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
  const tve = body.querySelector('#tr-vedit');
  if (tve) tve.onclick = () => { saveDraft(); startVertexEdit(p.id, coords, (c) => { if (c) CTX._draftLine = c; editSendero(id); }); };
  body.querySelector('#tr-cancel').onclick = renderSenderos;
  if (id) body.querySelector('#tr-del').onclick = async () => {
    // Avisar si el sendero es parte de recorridos: quedarían con un hueco.
    const usedIn = CTX.state.routes.filter((r) => (r.segments || []).includes(id)).map((r) => CTX.L(r, 'name') || r.id);
    const q = usedIn.length
      ? `Este sendero es parte de: ${usedIn.join(', ')}. Si lo eliminas, esos recorridos quedarán incompletos. ¿Eliminarlo igualmente?`
      : '¿Eliminar este sendero?';
    if (!confirm(q)) return;
    try {
      const res = await deleteRow('trails', id);
      CTX.removeLocalRow('trails', id); renderSenderos();
      CTX.toast(res.queued ? '💾 Eliminado — se sincronizará con señal' : 'Sendero eliminado');
    } catch (e) { body.querySelector('#tr-err').textContent = friendlyErr(e); }
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
    } catch (e) { body.querySelector('#tr-err').textContent = friendlyErr(e); }
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
    <input class="admin-search" placeholder="🔎 Buscar recorrido… (toca para verlo en el mapa)">
    <div class="admin-list">${routes.map((r) => `
      <div class="admin-row" data-id="${esc(r.id)}">
        <span class="admin-dot" style="background:${r.color || '#888'}"></span>
        <span class="admin-row-t">${r.emoji || ''} ${esc(CTX.L(r, 'name') || r.id)}</span>
        <button class="admin-edit" data-id="${esc(r.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#rt-add').onclick = () => editRecorrido(null);
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = (e) => { e.stopPropagation(); editRecorrido(b.dataset.id); });
  wireList('recorrido');
  if (_selId) markSelectedRow(_selId);
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
  // Puntos del recorrido: inicio, fin e intermedios (por membresía point.routes).
  let startId = r.start_id || null, endId = r.end_id || null;
  let memberWork = new Set(Array.isArray(r.memberPoints) ? r.memberPoints
    : CTX.state.waypoints.filter((w) => (w.properties.routes || []).includes(r.id)).map((w) => w.properties.id));
  if (startId) memberWork.add(startId);
  if (endId) memberWork.add(endId);
  const wpTitle = (pid) => { const w = CTX.state.waypoints.find((x) => x.properties.id === pid); return w ? (CTX.L(w.properties, 'title') || w.properties.title || pid) : pid; };
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
      <button type="button" class="admin-pick map-pick" id="rt-pick">🗺️ Elegir senderos en el mapa</button>
      <div id="rt-segs"></div>
      <label>Punto de inicio</label>
      <div class="admin-loc"><span id="rt-start-lbl">${startId ? esc(wpTitle(startId)) : 'sin fijar'}</span>
        <button type="button" class="admin-pick" id="rt-start-pick">📍 Elegir en el mapa</button></div>
      <label>Punto de fin</label>
      <div class="admin-loc"><span id="rt-end-lbl">${endId ? esc(wpTitle(endId)) : 'sin fijar'}</span>
        <button type="button" class="admin-pick" id="rt-end-pick">🏁 Elegir en el mapa</button></div>
      <label>Puntos del recorrido</label>
      <div class="admin-loc"><span id="rt-mem-lbl">${memberWork.size} punto(s)</span>
        <div class="admin-loc-btns">
          <button type="button" class="admin-pick" id="rt-mem-pick">▦ Recuadro en el mapa</button>
          <button type="button" class="admin-pick" id="rt-mem-clear">Limpiar</button>
        </div></div>
      <div class="admin-note">Inicio y fin: toca un punto. Intermedios: arrastra un recuadro sobre el mapa. Se ordenan solos según el recorrido.</div>
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
    start_id: startId, end_id: endId, memberPoints: [...memberWork],
    segments: segWork.slice() }; };
  body.querySelector('#rt-pick').onclick = () => { saveDraft(); startRoutePick(id); };
  body.querySelector('#rt-start-pick').onclick = () => { saveDraft(); pickRoutePoint(id, 'start'); };
  body.querySelector('#rt-end-pick').onclick = () => { saveDraft(); pickRoutePoint(id, 'end'); };
  body.querySelector('#rt-mem-pick').onclick = () => { saveDraft(); marqueePoints(id); };
  body.querySelector('#rt-mem-clear').onclick = () => { memberWork.clear(); if (startId) memberWork.add(startId); if (endId) memberWork.add(endId); document.getElementById('rt-mem-lbl').textContent = `${memberWork.size} punto(s)`; };
  body.querySelector('#rt-cancel').onclick = () => { clearHighlight(); renderRecorridos(); };
  if (id) body.querySelector('#rt-del').onclick = async () => {
    if (!confirm('¿Eliminar este recorrido?')) return;
    try {
      const res = await deleteRow('routes', id);
      CTX.removeLocalRow('routes', id); renderRecorridos();
      CTX.toast(res.queued ? '💾 Eliminado — se sincronizará con señal' : 'Recorrido eliminado');
    } catch (e) { body.querySelector('#rt-err').textContent = friendlyErr(e); }
  };
  body.querySelector('#rt-save').onclick = async () => {
    const row = { id: r.id, name: body.querySelector('#rt-name').value.trim() || null, name_en: body.querySelector('#rt-name-en').value.trim() || null,
      emoji, color, summary: body.querySelector('#rt-sum').value.trim() || null, summary_en: body.querySelector('#rt-sum-en').value.trim() || null,
      start_id: startId || null, end_id: endId || null,
      segments: segWork, sort: r.sort || 0 };
    body.querySelector('#rt-err').textContent = 'Guardando…';
    try {
      const res = await saveRow('routes', row);
      CTX.applyLocalRow('routes', row);
      await applyMembership(r.id, memberWork);   // añade/quita este recorrido en los puntos elegidos
      clearHighlight(); renderRecorridos();
      CTX.toast(res.queued ? '💾 Recorrido guardado en el teléfono — se subirá con señal' : 'Recorrido guardado');
    } catch (e) { body.querySelector('#rt-err').textContent = friendlyErr(e); }
  };
}

// Aplica la membresía de un recorrido: pone/quita el recorrido en la lista
// `routes` de los puntos elegidos (upsert por punto, offline incluido).
const wpFullRow = (w) => { const p = w.properties, c = w.geometry.coordinates; return {
  id: p.id, title: p.title || null, title_en: p.title_en || null, description: p.description || null,
  description_en: p.description_en || null, tipo: p.tipo || 'punto', routes: (p.routes || []).slice(),
  species_ids: (p.species_ids || []).slice(), lng: c[0], lat: c[1], photo: p.photo || null, photo_leaf: p.photo_leaf || null }; };
async function applyMembership(routeId, memberSet) {
  const changed = [];
  for (const w of CTX.state.waypoints) {
    const pid = w.properties.id, has = (w.properties.routes || []).includes(routeId), want = memberSet.has(pid);
    if (has === want) continue;
    const row = wpFullRow(w);
    row.routes = want ? [...new Set([...row.routes, routeId])] : row.routes.filter((x) => x !== routeId);
    changed.push(row);
  }
  for (const row of changed) {
    try { const res = await saveRow('waypoints', row); CTX.applyLocalRow('waypoints', res.row); }
    catch (e) { console.warn('[membership]', e && e.message); }
  }
}

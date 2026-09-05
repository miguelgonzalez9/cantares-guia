// Cantares — editor de administrador (sin código). Permite a los dueños añadir y
// cambiar puntos del mapa, textos, imágenes y especies del inventario, escribiendo
// directo a Supabase. Sólo se activa para cuentas con rol 'admin'.
import { isAdmin } from './cloud.js';
import { saveRow, deleteRow, compressImage, patchRow } from './sync.js';
import { coverageGaps, readCatalog, buildEntries, fromFiles, fromDropbox, planByFolder,
  countByFolder, uploadSample, dropAlreadyThere } from './archive-intake.js';
import * as Dbx from './dropbox.js';
import { keepAwake, releaseAwake } from './wakelock.js';
import { maybeStartAdminGuide } from './guide.js';

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
  if (CTX.makeDraggable) CTX.makeDraggable(fab, fab, 'cantares_pos_admin', openAdmin);
  else fab.onclick = openAdmin;
}
// Tocar 🛠️: abre el panel Y activa el modo edición de una vez (sin doble tap).
function openAdmin() { openPanel(); if (!editMode) toggleEditMode(true); }
// Abre el editor de un punto desde el mapa (botón «Editar» del popup).
export function openPointEditor(id) {
  if (!CTX) return;
  openPanel(); if (!editMode) toggleEditMode(true);
  tab = 'puntos'; renderPanel(); editPunto(id);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---- cámara directa (registrar un punto en campo sin pasar por la galería) ----
// `capture="environment"` abre la cámara trasera del teléfono; es una función
// nativa del navegador, no hace falta getUserMedia ni un visor propio. En
// escritorio el atributo se ignora y cae al selector de archivos de siempre.
// El input oculto comparte el `onchange` del de galería, así la foto sigue el
// mismo camino (comprimir → cola offline) sin duplicar lógica.
function camControls(inputId) {
  return `<button type="button" class="admin-pick cam-btn" id="${inputId}-cam">📷 Tomar foto</button>
    <input type="file" id="${inputId}-cap" accept="image/*" capture="environment" hidden>`;
}
function wireCamera(root, inputId, onFile) {
  const gal = root.querySelector('#' + inputId);
  const cap = root.querySelector('#' + inputId + '-cap');
  const btn = root.querySelector('#' + inputId + '-cam');
  if (gal) gal.onchange = onFile;
  if (cap) cap.onchange = onFile;
  if (btn) btn.onclick = () => cap && cap.click();
}

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

// ---- selector con búsqueda (listas largas de edición) ----------------------
// Orden alfabético + filtro por subcadena. Mismo patrón y mismas clases que el
// selector de sujeto de la bandeja de Fotos, que ya funcionaba así: un <select>
// de 60 senderos es imposible de usar con el pulgar. La lista aparece al enfocar
// y se cierra al elegir.
function pickerHTML(id, placeholder) {
  return `<input class="admin-search" id="${id}-q" placeholder="${esc(placeholder)}">
    <div class="fm-assign-list hidden" id="${id}-list"></div>`;
}
function wirePicker(root, id, items, onPick) {
  const q = root.querySelector('#' + id + '-q'), box = root.querySelector('#' + id + '-list');
  if (!q || !box) return;
  const sorted = items.slice().sort((a, b) => String(a.label).localeCompare(String(b.label), 'es'));
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    const hits = sorted.filter((it) => !s || String(it.label).toLowerCase().includes(s));
    box.classList.remove('hidden');
    box.innerHTML = hits.length
      ? hits.map((it) => `<button type="button" class="fm-assign-item" data-id="${esc(it.id)}"><b>${esc(it.label)}</b></button>`).join('')
      : '<div class="admin-note">Sin coincidencias</div>';
    box.querySelectorAll('.fm-assign-item').forEach((b) => b.onclick = () => { q.value = ''; box.classList.add('hidden'); onPick(b.dataset.id); });
  };
  q.oninput = draw;
  q.onfocus = draw;
}

function panelEl() {
  let el = document.getElementById('admin-panel');
  if (!el) { el = document.createElement('div'); el.id = 'admin-panel'; el.className = 'admin-panel hidden'; document.body.appendChild(el); }
  return el;
}
let tab = 'puntos';
function openPanel() {
  renderPanel(); panelEl().classList.remove('hidden'); document.body.classList.add('admin-open');
  if (CTX.pushBack) CTX.pushBack('admin', closePanel);   // atrás cierra el panel, no la app
  maybeStartAdminGuide();          // la primera vez, la guía se presenta sola
}

// Puerta para la guía: deja el panel en la pestaña y el modo que pide un tema.
// `edit` decide además la FORMA del panel en el teléfono — con el modo edición
// encendido es una hoja de 46vh y deja ver el mapa; apagado tapa la pantalla.
export async function openAdminAt(tabName, { edit = true } = {}) {
  if (!CTX) return;
  if (tabName) tab = tabName;
  if (panelEl().classList.contains('hidden')) openPanel();
  if (editMode !== edit) toggleEditMode(edit); else renderPanel();
}
export function closeAdmin() { if (!panelEl().classList.contains('hidden')) closePanel(); }
function closePanel() {
  if (CTX.popBack) CTX.popBack('admin');
  panelEl().classList.add('hidden'); document.body.classList.remove('admin-open');
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
        <button class="admin-x" id="admin-x" aria-label="Cerrar">×</button>
      </div>
    </div>
    <div class="admin-tabs">
      <button class="admin-tab ${tab === 'puntos' ? 'sel' : ''}" data-t="puntos">Puntos</button>
      <button class="admin-tab ${tab === 'senderos' ? 'sel' : ''}" data-t="senderos">Senderos</button>
      <button class="admin-tab ${tab === 'recorridos' ? 'sel' : ''}" data-t="recorridos">Recorridos</button>
      <button class="admin-tab ${tab === 'fotos' ? 'sel' : ''}" data-t="fotos">🖼️ Fotos${unclassifiedCount() ? ` <span class="fm-badge">${unclassifiedCount()}</span>` : ''}</button>
    </div>
    <div class="admin-note" style="margin:6px 10px 0">Las especies se editan en la pestaña 🦋 Especies.</div>
    <div class="admin-body" id="admin-body"></div>`;
  if (tab === 'especies') tab = 'puntos';   // las especies ya no viven en el panel
  el.querySelector('#admin-x').onclick = () => { if (editMode) toggleEditMode(false); closePanel(); };
  el.querySelector('#admin-edit').onclick = () => toggleEditMode();
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
    <div class="admin-loc-btns" style="margin-bottom:6px">
      <button class="admin-add" id="pt-add" style="flex:1">＋ Nuevo punto</button>
      <button class="admin-pick" id="pt-types">🎨 Tipos de punto</button>
    </div>
    <input class="admin-search" placeholder="🔎 Buscar punto… (toca para verlo en el mapa)">
    <div class="admin-list">${pts.map((w) => `
      <div class="admin-row" data-id="${esc(w.properties.id)}">
        <span class="admin-dot" style="background:${CTX.typeColor(w.properties.tipo)}"></span>
        <span class="admin-row-t">${esc(CTX.L(w.properties, 'title') || w.properties.title)}</span>
        <button class="admin-edit" data-id="${esc(w.properties.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#pt-add').onclick = () => editPunto(null);
  body.querySelector('#pt-types').onclick = editTipos;
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = (e) => { e.stopPropagation(); editPunto(b.dataset.id); });
  wireList('punto');
  if (_selId) markSelectedRow(_selId);
}

// Editor de tipos de punto: color, emoji y nombre (ES/EN) de cada tipo. Comparte
// base con la leyenda y el mapa (TYPE_META); editar un tipo base lo sobrescribe
// vía la tabla point_types (la nube manda por id). Sincroniza entre dispositivos.
function editTipos() {
  const body = document.getElementById('admin-body');
  const types = CTX.pointTypes ? CTX.pointTypes() : [];
  body.innerHTML = `
    <div class="admin-form">
      <button class="admin-cancel" id="tp-back">← Volver a puntos</button>
      <div class="admin-note">Cambia el color, símbolo y nombre de cada tipo. Se refleja en el mapa, la leyenda y el editor de puntos, y se sincroniza entre dispositivos.</div>
      <div class="admin-list">${types.map((tp) => `
        <div class="admin-typerow" data-id="${esc(tp.tipo)}">
          <input class="tp-emoji" value="${esc(tp.emoji)}" maxlength="4" title="Símbolo">
          <input class="tp-color" type="color" value="${esc(tp.color)}" title="Color del pin">
          <div class="tp-names">
            <input class="tp-es" value="${esc(tp.es || tp.label)}" placeholder="Nombre (ES)">
            <input class="tp-en" value="${esc(tp.en || tp.es || tp.label)}" placeholder="Name (EN)">
          </div>
          <button type="button" class="admin-pick tp-save">Guardar</button>
        </div>`).join('')}</div>
    </div>`;
  body.querySelector('#tp-back').onclick = renderPuntos;
  body.querySelectorAll('.admin-typerow').forEach((rowEl) => {
    rowEl.querySelector('.tp-save').onclick = () => {
      const id = rowEl.dataset.id;
      const es = rowEl.querySelector('.tp-es').value.trim() || id;
      const row = { id, es, en: rowEl.querySelector('.tp-en').value.trim() || es,
        emoji: rowEl.querySelector('.tp-emoji').value.trim() || '📍',
        color: rowEl.querySelector('.tp-color').value || '#5b6b60' };
      if (CTX.savePointType) { CTX.savePointType(row); CTX.toast(`✓ Tipo «${es}» actualizado`); }
    };
  });
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
  body.innerHTML = `
    <div class="admin-form">
      <label>Título (ES)</label><input id="f-title" value="${esc(p.title)}">
      <label>Title (EN)</label><input id="f-title-en" value="${esc(p.title_en)}">
      <label>Descripción (ES)</label><textarea id="f-desc" rows="3">${esc(p.description)}</textarea>
      <div class="admin-note">Con descripción, foto o especies, el punto muestra el botón «Más información». Sin nada de eso, solo el título.</div>
      <label>Description (EN)</label><textarea id="f-desc-en" rows="3">${esc(p.description_en)}</textarea>
      <label>Tipo (define el color e ícono del pin)</label>
      <select id="f-tipo">${(CTX.pointTypes ? CTX.pointTypes() : []).map((tp) => `<option value="${tp.tipo}" ${p.tipo === tp.tipo ? 'selected' : ''}>${tp.emoji} ${esc(tp.label)}</option>`).join('')}<option value="__new__">➕ Nuevo tipo…</option></select>
      <div id="f-newtype" class="admin-newtype" style="display:none">
        <input id="nt-es" placeholder="Nombre del tipo (ej: Cascada)">
        <input id="nt-emoji" placeholder="💦" maxlength="4">
        <input id="nt-color" type="color" value="#2b8cbe" title="Color del pin">
        <button type="button" class="admin-pick" id="nt-create">Crear</button>
      </div>
      <label>Especies en este punto (opcional)</label>
      <input id="f-sp-search" placeholder="🔎 Buscar especie…">
      <div class="admin-checks admin-sp-list" id="f-sp-list">${speciesChecks(p.species_ids)}</div>
      <label>Foto${p.tipo === 'arbol' ? ' del árbol' : ''}</label>
      <div class="admin-photo">
        <div class="admin-photo-prev" id="f-photo-prev" style="${p.photo ? `background-image:url('${esc(p.photo)}')` : ''}"></div>
        <input type="file" id="f-photo" accept="image/*">
        ${camControls('f-photo')}
      </div>
      ${p.photo ? '<button type="button" class="admin-pick" id="f-dl">⬇️ Descargar foto</button>' : ''}
      <label>Foto de la hoja <span style="font-weight:400;color:var(--muted)">(opcional, para árboles)</span></label>
      <div class="admin-photo">
        <div class="admin-photo-prev" id="f-leaf-prev" style="${p.photo_leaf ? `background-image:url('${esc(p.photo_leaf)}')` : ''}"></div>
        <input type="file" id="f-leaf" accept="image/*">
        ${camControls('f-leaf')}
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
  wireCamera(body, 'f-leaf', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    photoLeafBlob = await compressImage(file);
    body.querySelector('#f-leaf-prev').style.backgroundImage = `url('${URL.createObjectURL(photoLeafBlob)}')`;
  });
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
  // Tipo de punto: lista unificada con la leyenda; «➕ Nuevo tipo…» crea uno al vuelo
  // (se funde en la misma base: leyenda + coloreado del mapa + editor).
  const tipoSel = body.querySelector('#f-tipo'), ntBlock = body.querySelector('#f-newtype');
  if (tipoSel && ntBlock) {
    tipoSel.onchange = () => { ntBlock.style.display = tipoSel.value === '__new__' ? 'flex' : 'none'; };
    body.querySelector('#nt-create').onclick = () => {
      const es = body.querySelector('#nt-es').value.trim();
      if (!es) { CTX.toast('Ponle un nombre al tipo'); return; }
      const emoji = body.querySelector('#nt-emoji').value.trim() || '📍';
      const color = body.querySelector('#nt-color').value || '#5b6b60';
      const tp = CTX.registerPointType && CTX.registerPointType({ tipo: es, es, en: es, emoji, color });
      if (!tp) { CTX.toast('No se pudo crear el tipo'); return; }
      const opt = document.createElement('option'); opt.value = tp; opt.textContent = `${emoji} ${es}`;
      tipoSel.insertBefore(opt, tipoSel.querySelector('option[value="__new__"]'));
      tipoSel.value = tp; ntBlock.style.display = 'none';
      CTX.toast(`✓ Tipo «${es}» creado`);
    };
  }
  // Buscador de especies: filtra la lista por nombre común o científico.
  const spSearch = body.querySelector('#f-sp-search');
  if (spSearch) spSearch.oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    body.querySelectorAll('#f-sp-list .admin-chk').forEach((lb) => {
      lb.style.display = !q || (lb.dataset.n || '').includes(q) || lb.querySelector('input').checked ? '' : 'none';
    });
  };
  const pickedRoutes = () => (p.routes || []).slice();   // se conservan: ya no se editan aqui
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
  wireCamera(body, 'f-photo', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const errEl = body.querySelector('#f-err');
    errEl.textContent = 'Preparando foto…';
    // Comprimir aquí (rápido, sin red); la subida ocurre al Guardar — y si no
    // hay señal, la foto espera en la cola offline junto con el punto.
    photoBlob = await compressImage(file);
    body.querySelector('#f-photo-prev').style.backgroundImage = `url('${URL.createObjectURL(photoBlob)}')`;
    errEl.textContent = '';
  });
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
      tipo: body.querySelector('#f-tipo').value === '__new__' ? (p.tipo || 'punto') : body.querySelector('#f-tipo').value,
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
      <label>Nota corta (gancho, 1 frase)</label><textarea id="se-notes" rows="2">${esc(s.notes)}</textarea>
      <label>Descripción técnica (ES)${s.description_source ? ` · fuente: ${esc(s.description_source)}${s.description_reviewed === false ? ' · SIN revisar' : ''}` : ''}</label>
      <textarea id="se-desc" rows="6" placeholder="Morfología, hábitat, ecología, estado de conservación…">${esc(s.description)}</textarea>
      <label>Technical description (EN)</label><textarea id="se-desc-en" rows="6" placeholder="Deja vacío para usar el español">${esc(s.description_en)}</textarea>
      <label>UICN</label>
      <select id="se-iucn">${['', 'LC', 'NT', 'VU', 'EN', 'CR', 'DD', 'NE'].map((c) => `<option value="${c}" ${(s.iucn || '') === c ? 'selected' : ''}>${c || '—'}</option>`).join('')}</select>
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
    // Descripción técnica: editarla en la app cuenta como revisión.
    const descVal = ov.querySelector('#se-desc').value.trim();
    row.description = descVal || null;
    row.description_en = ov.querySelector('#se-desc-en').value.trim() || null;
    row.iucn = ov.querySelector('#se-iucn').value || null;
    if (descVal) {
      row.description_reviewed = true;
      row.description_source = (s.description_source && s.description_source !== 'llm_draft') ? s.description_source : 'admin';
    }
    ov.querySelector('#se-err').textContent = 'Guardando…';
    try {
      const res = await saveRow('species', row, photoBlob);
      CTX.applyLocalRow('species', res.row); close(); onSaved && onSaved(res.row.id);
      CTX.toast(res.queued ? '💾 Guardada en el teléfono — se subirá con señal' : 'Especie guardada');
    } catch (err) { ov.querySelector('#se-err').textContent = friendlyErr(err); }
  };
}

// Guardar UN campo de una especie desde la edición en sitio. Vive aquí, junto al
// editor modal, para que la regla de procedencia no acabe escrita en dos sitios:
// editar la descripción en la app cuenta como revisarla, se toque donde se toque.
// La fila se manda completa (no sólo el campo) porque `upsert` crea la fila si
// todavía no existe en la nube — muchas especies sólo viven en el JSON empacado.
// ---- acciones de foto desde la FICHA de la especie (modo edición) ----
// Envuelven las mismas funciones que usa el panel de Fotos en vez de duplicarlas:
// clasificar, borrar y subir tienen que encolarse igual desde los dos sitios, y
// dos copias de un camino de escritura son dos oportunidades de perder trabajo
// de campo. Sólo se añade el `onDone` para repintar la ficha, que el panel no
// necesita.
export const mediaActions = {
  // La foto elegida pasa a portada y la que estaba baja al final de la tira:
  // el orden lo dice `sort`, así que la anterior se manda detrás de la última.
  async cover(m, speciesId, onDone) {
    const sibs = subjectMedia('species', speciesId);
    const prev = sibs.find((x) => x.is_primary && x.id !== m.id);
    await setPrimaryMedia(m);
    if (prev) {
      const maxSort = sibs.reduce((a, x) => Math.max(a, x.sort || 0), 0);
      try { const r = await saveRow('media', mediaRow(prev, { is_primary: false, sort: maxSort + 1 })); CTX.applyLocalRow('media', r.row); }
      catch (e) { /* queda en la cola */ }
    }
    if (onDone) onDone();
  },
  reclassify(m, onDone) { assignPicker(m); if (onDone) setTimeout(onDone, 0); },
  async remove(m, onDone) { await delMedia(m); if (onDone) onDone(); },
  add(speciesId, onDone) { addMedia({ type: 'species', id: speciesId }); if (onDone) setTimeout(onDone, 800); },
  // Una foto PRESTADA (de un punto linkeado, o species.photo) no es una fila de
  // `media` de esta especie: se adopta creando una fila NUEVA que apunta a la
  // MISMA url. Nunca se duplica el archivo — igual que reframeBorrow al revés.
  async adopt(m, speciesId, onDone) {
    const row = { id: rid('media'), kind: m.kind || 'photo', url: m.full, thumb: m.thumb || null,
      subject_type: 'species', subject_id: speciesId, is_primary: false, sort: Date.now() % 100000,
      focal_x: m.focal_x != null ? m.focal_x : 0.5, focal_y: m.focal_y != null ? m.focal_y : 0.5,
      caption: m.caption || null, credit: m.credit || null, source: 'admin', status: 'classified' };
    await saveMedia(row);
    if (onDone) onDone();
  },
};

export async function saveSpeciesPatch(s, patch) {
  const merged = { ...s, ...patch };
  const row = { id: s.id,
    common_name: merged.common_name || null, common_name_en: merged.common_name_en || null,
    scientific_name: merged.scientific_name || null, family: merged.family || null,
    group: editorGroup(merged), status: merged.status || 'documented',
    notes: merged.notes || null, flagship: !!merged.flagship, photo: merged.photo || null,
    description: merged.description || null, description_en: merged.description_en || null,
    iucn: merged.iucn || null };
  if ('description' in patch && row.description) {
    row.description_reviewed = true;
    row.description_source = (s.description_source && s.description_source !== 'llm_draft') ? s.description_source : 'admin';
  }
  const res = await saveRow('species', row);
  CTX.applyLocalRow('species', res.row);
  CTX.toast(res.queued ? '💾 Guardada en el teléfono — se subirá con señal' : '✓ Guardado');
  return res.row;
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
// Filtro de procedencia de la bandeja. Sin él, las fotos del archivo familiar,
// las del juego y las de visitantes se mezclan en una sola lista y no se pueden
// revisar con criterios distintos (una foto de visitante puede tener problemas
// de licencia que una del archivo no tiene).
let mediaOrigin = 'all';
// Vista «Todas»: filtros propios (estado + texto), separados del filtro de
// procedencia que ya compartía con la bandeja de sin clasificar.
let mediaStatus = 'all';   // 'all' | 'unclassified' | 'classified'
let mediaQuery = '';
const BROWSE_PAGE = 60;    // ponytail: página fija; paginar de verdad si el archivo crece mucho
let browseShown = BROWSE_PAGE;
const ORIGIN_LABEL = { 'all': 'Todas', 'game-capture': '🎮 Juego',
  'visitor-upload': '👤 Visitantes', 'admin-upload': '🛠️ Admin',
  'local-archive': '🗄️ Archivo', 'curated': '⭐ Curadas' };

function unclassifiedMedia() {
  // Sólo las que puede tocar el admin (de la nube/subidas), no las curadas build-time.
  const all = ((CTX.state.media && CTX.state.media.unclassified) || []).filter((m) => m.source !== 'curated');
  return mediaOrigin === 'all' ? all : all.filter((m) => (m.origin || 'admin-upload') === mediaOrigin);
}
// Texto por el que se busca una foto en la vista «Todas»: sujeto, pie, sugerencia
// del clasificador y procedencia. El id entra porque a veces es lo único que se
// tiene a mano (viene de un error de consola o del script de sincronización).
function mediaHaystack(m) {
  return [subjectLabel(m), m.caption, m.caption_en, m.species_hint, m.archive_dir,
    ORIGIN_LABEL[m.origin] || m.origin, m.id, m.credit].filter(Boolean).join(' ').toLowerCase();
}
// TODAS las fotos del inventario, curadas incluidas. La bandeja mostraba sólo lo
// «sin clasificar» y lo de un punto/especie concreto, así que una foto ya
// clasificada de la que no recordabas el sujeto era invisible desde el admin:
// no había forma de encontrarla ni de reasignarla. Aquí sí están todas.
function browseMedia() {
  let list = allMedia();
  if (mediaOrigin !== 'all') list = list.filter((m) => (m.origin || 'admin-upload') === mediaOrigin);
  if (mediaStatus === 'unclassified') list = list.filter((m) => !m.subject_id);
  else if (mediaStatus === 'classified') list = list.filter((m) => !!m.subject_id);
  const q = mediaQuery.trim().toLowerCase();
  if (q) list = list.filter((m) => mediaHaystack(m).includes(q));
  // Lo más reciente primero: `taken_at` cuando existe, si no el orden de carga.
  return list.slice().sort((a, b) => String(b.taken_at || '').localeCompare(String(a.taken_at || '')));
}
function unclassifiedCount() { try { return unclassifiedMedia().length; } catch (e) { return 0; } }
function subjectMedia(type, id) { return (CTX.state.media && CTX.state.media.bySubject[`${type}:${id}`]) || []; }

// Un sujeto GRUESO ('species_group' / 'point_type') se comporta como cualquier
// otro sujeto: tiene galería, portada y orden. Sólo cambia de qué es la foto —
// «un ave», «un mirador» — cuando no se puede (o no se quiere) precisar más.
const baseSubjectType = (t) => (t === 'species_group' ? 'species' : t === 'point_type' ? 'waypoint' : (t || 'waypoint'));
const pointTypeMeta = (tp) => (CTX.pointTypes ? CTX.pointTypes() : []).find((x) => x.tipo === tp);
function subjectLabel(m) {
  if (!m.subject_id) return '❓ Sin clasificar';
  if (m.subject_type === 'species_group') return '🏷️ ' + esc(GROUP_LABEL[m.subject_id] || m.subject_id);
  if (m.subject_type === 'point_type') { const t = pointTypeMeta(m.subject_id); return '🏷️ ' + esc(t ? `${t.emoji} ${t.label}` : m.subject_id); }
  if (m.subject_type === 'species') { const s = CTX.state.species.find((x) => x.id === m.subject_id); return '🦋 ' + esc(s ? (CTX.L(s, 'common_name') || s.scientific_name || m.subject_id) : m.subject_id); }
  const w = CTX.state.waypoints.find((x) => x.properties.id === m.subject_id);
  return '📍 ' + esc(w ? (CTX.L(w.properties, 'title') || w.properties.title || m.subject_id) : m.subject_id);
}
// Reconstruye la fila de la tabla `media` a partir del registro normalizado + un parche.
// Una URL `blob:` es una referencia EN MEMORIA del navegador, viva sólo mientras
// dure la pestaña que la creó. Mientras una foto espera en la cola, saveRow
// devuelve una fila de vista previa con `URL.createObjectURL(...)`, y esa vista
// previa queda en state.media. Si el admin edita la foto (portada, orden, pie)
// antes de que la cola vacíe, ese blob se escribía como URL DEFINITIVA y la foto
// se perdía: la fila apunta a nada. Ya pasó — 3 filas de 2026-07-13.
// Se corta aquí, donde se construye la fila, y no en la cola: encolarlo sería
// reintentar para siempre algo que nunca puede funcionar.
function assertUploadable(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    throw new Error('Esa foto todavía se está subiendo. Espera a que termine y vuelve a intentarlo.');
  }
  return url;
}
function mediaRow(m, patch) {
  assertUploadable(m.full);
  return { id: m.id, kind: m.kind || 'photo', url: m.full || null,
    thumb: (m.thumb && m.thumb !== m.full) ? m.thumb : null, poster: m.poster || null,
    subject_type: m.subject_type || null, subject_id: m.subject_id || null,
    is_primary: !!m.is_primary, sort: m.sort || 0, focal_x: m.focal_x != null ? m.focal_x : 0.5,
    focal_y: m.focal_y != null ? m.focal_y : 0.5, caption: m.caption || null, caption_en: m.caption_en || null,
    credit: m.credit || null, source: m.source === 'curated' ? 'admin' : (m.source || 'admin'),
    status: (m.subject_type && m.subject_id) ? 'classified' : 'unclassified',
    // La procedencia se CONSERVA, no se recalcula: un upsert construye la fila
    // entera, así que omitir estos campos los pondría a null en cada edición del
    // admin — clasificar una foto del juego le borraría el GPS, la caminata y su
    // origen. `origin` es un hecho histórico; sólo `reviewed` cambia al editar.
    origin: m.origin || 'admin-upload', content_hash: m.content_hash || null,
    lat: m.lat != null ? m.lat : null, lng: m.lng != null ? m.lng : null,
    taken_at: m.taken_at || null, walk_id: m.walk_id || null,
    species_hint: m.species_hint || null,
    hint_confidence: m.hint_confidence != null ? m.hint_confidence : null,
    archive_dir: m.archive_dir || null,
    ...patch };
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

// Clasificar VARIAS de una vez. `saveMedia` repinta y saca un aviso por foto, que
// con 30 seleccionadas es 30 repintados y 30 avisos — y el repintado se llevaría
// por delante la barra de progreso. Aquí se guarda en silencio y se repinta UNA
// vez al final.
async function classifyMany(ids, type, subjectId) {
  const bar = document.getElementById('fm-selbar');
  const say = (t) => { if (bar) bar.querySelector('.fm-selcount').textContent = t; };
  let ok = 0, fail = 0, queued = 0;
  for (let i = 0; i < ids.length; i++) {
    // Se relee de `allMedia()` en cada vuelta: `mediaRow` reconstruye la fila
    // ENTERA, así que partir de una copia vieja borraría lo que cambió entretanto.
    const m = allMedia().find((x) => x.id === ids[i]);
    if (!m) { fail++; continue; }
    say(`⏳ ${i + 1}/${ids.length}`);
    try {
      const res = await saveRow('media', mediaRow(m, { subject_type: type, subject_id: subjectId, status: 'classified' }));
      CTX.applyLocalRow('media', res.row);
      ok++; if (res.queued) queued++;
    } catch (e) { fail++; console.warn('[media] lote', ids[i], e && e.message); }
  }
  selClear();
  renderFotos();
  CTX.toast(`🏷️ ${ok} clasificada(s)${queued ? ` · ${queued} en cola` : ''}${fail ? ` · ⚠️ ${fail} fallaron` : ''}`);
}
// ¿Esta foto tiene fila PROPIA en la nube? Es la unica pregunta que importa:
// sin fila, `delete from media where id=...` no borra nada y Supabase no se
// queja — el boton decia «Eliminado» y la foto seguia ahi.
//
// NO se decide por el campo `source`. Eso es lo que estaba roto: el codigo
// buscaba 'curated' y las 181 fotos empacadas traen 'archivo_cantares', asi que
// ninguna entraba por el camino de la lapida. Cualquier cadena que escriba el
// pipeline manana volveria a romperlo. Se mira la lista de filas de la nube, que
// es el hecho, no una etiqueta.
function isBundled(m) {
  const cloud = (CTX.state && CTX.state.cloudMedia) || [];
  return !cloud.some((r) => r && r.id === m.id);
}
async function deleteMany(ids) {
  if (!confirm(`¿Eliminar ${ids.length} foto(s)/video(s)?`)) return;
  let ok = 0, fail = 0;
  for (const id of ids) {
    const m = allMedia().find((x) => x.id === id);
    if (!m) { fail++; continue; }
    try {
      if (isBundled(m)) {
        // No hay fila en la nube que borrar: la foto viene del build (media.json) o
        // es PRESTADA (species.photo, foto/hoja del punto). Se tapa con una LÁPIDA:
        // misma id, status 'deleted'. Antes esto se contaba como fallo y la foto se
        // quedaba para siempre. Reversible: borra la lápida y la foto vuelve.
        const row = mediaRow(m, { status: 'deleted' });
        await saveRow('media', row);
        CTX.applyLocalRow('media', row);
      } else {
        await deleteRow('media', id); CTX.removeLocalRow('media', id);
      }
      await clearSpeciesCoverIfSame(m);
      ok++;
    } catch (e) { fail++; console.warn('[media] borrar lote', id, e && e.message); }
  }
  selClear();
  renderFotos();
  CTX.toast(`🗑️ ${ok} eliminada(s)${fail ? ` · ${fail} no se pudieron (curadas o error)` : ''}`);
}
// Barra flotante: sólo existe si hay algo seleccionado.
function renderSelBar() {
  let bar = document.getElementById('fm-selbar');
  if (!mediaSel.size) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'fm-selbar'; bar.className = 'fm-selbar';
    (document.getElementById('admin-panel') || document.body).appendChild(bar);
  }
  bar.innerHTML = `<span class="fm-selcount">${mediaSel.size} seleccionada(s)</span>
    <button data-b="assign" class="admin-add">🏷️ Clasificar todas</button>
    <button data-b="del" class="admin-cancel">🗑️</button>
    <button data-b="none" class="admin-cancel">✕</button>`;
  bar.querySelector('[data-b="assign"]').onclick = () => assignPicker([...mediaSel]);
  bar.querySelector('[data-b="del"]').onclick = () => deleteMany([...mediaSel]);
  bar.querySelector('[data-b="none"]').onclick = () => { selClear(); renderFotos(); };
}
// Ojo con `curated`: aqui habia un `|| s.source === 'curated'` que se saltaba
// esas filas. Como muchas de media.json vienen con is_primary: true, elegir otra
// portada dejaba DOS, y el desempate lo decidia `sort`; y si la que elegias era
// curada, no pasaba nada en absoluto. Escribir una fila curada es la via de
// escape prevista: mediaRow la convierte a source 'admin' y, al deduplicar por
// id, la fila de la nube gana sobre la empacada.
async function setPrimaryMedia(m) {
  const sibs = subjectMedia(m.subject_type, m.subject_id);
  for (const s of sibs) {
    const want = s.id === m.id;
    if (s.is_primary === want) continue;
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
// La MISMA foto vive hoy en dos sitios: 23_catalog_to_media escribe una fila en
// media.json Y ademas rellena `species.photo`. Las 122 portadas estan asi. Borrar
// solo una de las dos deja la foto en pantalla por la otra puerta — que es
// exactamente el «no se eliminan»: se borraba la fila y reaparecia, ahora como
// prestada «del inventario». Borrar tiene que vaciar las dos.
const samePhotoFile = (a, b) => {
  const k = (x) => String(x || '').replace(/\.(webp|jpe?g|png)$/i, '');
  return !!a && !!b && k(a) === k(b);
};
async function clearSpeciesCoverIfSame(m) {
  if (m.subject_type !== 'species' || !m.subject_id) return;
  const sp = ((CTX.state && CTX.state.species) || []).find((x) => x.id === m.subject_id);
  if (!sp || !sp.photo) return;
  if (!samePhotoFile(sp.photo, m.full) && !samePhotoFile(sp.photo, m.webpThumb)) return;
  // `species.photo` NO se puede vaciar escribiendo null en la nube: applyCloudSpecies
  // fusiona con cleanProps, que descarta null y '' — el null se tira y vuelve a ganar
  // el valor del build. (Es general: hoy ningun campo de especie se puede dejar en
  // blanco desde la app.) Asi que se tapa por el otro lado, con una lapida sobre la
  // id sintetica con la que la galeria presta esa foto.
  const id = 'sp-photo:' + sp.id;
  const row = { id, kind: 'photo', url: sp.photo, subject_type: 'species',
    subject_id: sp.id, status: 'deleted', source: 'curated' };
  await saveRow('media', row);
  CTX.applyLocalRow('media', row);
}
async function delMedia(m) {
  if (!confirm('¿Eliminar esta foto/video?')) return;
  try {
    // Mismo criterio que el borrado en lote: si la foto no tiene fila propia en la
    // nube (empacada o prestada), se tapa con una lápida en vez de rechazarla.
    let res;
    if (isBundled(m)) {
      const row = mediaRow(m, { status: 'deleted' });
      res = await saveRow('media', row); CTX.applyLocalRow('media', row);
    } else {
      res = await deleteRow('media', m.id); CTX.removeLocalRow('media', m.id);
    }
    await clearSpeciesCoverIfSame(m);
    renderFotos();
    CTX.toast(res && res.queued ? '💾 Eliminado — se sincronizará' : 'Eliminado');
  } catch (e) { CTX.toast(friendlyErr(e)); }
}
function editCaption(m) {
  const cur = m.caption || '';
  const val = prompt('Pie de foto (ES):', cur);
  if (val == null) return;
  saveMedia(mediaRow(m, { caption: val.trim() || null }));
}
// `fromCamera` abre la cámara del teléfono directamente (sin pasar por el
// carrete). Mismo camino de guardado: comprimir → cola offline.
function addMedia(preset, fromCamera) {
  const inp = document.createElement('input'); inp.type = 'file';
  inp.accept = fromCamera ? 'image/*' : 'image/*,video/*';
  if (fromCamera) inp.capture = 'environment';
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
// Selección múltiple. Vive fuera del render: la bandeja se repinta a cada guardado
// y una selección que se pierde al repintar no sirve para nada.
const mediaSel = new Set();
function selClear() { mediaSel.clear(); }

// La conjetura del MOTOR (`species_hint`, nombre científico) frente a lo que
// eligió la PERSONA (`subject_id`). Antes esto sólo se pintaba cuando no había
// nada clasificado, así que un DESACUERDO —el caso que de verdad hay que
// revisar— no se veía: la foto llegaba con su especie puesta y la conjetura
// contraria escondida detrás. Ahora un desacuerdo se marca en rojo y sube al
// principio de la tarjeta.
function hintChip(m) {
  if (!m.species_hint) return '';
  const pct = m.hint_confidence != null ? ` ${(m.hint_confidence * 100).toFixed(0)}%` : '';
  if (!m.subject_id) {
    return `<span class="fm-hint" title="Sugerencia del clasificador, sin confirmar">🤖 ${esc(m.species_hint)}${pct}</span>`;
  }
  if (m.subject_type !== 'species') return '';
  const picked = CTX.state.species.find((x) => x.id === m.subject_id);
  const same = picked && norm(picked.scientific_name) === norm(m.species_hint);
  if (same) return '';   // coinciden: no hay nada que revisar
  return `<span class="fm-hint fm-hint-conflict" title="El identificador propuso otra cosa. Lo eligió la persona; confirma tú.">⚠️ 🤖 ${esc(m.species_hint)}${pct}</span>`;
}
const norm = (x) => (x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function mediaCardHTML(m, opts = {}) {
  const sel = mediaSel.has(m.id);
  const thumb = m.kind === 'video'
    ? `<div class="fm-thumb fm-video" style="${m.poster ? `background-image:url('${esc(m.poster)}')` : ''}"><span>▶</span></div>`
    : `<div class="fm-thumb" style="background-image:url('${esc(m.thumb || m.full)}')"></div>`;
  const order = opts.subject ? `<button data-a="up" title="Subir">↑</button><button data-a="down" title="Bajar">↓</button>` : '';
  return `<div class="fm-card${sel ? ' sel' : ''}" data-id="${esc(m.id)}">
    <label class="fm-pick" title="Seleccionar"><input type="checkbox" data-sel ${sel ? 'checked' : ''}></label>
    ${thumb}
    <div class="fm-meta">
      <span class="fm-subj">${subjectLabel(m)}${m.caption ? ` · <i>${esc(m.caption)}</i>` : ''}</span>
      ${hintChip(m)}
      ${m.origin && m.origin !== 'admin-upload' ? `<span class="fm-origin">${esc(ORIGIN_LABEL[m.origin] || m.origin)}</span>` : ''}
      ${m.archive_dir ? `<span class="fm-origin fm-dir" title="Carpeta del archivo local">🗂 ${esc(m.archive_dir)}</span>` : ''}
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
// «Todas las visibles» es lo que convierte esto en útil: filtras por carpeta o
// buscas «aves», marcas todas y clasificas de una vez.
function selAllBtnHTML(n) {
  return n ? `<button class="admin-pick fm-selall" id="fm-selall">☑️ Seleccionar las ${n} visibles</button>` : '';
}
function wireSelAll(container, list) {
  const b = container.querySelector('#fm-selall');
  if (!b) return;
  b.onclick = () => {
    const todas = list.every((m) => mediaSel.has(m.id));
    list.forEach((m) => (todas ? mediaSel.delete(m.id) : mediaSel.add(m.id)));
    renderFotos();
  };
}
function wireMediaCards(container, opts = {}) {
  container.querySelectorAll('.fm-card').forEach((card) => {
    const m = allMedia().find((x) => x.id === card.dataset.id); if (!m) return;
    // Tocar la miniatura la abre a pantalla completa. Clasificar una foto pide
    // MIRARLA, y en un recuadro de 90 px no se distingue una orquídea de una
    // bromelia. Es el mismo visor que usa la galería pública.
    const cb = card.querySelector('[data-sel]');
    if (cb) cb.onchange = (e) => {
      e.stopPropagation();
      if (cb.checked) mediaSel.add(m.id); else mediaSel.delete(m.id);
      card.classList.toggle('sel', cb.checked);
      renderSelBar();
    };
    const th = card.querySelector('.fm-thumb');
    if (th && CTX.openLightbox) {
      th.style.cursor = 'zoom-in';
      th.title = 'Ver grande';
      th.onclick = (e) => { e.stopPropagation(); CTX.openLightbox(m.full, m.kind); };
    }
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
// ---- sub-clasificación de sujetos (puntos y especies) ----------------------
// Con ~260 puntos y ~150 especies, la lista plana obligaba a recordar el nombre
// exacto para clasificar una foto. Estas subcategorías la parten por las MISMAS
// categorías que el sistema ya tiene — el `tipo` del punto, los recorridos a los
// que pertenece, y el grupo del inventario (ave/árbol/flor/…) para las especies —
// así que no hay una taxonomía nueva que mantener en paralelo. Sirven igual para
// VER (pestaña «Por punto / especie») que para CLASIFICAR (asignar una foto).

// Chips disponibles para un tipo de sujeto, con el conteo de cada uno. Un chip
// sin nada dentro no se dibuja: un filtro que siempre da vacío es ruido.
function subjectChips(pt) {
  if (pt === 'species') {
    const n = {};
    (CTX.state.species || []).forEach((s) => { const g = editorGroup(s); n[g] = (n[g] || 0) + 1; });
    return [{ k: 'all', label: `Todas (${(CTX.state.species || []).length})` }]
      .concat(GROUPS.filter((g) => n[g]).map((g) => ({ k: 'grp:' + g, label: `${GROUP_LABEL[g]} (${n[g]})` })));
  }
  const wps = CTX.state.waypoints || [];
  const n = {};
  wps.forEach((w) => { const tp = w.properties.tipo || 'punto'; n[tp] = (n[tp] || 0) + 1; });
  const tipos = (CTX.pointTypes ? CTX.pointTypes() : []).filter((t) => n[t.tipo])
    .map((t) => ({ k: 'tipo:' + t.tipo, label: `${t.emoji} ${t.label} (${n[t.tipo]})` }));
  const rutas = (CTX.state.routes || []).map((r) => {
    const c = wps.filter((w) => (w.properties.routes || []).includes(r.id)).length;
    return { k: 'ruta:' + r.id, label: `${r.emoji || '🥾'} ${CTX.L(r, 'name') || r.id} (${c})`, n: c };
  }).filter((x) => x.n);
  return [{ k: 'all', label: `Todos (${wps.length})` }].concat(tipos).concat(rutas);
}
// Sujetos que quedan tras aplicar un chip. Filtrando por recorrido se devuelven
// EN EL ORDEN EN QUE SE CAMINAN (y numerados): clasificando las fotos de una
// salida, ese es justo el orden en que se tomaron.
function subjectList(pt, chip) {
  const key = String(chip || 'all');
  // El primer ítem de una subcategoría es la subcategoría ENTERA: clasificar ahí
  // una foto de «un ave que no sé cuál es» o «algún mirador». Antes la única
  // salida era inventar una especie/punto concreto o dejarla sin clasificar.
  let head = [];
  if (pt === 'species') {
    let sp = (CTX.state.species || []).slice();
    if (key.startsWith('grp:')) {
      const g = key.slice(4); sp = sp.filter((s) => editorGroup(s) === g);
      head = [{ id: g, type: 'species_group', label: `🏷️ Todo el grupo: ${GROUP_LABEL[g] || g}`, sub: `${sp.length} especie(s) — sin precisar cuál` }];
    }
    return head.concat(sp.map((s) => ({ id: s.id, label: CTX.L(s, 'common_name') || s.scientific_name || s.id, sub: s.scientific_name || '' }))
      .sort((a, b) => a.label.localeCompare(b.label)));
  }
  let wps = (CTX.state.waypoints || []).slice();
  let ordered = false;
  if (key.startsWith('tipo:')) {
    const tp = key.slice(5);
    wps = wps.filter((w) => (w.properties.tipo || 'punto') === tp);
    const meta = pointTypeMeta(tp);
    head = [{ id: tp, type: 'point_type', label: `🏷️ Todo el tipo: ${meta ? `${meta.emoji} ${meta.label}` : tp}`, sub: `${wps.length} punto(s) — sin precisar cuál` }];
  } else if (key.startsWith('ruta:')) {
    const rtId = key.slice(5);
    wps = wps.filter((w) => (w.properties.routes || []).includes(rtId));
    const r = (CTX.state.routes || []).find((x) => x.id === rtId);
    if (r && CTX.orderPointsAlongSegments) {
      const at = new Map(CTX.orderPointsAlongSegments(r.segments || [], wps.map((w) => w.properties.id), r.start_id, r.end_id, r.freeroam_paths)
        .map((id, i) => [id, i]));
      const rank = (w) => (at.has(w.properties.id) ? at.get(w.properties.id) : 1e9);
      wps.sort((a, b) => rank(a) - rank(b));
      ordered = true;
    }
  }
  const items = wps.map((w, i) => ({ id: w.properties.id,
    label: (ordered ? `${i + 1}. ` : '') + (CTX.L(w.properties, 'title') || w.properties.title || w.properties.id),
    sub: w.properties.tipo || '' }));
  return head.concat(ordered ? items : items.sort((a, b) => a.label.localeCompare(b.label)));
}
// Un ítem de la lista de sujetos. `type` viaja en el DOM porque un ítem grueso NO
// es del tipo del selector en que aparece (sale bajo «Especie», pero se guarda
// como 'species_group').
const subjectItemHTML = (it, pt) =>
  `<button class="fm-assign-item${it.type ? ' fm-coarse' : ''}" data-id="${esc(it.id)}" data-type="${esc(it.type || pt)}"><b>${esc(it.label)}</b>${it.sub ? ` <span>${esc(it.sub)}</span>` : ''}</button>`;
function subjectChipsHTML(chips, sel) {
  return `<div class="fm-modes fm-subchips">${chips.map((c) =>
    `<button type="button" data-chip="${esc(c.k)}" class="${sel === c.k ? 'sel' : ''}">${esc(c.label)}</button>`).join('')}</div>`;
}

function assignPicker(m) {
  // Acepta una foto o una LISTA de ids: el selector es el mismo, sólo cambia a
  // cuántas se aplica. Duplicarlo para el lote habría dejado dos buscadores que
  // se van separando con el tiempo.
  const many = Array.isArray(m);
  const ids = many ? m : [m.id];
  let ov = document.getElementById('fm-assign');
  if (!ov) { ov = document.createElement('div'); ov.id = 'fm-assign'; ov.className = 'fm-assign'; document.body.appendChild(ov); }
  let pt = many ? 'species' : baseSubjectType(m.subject_type);
  // Chip activo por tipo de sujeto: cambiar de Punto a Especie y volver no debe
  // perder el filtro con el que estabas trabajando (se clasifica por tandas).
  const chipSel = { waypoint: 'all', species: 'all' };
  const render = () => {
    const items = subjectList(pt, chipSel[pt]);
    ov.innerHTML = `<div class="fm-assign-box">
      <button class="card-close" id="fa-x" aria-label="Cerrar">×</button>
      <h3>${many ? `Clasificar ${ids.length} foto(s)/video(s)` : 'Clasificar foto/video'}</h3>
      <div class="fm-type-toggle">
        <button data-tp="waypoint" class="${pt === 'waypoint' ? 'sel' : ''}">📍 Punto</button>
        <button data-tp="species" class="${pt === 'species' ? 'sel' : ''}">🦋 Especie</button>
      </div>
      ${subjectChipsHTML(subjectChips(pt), chipSel[pt])}
      <input class="admin-search" id="fa-search" placeholder="🔎 Buscar…">
      <div class="fm-assign-list" id="fa-list">${items.length
        ? items.map((it) => subjectItemHTML(it, pt)).join('')
        : '<div class="admin-note">Nada en esta subcategoría.</div>'}</div>
      ${!many && m.subject_id ? '<button class="admin-cancel" id="fa-unclass">Dejar sin clasificar</button>' : ''}
    </div>`;
    const close = () => ov.remove();
    ov.querySelector('#fa-x').onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    ov.querySelectorAll('.fm-type-toggle button').forEach((b) => b.onclick = () => { pt = b.dataset.tp; render(); });
    ov.querySelectorAll('.fm-subchips button').forEach((b) => b.onclick = () => { chipSel[pt] = b.dataset.chip; render(); });
    ov.querySelector('#fa-search').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      ov.querySelectorAll('.fm-assign-item').forEach((it) => { it.style.display = !q || it.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    };
    ov.querySelectorAll('.fm-assign-item').forEach((it) => it.onclick = async () => {
      close();
      if (many) await classifyMany(ids, it.dataset.type, it.dataset.id);
      else await classifyMedia(m, it.dataset.type, it.dataset.id);
    });
    const uc = ov.querySelector('#fa-unclass'); if (uc) uc.onclick = async () => { close(); await saveMedia(mediaRow(m, { subject_type: null, subject_id: null, is_primary: false, status: 'unclassified' })); };
  };
  render();
}

// Abre el clasificador directamente en un punto/especie (desde sus editores).
// ---- Editor de contenido de páginas (Historia / Info) --------------------
// Un solo editor guiado por esquema: campos sueltos + listas con añadir /
// borrar / reordenar. Guarda el DOCUMENTO COMPLETO en la tabla `content`
// (migración 22) por la cola offline, así que funciona sin señal.
const F = (k, t, l, ph) => ({ k, t, l, ph });
const CONTENT_SCHEMA = {
  historia: {
    label: '📖 Nuestra Historia',
    fields: [F('lead', 'area', 'Frase de apertura (ES)'), F('lead_en', 'area', 'Opening line (EN)')],
    lists: [
      { path: 'secciones', label: 'Secciones', title: (it) => it.titulo || '(sin título)',
        item: [F('titulo', 'text', 'Título (ES)'), F('titulo_en', 'text', 'Title (EN)'),
          F('texto', 'area', 'Texto (ES)', 'Separa párrafos con una línea en blanco'),
          F('texto_en', 'area', 'Text (EN)'), F('pie', 'text', 'Pie de sección'),
          F('foto', 'text', 'Foto (ruta)', 'img/…')] },
      { path: 'hitos.items', label: 'Línea de tiempo', title: (it) => it.fecha || '(sin fecha)',
        item: [F('fecha', 'text', 'Fecha'), F('texto', 'area', 'Qué pasó (ES)'),
          F('texto_en', 'area', 'What happened (EN)'), F('hito', 'check', 'Hito mayor (punto dorado)')] },
    ],
  },
  comercial: {
    label: '🎟️ Info: servicios y reseñas',
    fields: [F('airbnb_url', 'text', 'Enlace de Airbnb'), F('instagram_url', 'text', 'Enlace de Instagram'),
      F('instagram_handle', 'text', 'Usuario de Instagram'), F('email', 'text', 'Correo'),
      F('telefono', 'text', 'Teléfono'), F('whatsapp', 'text', 'WhatsApp (solo dígitos)')],
    lists: [
      { path: 'servicios', label: 'Servicios y tarifas', title: (it) => it.nombre || '(sin nombre)',
        item: [F('emoji', 'text', 'Emoji'), F('nombre', 'text', 'Nombre (ES)'), F('nombre_en', 'text', 'Name (EN)'),
          F('tarifa', 'text', 'Tarifa'), F('horario', 'text', 'Horario (ES)'), F('horario_en', 'text', 'Hours (EN)'),
          F('incluye', 'lines', 'Incluye (una por línea)'), F('nota', 'area', 'Nota')] },
      { path: 'adicionales', label: 'Servicios adicionales', simple: true, title: (it) => String(it || '') },
      { path: 'resenas', label: 'Comentarios (Airbnb)', title: (it) => it.autor || '(sin autor)',
        item: [F('autor', 'text', 'Nombre'), F('origen', 'text', 'De dónde / antigüedad'),
          F('fecha', 'text', 'Fecha'), F('estadia', 'text', 'Estadía'),
          F('estrellas', 'text', 'Estrellas (1–5)'), F('traducido', 'check', 'Traducido por Airbnb'),
          F('texto', 'area', 'Comentario')] },
    ],
  },
  // «Planea tu visita». Estos datos estaban SOLO en reserve_info.json: cambiar el
  // horario o el teléfono obligaba a editar un archivo y volver a desplegar.
  reserve_info: {
    label: '🕑 Info: datos de la visita',
    fields: [F('hours', 'text', 'Horarios (ES)'), F('hours_en', 'text', 'Hours (EN)'),
      F('phone', 'text', 'Teléfono'), F('whatsapp', 'text', 'WhatsApp (solo dígitos)'),
      F('how_to_arrive', 'area', 'Cómo llegar (ES)'), F('how_to_arrive_en', 'area', 'Getting there (EN)'),
      F('parking', 'text', 'Parqueo (ES)'), F('parking_en', 'text', 'Parking (EN)'),
      F('entry', 'text', 'Entrada (ES)'), F('entry_en', 'text', 'Entry (EN)')],
    lists: [
      { path: 'rules', label: 'Normas (ES)', simple: true, title: (it) => String(it || '') },
      { path: 'rules_en', label: 'Rules (EN)', simple: true, title: (it) => String(it || '') },
    ],
  },
};
export const getPath = (o, p) => p.split('.').reduce((a, k) => (a && a[k] != null ? a[k] : undefined), o);
export function setPath(o, p, v) {
  const ks = p.split('.'); let cur = o;
  ks.slice(0, -1).forEach((k) => { if (typeof cur[k] !== 'object' || cur[k] == null) cur[k] = {}; cur = cur[k]; });
  cur[ks[ks.length - 1]] = v;
}
export function openContentEditor(key) {
  const sch = CONTENT_SCHEMA[key]; if (!sch) return;
  // Copia profunda: se edita en borrador y sólo se escribe al guardar.
  const src = { historia: CTX.state.historia, comercial: CTX.state.comercial,
    reserve_info: CTX.state.reserveInfo }[key];
  const doc = JSON.parse(JSON.stringify(src || {}));
  let open = null;   // `${listIdx}:${itemIdx}` del ítem desplegado
  let ov = document.getElementById('ce-ov');
  if (!ov) { ov = document.createElement('div'); ov.id = 'ce-ov'; ov.className = 'ce-ov'; document.body.appendChild(ov); }
  const close = () => ov.remove();

  // El tercer argumento es un PREFIJO, no el id: el id se compone aquí como
  // `prefix + f.k`, igual que lo busca readInto. Cuando este parámetro se usaba
  // tal cual como id, TODOS los campos salían con el mismo (`id="top_"`),
  // readInto buscaba `#top_lead` y no encontraba nada, y guardar escribía el
  // borrador sin tocar: historia, comercial e info no guardaban nunca.
  const inputFor = (f, val, prefix) => {
    const id = prefix + f.k;
    const v = val == null ? '' : val;
    if (f.t === 'check') return `<label class="ce-chk"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${esc(f.l)}</label>`;
    const lbl = `<label class="ce-lbl" for="${id}">${esc(f.l)}</label>`;
    const ph = f.ph ? ` placeholder="${esc(f.ph)}"` : '';
    if (f.t === 'area') return `${lbl}<textarea id="${id}" rows="4"${ph}>${esc(v)}</textarea>`;
    if (f.t === 'lines') return `${lbl}<textarea id="${id}" rows="4"${ph}>${esc(Array.isArray(v) ? v.join('\n') : v)}</textarea>`;
    return `${lbl}<input id="${id}" value="${esc(v)}"${ph}>`;
  };
  const readInto = (obj, fields, prefix) => fields.forEach((f) => {
    const el = ov.querySelector('#' + prefix + f.k); if (!el) return;
    if (f.t === 'check') obj[f.k] = el.checked;
    else if (f.t === 'lines') obj[f.k] = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
    else obj[f.k] = el.value;
  });

  function render() {
    const lists = sch.lists.map((L, li) => {
      const arr = getPath(doc, L.path) || [];
      const rows = arr.map((it, ii) => {
        const isOpen = open === `${li}:${ii}`;
        const body = !isOpen ? '' : L.simple
          ? `<div class="ce-item-body"><textarea id="s_${li}_${ii}" rows="2">${esc(String(it || ''))}</textarea></div>`
          : `<div class="ce-item-body">${L.item.map((f) => inputFor(f, it[f.k], `f_${li}_${ii}_`)).join('')}</div>`;
        return `<div class="ce-item ${isOpen ? 'open' : ''}" data-li="${li}" data-ii="${ii}">
          <div class="ce-item-h">
            <button class="ce-item-t" data-a="toggle">${esc(L.title(it))}</button>
            <span class="ce-item-btns">
              <button data-a="up" title="Subir">↑</button><button data-a="down" title="Bajar">↓</button>
              <button data-a="del" title="Borrar">🗑️</button>
            </span>
          </div>${body}</div>`;
      }).join('');
      return `<div class="ce-list" data-li="${li}">
        <h3 class="ce-h3">${esc(L.label)} <span class="ce-count">${arr.length}</span></h3>
        ${rows || '<p class="ce-empty">Todavía no hay nada. Añade el primero.</p>'}
        <button class="ce-add" data-a="add" data-li="${li}">＋ Añadir</button>
      </div>`;
    }).join('');
    ov.innerHTML = `<div class="ce-box">
      <div class="ce-head"><b>${esc(sch.label)}</b><button class="ce-x" aria-label="Cerrar">✕</button></div>
      <div class="ce-scroll">
        <div class="ce-fields">${sch.fields.map((f) => inputFor(f, doc[f.k], 'top_')).join('')}</div>
        ${lists}
      </div>
      <div class="ce-foot">
        <button class="ce-cancel">Cancelar</button>
        <button class="ce-save">Guardar cambios</button>
      </div>
    </div>`;
    wire();
  }
  // Pasa lo escrito en pantalla al borrador (antes de re-renderizar o guardar).
  function harvest() {
    readInto(doc, sch.fields, 'top_');
    if (!open) return;
    const [li, ii] = open.split(':').map(Number);
    const L = sch.lists[li], arr = getPath(doc, L.path) || [];
    if (!arr[ii]) return;
    if (L.simple) { const el = ov.querySelector(`#s_${li}_${ii}`); if (el) arr[ii] = el.value; }
    else readInto(arr[ii], L.item, `f_${li}_${ii}_`);
  }
  function wire() {
    ov.querySelector('.ce-x').onclick = close;
    ov.querySelector('.ce-cancel').onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    ov.querySelectorAll('.ce-add').forEach((b) => b.onclick = () => {
      harvest();
      const li = +b.dataset.li, L = sch.lists[li];
      let arr = getPath(doc, L.path); if (!Array.isArray(arr)) { arr = []; setPath(doc, L.path, arr); }
      arr.push(L.simple ? '' : {});
      open = `${li}:${arr.length - 1}`; render();
    });
    ov.querySelectorAll('.ce-item [data-a]').forEach((b) => b.onclick = () => {
      const card = b.closest('.ce-item'), li = +card.dataset.li, ii = +card.dataset.ii;
      const L = sch.lists[li], arr = getPath(doc, L.path) || [];
      const a = b.dataset.a;
      if (a === 'toggle') { harvest(); open = (open === `${li}:${ii}`) ? null : `${li}:${ii}`; render(); return; }
      harvest();
      if (a === 'del') { if (!confirm('¿Borrar este elemento?')) return; arr.splice(ii, 1); open = null; }
      else if (a === 'up' && ii > 0) { [arr[ii - 1], arr[ii]] = [arr[ii], arr[ii - 1]]; open = null; }
      else if (a === 'down' && ii < arr.length - 1) { [arr[ii + 1], arr[ii]] = [arr[ii], arr[ii + 1]]; open = null; }
      render();
    });
    ov.querySelector('.ce-save').onclick = async () => {
      harvest();
      const btn = ov.querySelector('.ce-save'); btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        const res = await saveRow('content', { id: key, doc });
        CTX.applyLocalRow('content', res.row);
        CTX.toast(res.queued ? '💾 Guardado en el teléfono — se subirá con señal' : '✓ Contenido actualizado');
        close();
      } catch (e) { btn.disabled = false; btn.textContent = 'Guardar cambios'; CTX.toast(friendlyErr(e)); }
    };
  }
  render();
}

// ---- Encuadrar / cambiar la foto (portada) de una especie o punto ----
// Editor de punto focal (arrastrar sobre un recorte 4:3, como la rejilla) + tira
// del stock de fotos de ESE sujeto; para puntos, además las fotos de sus especies
// linkeadas (p. ej. un árbol usa el stock clasificado de su especie).
function reframeMakePrimary(m, type, id) {
  return Promise.all(subjectMedia(type, id).map(async (s) => {
    const want = s.id === m.id;
    if (s.is_primary === want) return;   // ver setPrimaryMedia: las curadas TAMBIEN se escriben
    try { const r = await saveRow('media', mediaRow(s, { is_primary: want })); CTX.applyLocalRow('media', r.row); }
    catch (e) { /* queda en la cola offline */ }
  }));
}
function linkedSpeciesMediaFor(pointId) {
  const w = (CTX.state.waypoints || []).find((x) => x.properties.id === pointId);
  const ids = w ? (w.properties.species_ids || []).map((x) => String(x).trim().toLowerCase()) : [];
  if (!ids.length) return [];
  const specIds = (CTX.state.species || []).filter((s) =>
    ids.includes(String(s.id).toLowerCase()) || ids.includes(String(s.scientific_name || '').toLowerCase())).map((s) => s.id);
  const seen = new Set(), out = [];
  specIds.forEach((sid) => subjectMedia('species', sid).forEach((m) => { if (!seen.has(m.id)) { seen.add(m.id); out.push(m); } }));
  return out;
}
// "Usar" una foto de la especie como portada del punto: nueva fila de media del
// punto que apunta a la MISMA imagen (no duplica el archivo en disco).
async function reframeBorrow(m, pointId) {
  await reframeMakePrimary({ id: '__none__' }, 'waypoint', pointId);   // baja las portadas actuales
  const row = { id: rid('media'), kind: m.kind || 'photo', url: m.full, thumb: (m.thumb && m.thumb !== m.full) ? m.thumb : null,
    poster: m.poster || null, subject_type: 'waypoint', subject_id: pointId, is_primary: true, sort: 0,
    focal_x: m.focal_x, focal_y: m.focal_y, caption: m.caption || null, caption_en: m.caption_en || null,
    credit: m.credit || null, source: 'admin', status: 'classified' };
  try { const r = await saveRow('media', row); CTX.applyLocalRow('media', r.row); } catch (e) { /* cola */ }
}
export function openReframe(type, id) {
  if (!id) { CTX && CTX.toast('Guarda primero.'); return; }
  let ov = document.getElementById('rf-ov');
  if (!ov) { ov = document.createElement('div'); ov.id = 'rf-ov'; ov.className = 'rf-ov'; document.body.appendChild(ov); }
  const own = () => subjectMedia(type, id);
  let cur = own().find((m) => m.is_primary) || own()[0] || null;
  let fx = cur ? cur.focal_x : 0.5, fy = cur ? cur.focal_y : 0.5;
  const close = () => ov.remove();
  function render() {
    const borrow = type === 'waypoint' ? linkedSpeciesMediaFor(id).filter((m) => !own().some((o) => o.full === m.full)) : [];
    const chip = (m, tag) => `<button class="rf-chip ${cur && m.id === cur.id ? 'sel' : ''}" data-id="${esc(m.id)}" data-tag="${tag}" style="background-image:url('${esc(m.thumb || m.full)}')">${m.is_primary ? '<span class="rf-star">★</span>' : ''}</button>`;
    ov.innerHTML = `<div class="rf-box">
      <div class="rf-head"><b>Encuadrar / cambiar foto</b><button class="rf-x" aria-label="Cerrar">✕</button></div>
      ${cur ? `<div class="rf-frame"><img class="rf-img" src="${esc(cur.full)}" draggable="false" style="object-position:${(fx * 100).toFixed(1)}% ${(fy * 100).toFixed(1)}%"></div>
      <p class="rf-hint">Arrastra la foto para encuadrarla (se recorta a 4:3 como en la rejilla).</p>
      <div class="rf-actions"><button class="rf-center">Centrar</button><button class="rf-save">Guardar encuadre</button></div>`
        : '<p class="rf-hint">Aún no hay fotos. Sube una con ＋ o clasifícala en 🖼️ Fotos.</p>'}
      <div class="rf-stock-h">Fotos de ${type === 'species' ? 'esta especie' : 'esta ficha'}${own().length ? ` (${own().length})` : ''}</div>
      <div class="rf-stock">${own().map((m) => chip(m, 'own')).join('')}<button class="rf-add" title="Subir foto">＋</button></div>
      ${borrow.length ? `<div class="rf-stock-h">De sus especies (stock clasificado)</div>
      <div class="rf-stock">${borrow.map((m) => chip(m, 'borrow')).join('')}</div>` : ''}
    </div>`;
    wire(borrow);
  }
  function wire(borrow) {
    ov.querySelector('.rf-x').onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    const img = ov.querySelector('.rf-img');
    if (img) {
      const frame = ov.querySelector('.rf-frame');
      let drag = null;
      const set = (x, y) => { fx = Math.min(1, Math.max(0, x)); fy = Math.min(1, Math.max(0, y)); img.style.objectPosition = `${(fx * 100).toFixed(1)}% ${(fy * 100).toFixed(1)}%`; };
      frame.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY }; try { frame.setPointerCapture(e.pointerId); } catch (_) { /* ok */ } };
      frame.onpointermove = (e) => { if (!drag) return; const r = frame.getBoundingClientRect(); set(fx - (e.clientX - drag.x) / r.width, fy - (e.clientY - drag.y) / r.height); drag = { x: e.clientX, y: e.clientY }; };
      frame.onpointerup = frame.onpointercancel = () => { drag = null; };
      ov.querySelector('.rf-center').onclick = () => set(0.5, 0.5);
      ov.querySelector('.rf-save').onclick = async () => {
        try { const r = await saveRow('media', mediaRow(cur, { focal_x: +fx.toFixed(3), focal_y: +fy.toFixed(3) })); CTX.applyLocalRow('media', r.row); CTX.toast('✓ Encuadre guardado'); }
        catch (e) { CTX.toast(friendlyErr(e)); }
        close();
      };
    }
    ov.querySelectorAll('.rf-chip').forEach((c) => c.onclick = async () => {
      const tag = c.dataset.tag, pool = tag === 'borrow' ? borrow : own();
      const m = pool.find((x) => x.id === c.dataset.id); if (!m) return;
      CTX.toast('Actualizando portada…');
      if (tag === 'borrow') await reframeBorrow(m, id);
      else if (!m.is_primary) await reframeMakePrimary(m, type, id);
      cur = own().find((x) => x.is_primary) || own()[0] || m;
      fx = cur ? cur.focal_x : 0.5; fy = cur ? cur.focal_y : 0.5; render();
    });
    const add = ov.querySelector('.rf-add');
    if (add) add.onclick = () => {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return; CTX.toast('Preparando…');
        try {
          const blob = await compressImage(f);
          const row = { id: rid('media'), kind: 'photo', url: null, subject_type: type, subject_id: id,
            is_primary: !own().length, sort: Date.now() % 100000, focal_x: 0.5, focal_y: 0.5,
            source: 'admin', status: 'classified', caption: null, caption_en: null, credit: null };
          const r = await saveRow('media', row, { url: blob }); CTX.applyLocalRow('media', r.row);
          cur = own().find((x) => x.is_primary) || own()[0]; fx = cur ? cur.focal_x : 0.5; fy = cur ? cur.focal_y : 0.5; render();
        } catch (e) { CTX.toast(friendlyErr(e)); }
      };
      inp.click();
    };
  }
  render();
}
export function openMediaFor(type, id) {
  if (!id) { CTX && CTX.toast('Guarda primero para poder añadir fotos/videos.'); return; }
  tab = 'fotos'; mediaMode = 'subject'; mediaSubject = { type, id };
  openPanel();
}
function renderFotos() {
  clearHighlight();
  renderSelBar();
  const body = document.getElementById('admin-body');
  // El panel puede no haberse abierto nunca: `#admin-body` lo crea renderPanel.
  // saveMedia y delMedia repintan siempre esta vista, y desde la ficha de una
  // especie eso ocurre con el panel cerrado — sin esta guarda, subir o borrar
  // una foto desde la ficha lanzaba antes de llegar a la cola.
  if (!body) return;
  const n = unclassifiedMedia().length;
  body.innerHTML = `
    <div class="fm-modes">
      <button data-m="inbox" class="${mediaMode === 'inbox' ? 'sel' : ''}">Sin clasificar${n ? ` (${n})` : ''}</button>
      <button data-m="all" class="${mediaMode === 'all' ? 'sel' : ''}">Todas (${allMedia().length})</button>
      <button data-m="subject" class="${mediaMode === 'subject' ? 'sel' : ''}">Por punto / especie</button>
    </div>
    <div id="fm-body"></div>`;
  body.querySelectorAll('.fm-modes button').forEach((b) => b.onclick = () => {
    if (mediaMode !== b.dataset.m) browseShown = BROWSE_PAGE;   // cambiar de vista reinicia la paginación
    mediaMode = b.dataset.m; renderFotos();
  });
  const fm = document.getElementById('fm-body');
  if (mediaMode === 'all') { renderFotosAll(fm); return; }
  if (mediaMode === 'inbox') {
    const list = unclassifiedMedia();
    // Conteo por procedencia sobre TODO lo sin clasificar (no sobre lo filtrado),
    // para que los chips muestren cuánto hay en cada cola aunque estés en una.
    const every = ((CTX.state.media && CTX.state.media.unclassified) || []).filter((m) => m.source !== 'curated');
    const byOrigin = {};
    every.forEach((m) => { const o = m.origin || 'admin-upload'; byOrigin[o] = (byOrigin[o] || 0) + 1; });
    const chips = ['all'].concat(Object.keys(byOrigin).sort()).map((o) =>
      `<button data-o="${esc(o)}" class="${mediaOrigin === o ? 'sel' : ''}">${ORIGIN_LABEL[o] || o}${o === 'all' ? ` (${every.length})` : ` (${byOrigin[o]})`}</button>`).join('');
    const g = coverageGaps(CTX.state);
    fm.innerHTML = `
      <div class="fm-modes fm-origins">${chips}</div>
      <button class="admin-add" id="fm-cam">📷 Tomar foto</button>
      <button class="admin-add" id="fm-add">＋ Añadir foto / video</button>
      <div class="fm-modes">
        ${Dbx.dropboxConfigured() ? `<button id="fm-dbx">${Dbx.dropboxLinked() ? '📥 Traer del archivo (Dropbox)' : '🔗 Conectar Dropbox'}</button>` : ''}
        <button id="fm-intake">📂 Elegir carpeta a mano</button>
      </div>
      <div class="admin-note">Hoy faltan <b>${g.speciesMissing.size}</b> especie(s) y <b>${g.pointsMissing.size}</b> punto(s) sin ninguna foto.
        ${Dbx.dropboxConfigured()
          ? 'Con Dropbox conectado la app lista el archivo sola; tú eliges de qué carpetas y cuántas.'
          : 'Elige la carpeta <code>Cantares/fotos</code> y luego de qué subcarpetas y cuántas. (Conectar Dropbox lo haría automático — ver <code>docs/DROPBOX_MUESTRAS.md</code>.)'}</div>
      <div id="fm-intake-out"></div>
      <div class="admin-note">Sube o clasifica fotos/videos. Las que llegan sin sujeto se listan aquí para asignarlas a un punto o especie.</div>
      ${selAllBtnHTML(list.length)}
      ${list.length ? `<div class="fm-grid">${list.map((m) => mediaCardHTML(m)).join('')}</div>`
        : '<div class="admin-note" style="text-align:center;padding:20px">✓ Nada sin clasificar.</div>'}`;
    document.getElementById('fm-add').onclick = () => addMedia(null);
    document.getElementById('fm-cam').onclick = () => addMedia(null, true);
    document.getElementById('fm-intake').onclick = pickArchiveFolder;
    const dbx = document.getElementById('fm-dbx'); if (dbx) dbx.onclick = connectDropbox;
    fm.querySelectorAll('.fm-origins button').forEach((b) => b.onclick = () => { mediaOrigin = b.dataset.o; renderFotos(); });
    wireSelAll(fm, list);
    wireMediaCards(fm);
  } else {
    renderFotosSubject(fm);
  }
}
// ---- Traer una muestra del archivo -----------------------------------------
// Dos fuentes, la misma tubería: Dropbox (automático, sin señalar nada) o el
// selector de carpeta (respaldo, y lo único posible mientras no haya app key).
// Con Dropbox la app lista sola el archivo por su API —que habla CORS— y baja
// SÓLO las fotos elegidas. Todo sube por `saveRow`: cola offline y sesión de
// admin, sin claves nuevas ni caminos de escritura nuevos.
const DEFAULT_PER_FOLDER = 5;
// Carpetas que NO se marcan solas: la raíz (fotos sueltas sin clasificar), lo que
// empieza por `_` (bandejas de trabajo: `_sin_clasificar`, `_desde_app`) y lo que
// no es una categoría del clasificador. Se pueden marcar a mano; el punto es que
// nadie publique sin querer una captura de WhatsApp por darle a un botón.
const SKIP_BY_DEFAULT = (dir) => dir === '(raíz)' || /(^|\/)_/.test(dir);
let intakeEntries = [], intakeQuotas = {};

function intakeOut() { return document.getElementById('fm-intake-out'); }
function intakeSay(html) { const o = intakeOut(); if (o) o.innerHTML = `<div class="admin-note">${html}</div>`; }

function pickArchiveFolder() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  // Carpeta entera cuando el navegador lo permite; si no, selección múltiple a
  // mano. Sin `webkitdirectory` no hay rutas, así que no hay carpetas que elegir.
  try { inp.webkitdirectory = true; } catch (e) { /* móvil: selección múltiple */ }
  inp.onchange = async () => {
    const files = [...(inp.files || [])];
    if (!files.length) return;
    intakeSay('⏳ Leyendo la carpeta…');
    const gaps = coverageGaps(CTX.state);
    await loadIntake(fromFiles(files), await readCatalog(files), gaps);
  };
  inp.click();
}
async function connectDropbox() {
  if (!Dbx.dropboxConfigured()) { CTX.toast('Falta la app key de Dropbox — ver docs/DROPBOX_MUESTRAS.md'); return; }
  if (!Dbx.dropboxLinked()) { await Dbx.dropboxConnect(); return; }   // se va y vuelve
  intakeSay('⏳ Listando el archivo en Dropbox…');
  try {
    const items = await Dbx.listImages();
    if (!items.length) { intakeSay(`No hay imágenes en <code>${esc(Dbx.ARCHIVE_ROOT)}</code>.`); return; }
    await loadIntake(fromDropbox(items, Dbx.download), {}, coverageGaps(CTX.state));
  } catch (e) {
    // Un token caducado o revocado no debe parecer un fallo de la app.
    intakeSay(`⚠️ Dropbox: ${esc(e.message || String(e))}`);
  }
}
// Deja la selección lista y pinta el formulario de carpetas y cupos.
async function loadIntake(items, catalog, gaps) {
  intakeEntries = buildEntries(items, catalog, gaps);
  if (!intakeEntries.length) { intakeSay('No hay imágenes en lo que elegiste.'); return; }
  const n = countByFolder(intakeEntries);
  // Marcadas por defecto SÓLO las carpetas de categoría ya clasificadas. Lo que
  // sube queda alcanzable por URL pública (la tabla `media` es de lectura
  // pública), y este archivo es familiar: tiene capturas de WhatsApp, gente y
  // material de terceros. Las carpetas sin revisar y las fotos sueltas de la raíz
  // se dejan sin marcar a propósito — se pueden marcar a mano, mirándolas antes.
  intakeQuotas = {};
  Object.keys(n).forEach((d) => {
    intakeQuotas[d] = SKIP_BY_DEFAULT(d) ? 0 : Math.min(DEFAULT_PER_FOLDER, n[d]);
  });
  renderIntakeForm(n, Object.keys(catalog).length);
}
function renderIntakeForm(counts, nCat) {
  const out = intakeOut(); if (!out) return;
  const dirs = Object.keys(counts).sort();
  const total = () => dirs.reduce((s, d) => s + (intakeQuotas[d] || 0), 0);
  out.innerHTML = `
    <div class="ik-box">
      <div class="ik-head">${intakeEntries.length} imagen(es) en ${dirs.length} carpeta(s)
        ${nCat ? ` · catálogo leído (${nCat} fichas)` : ''}</div>
      <div class="ik-list">
        ${dirs.map((d) => `<label class="ik-row${SKIP_BY_DEFAULT(d) ? ' ik-warn' : ''}">
          <input type="checkbox" data-d="${esc(d)}" ${intakeQuotas[d] ? 'checked' : ''}>
          <span class="ik-name">${esc(d)}${SKIP_BY_DEFAULT(d) ? ' <b title="Sin revisar: míralas antes de publicarlas">⚠︎</b>' : ''}</span><span class="ik-n">${counts[d]}</span>
          <input class="ik-q" type="number" min="0" max="${counts[d]}" step="1"
            data-q="${esc(d)}" value="${intakeQuotas[d] || 0}" aria-label="Cuántas de ${esc(d)}">
        </label>`).join('')}
      </div>
      <div class="ik-foot">
        <button class="admin-cancel" id="ik-none">Ninguna</button>
        <button class="admin-add" id="ik-go">📥 Traer <b id="ik-total">${total()}</b></button>
      </div>
      <div class="admin-note">Dentro de cada carpeta la muestra se reparte entre especies y da prioridad a las que hoy no tienen ninguna foto. Lo ya subido se salta.</div>
      <div class="admin-note ik-privacy">⚠️ <b>Lo que traigas queda alcanzable por URL pública</b> aunque salga «sin clasificar»: la tabla de fotos es de lectura pública. Las carpetas marcadas con ⚠︎ (raíz y las que empiezan por <code>_</code>) no se marcan solas — míralas antes. Si algo no debía subir, bórralo aquí mismo y desaparece.</div>
    </div>`;
  const sync = () => { const t = document.getElementById('ik-total'); if (t) t.textContent = String(total()); };
  out.querySelectorAll('.ik-q').forEach((i) => i.oninput = () => {
    const d = i.dataset.q;
    intakeQuotas[d] = Math.max(0, Math.min(counts[d], parseInt(i.value, 10) || 0));
    const cb = out.querySelector(`[data-d="${CSS.escape(d)}"]`);
    if (cb) cb.checked = intakeQuotas[d] > 0;   // poner 0 es la forma de excluirla
    sync();
  });
  out.querySelectorAll('[data-d]').forEach((cb) => cb.onchange = () => {
    const d = cb.dataset.d;
    intakeQuotas[d] = cb.checked ? Math.min(DEFAULT_PER_FOLDER, counts[d]) : 0;
    const q = out.querySelector(`[data-q="${CSS.escape(d)}"]`);
    if (q) q.value = String(intakeQuotas[d]);
    sync();
  });
  document.getElementById('ik-none').onclick = () => { dirs.forEach((d) => intakeQuotas[d] = 0); renderIntakeForm(counts, nCat); };
  document.getElementById('ik-go').onclick = () => runArchiveIntake();
}
async function runArchiveIntake() {
  const gaps = coverageGaps(CTX.state);
  const planned = planByFolder(intakeEntries, gaps, intakeQuotas);
  if (!planned.length) { intakeSay('No marcaste ninguna carpeta.'); return; }
  // PRIMERA CRIBA, por ruta y SIN DESCARGAR NADA: lo traído en tandas anteriores
  // se descarta aquí. Antes había que bajar la foto para calcular su hash y
  // descubrir que ya estaba — con Dropbox eso son megas y minutos tirados.
  const { keep: picks, skipped } = dropAlreadyThere(planned, new Set(allMedia().map((m) => m.id)));
  if (!picks.length) {
    intakeSay(`✓ Nada nuevo: las ${skipped.length} de la muestra ya estaban. Sube el cupo o marca otra carpeta.`);
    return;
  }
  // Segunda criba, por hash de CONTENIDO: caza la misma foto guardada dos veces
  // con nombres distintos. Es la misma identidad que usa 26_sync_media.py.
  const known = new Set(allMedia().map((m) => m.content_hash).filter(Boolean));
  const r = await uploadSample(picks, known, (i, n, name) =>
    intakeSay(`⏳ ${i}/${n} — ${esc(name)}${skipped.length ? ` · ${skipped.length} ya estaban` : ''}`));
  r.repetidas += skipped.length;
  await CTX.refreshMedia();
  renderFotos();
  const o = intakeOut();
  if (o) o.innerHTML = `<div class="admin-note">✓ ${r.subidas} subida(s)`
    + `${r.encoladas ? ` (${r.encoladas} en cola, se suben con señal)` : ''}`
    + `${r.repetidas ? ` · ${r.repetidas} ya estaban` : ''}`
    + `${r.fallidas ? ` · ⚠️ ${r.fallidas} fallaron` : ''}`
    + ` — clasifícalas abajo. Toca una miniatura para verla grande.</div>`;
  CTX.toast(r.subidas ? `📥 ${r.subidas} foto(s) del archivo, sin clasificar` : 'Nada nuevo que traer');
}

// Vista «Todas»: el inventario completo de fotos y videos, buscable y filtrable,
// con el mismo botón de clasificar que la bandeja. Es la respuesta a «no
// encuentro esa foto en el admin».
function renderFotosAll(fm) {
  const list = browseMedia();
  const shown = list.slice(0, browseShown);
  const byOrigin = {};
  allMedia().forEach((m) => { const o = m.origin || 'admin-upload'; byOrigin[o] = (byOrigin[o] || 0) + 1; });
  const chips = ['all'].concat(Object.keys(byOrigin).sort()).map((o) =>
    `<button data-o="${esc(o)}" class="${mediaOrigin === o ? 'sel' : ''}">${ORIGIN_LABEL[o] || o}${o === 'all' ? ` (${allMedia().length})` : ` (${byOrigin[o]})`}</button>`).join('');
  const st = [['all', 'Todas'], ['unclassified', 'Sin clasificar'], ['classified', 'Clasificadas']].map(([k, l]) =>
    `<button data-s="${k}" class="${mediaStatus === k ? 'sel' : ''}">${l}</button>`).join('');
  fm.innerHTML = `
    <div class="fm-modes fm-origins">${chips}</div>
    <div class="fm-modes fm-origins">${st}</div>
    <input class="admin-search" id="fm-all-q" placeholder="🔎 Buscar por punto, especie, pie, sugerencia…" value="${esc(mediaQuery)}">
    <div class="admin-note">Todo lo que hay en el inventario de fotos y videos. Toca «Clasificar» o «Reasignar» en cualquiera — también en las curadas del catálogo, que quedan sobrescritas por la edición.</div>
    ${selAllBtnHTML(shown.length)}
    ${shown.length ? `<div class="fm-grid">${shown.map((m) => mediaCardHTML(m)).join('')}</div>`
      : '<div class="admin-note" style="text-align:center;padding:20px">Nada coincide con el filtro.</div>'}
    ${list.length > shown.length ? `<button class="admin-pick" id="fm-all-more">Ver ${Math.min(BROWSE_PAGE, list.length - shown.length)} más (${list.length - shown.length} restantes)</button>` : ''}`;
  fm.querySelectorAll('.fm-origins [data-o]').forEach((b) => b.onclick = () => { mediaOrigin = b.dataset.o; browseShown = BROWSE_PAGE; renderFotos(); });
  fm.querySelectorAll('.fm-origins [data-s]').forEach((b) => b.onclick = () => { mediaStatus = b.dataset.s; browseShown = BROWSE_PAGE; renderFotos(); });
  const q = document.getElementById('fm-all-q');
  // El re-render recrea el input, así que hay que devolverle el foco y el cursor
  // o escribir la segunda letra ya no funciona.
  q.oninput = (e) => { mediaQuery = e.target.value; browseShown = BROWSE_PAGE; renderFotos();
    const nq = document.getElementById('fm-all-q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } };
  const more = document.getElementById('fm-all-more');
  if (more) more.onclick = () => { browseShown += BROWSE_PAGE; renderFotos(); };
  wireSelAll(fm, shown);
  wireMediaCards(fm);
}
function renderFotosSubject(fm) {
  const sub = mediaSubject;
  const label = sub ? subjectLabel({ subject_type: sub.type, subject_id: sub.id }) : '';
  fm.innerHTML = `
    <div class="fm-subj-pick">
      <div class="fm-type-toggle">
        <button data-tp="waypoint" class="${(!sub || baseSubjectType(sub.type) === 'waypoint') ? 'sel' : ''}">📍 Punto</button>
        <button data-tp="species" class="${sub && baseSubjectType(sub.type) === 'species' ? 'sel' : ''}">🦋 Especie</button>
      </div>
      <div id="fm-subj-chips"></div>
      <input class="admin-search" id="fm-subj-search" placeholder="🔎 Elegir punto/especie…" value="${sub ? esc(label.replace(/^[^ ]+ /, '')) : ''}">
      <div class="fm-assign-list ${sub ? 'hidden' : ''}" id="fm-subj-list"></div>
    </div>
    <div id="fm-subj-media"></div>`;
  let pt = sub ? baseSubjectType(sub.type) : 'waypoint';
  let chip = 'all';
  // Las subcategorías se redibujan al cambiar de Punto↔Especie porque los chips
  // no son los mismos (tipos + recorridos vs. grupos del inventario).
  const renderChips = () => {
    const box = document.getElementById('fm-subj-chips');
    box.innerHTML = subjectChipsHTML(subjectChips(pt), chip);
    box.querySelectorAll('.fm-subchips button').forEach((b) => b.onclick = () => {
      chip = b.dataset.chip;
      renderChips();
      document.getElementById('fm-subj-list').classList.remove('hidden');
      renderList(document.getElementById('fm-subj-search').value);
    });
  };
  const renderList = (q) => {
    const box = document.getElementById('fm-subj-list');
    const items = subjectList(pt, chip);
    const ql = (q || '').trim().toLowerCase();
    const hit = items.filter((it) => !ql || it.label.toLowerCase().includes(ql) || (it.sub || '').toLowerCase().includes(ql));
    box.innerHTML = hit.slice(0, 60).map((it) => subjectItemHTML(it, pt)).join('')
      || '<div class="admin-note">Nada en esta subcategoría.</div>';
    if (hit.length > 60) box.innerHTML += `<div class="admin-note">…y ${hit.length - 60} más. Afina con un filtro o la búsqueda.</div>`;
    box.querySelectorAll('.fm-assign-item').forEach((b) => b.onclick = () => { mediaSubject = { type: b.dataset.type, id: b.dataset.id }; renderFotos(); });
  };
  fm.querySelectorAll('.fm-type-toggle button').forEach((b) => b.onclick = () => { pt = b.dataset.tp; chip = 'all'; mediaSubject = null; renderChips(); document.getElementById('fm-subj-list').classList.remove('hidden'); renderList(''); });
  const search = document.getElementById('fm-subj-search');
  search.oninput = (e) => { document.getElementById('fm-subj-list').classList.remove('hidden'); renderList(e.target.value); };
  search.onfocus = () => { document.getElementById('fm-subj-list').classList.remove('hidden'); renderList(search.value); };
  renderChips();
  if (!sub) renderList('');
  const mediaBox = document.getElementById('fm-subj-media');
  if (sub) {
    const list = subjectMedia(sub.type, sub.id);
    mediaBox.innerHTML = `
      <button class="admin-add" id="fm-cam-subj">📷 Tomar foto para ${esc(label)}</button>
      <button class="admin-add" id="fm-add-subj">＋ Añadir foto / video a ${esc(label)}</button>
      ${list.length ? `<div class="fm-grid">${list.map((m) => mediaCardHTML(m, { subject: true })).join('')}</div>`
        : '<div class="admin-note" style="text-align:center;padding:16px">Aún sin fotos/videos. Añade una arriba.</div>'}`;
    document.getElementById('fm-add-subj').onclick = () => addMedia({ type: sub.type, id: sub.id });
    document.getElementById('fm-cam-subj').onclick = () => addMedia({ type: sub.type, id: sub.id }, true);
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
  // Sólo suelta la pantalla quien la pidió: el dibujo por vértices nunca la pide,
  // y soltarla aquí se la quitaba al modo guiado o al grabador si estaban activos.
  if (draw && draw.awake) { draw.awake = false; releaseAwake(); }
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
  drawClearDraft();   // la grabación terminó: el trazado ya está en el formulario
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
// `opts` deja reutilizar este mismo dibujo para el TRAZO LIBRE, que necesita dos
// cosas más: pegarse a puntos y senderos (opts.snap) y no salirse de la zona de
// recorrido libre (opts.guard). Un segundo dibujador copiado sería el mismo bug
// dos veces en cuanto uno de los dos cambie.
function startVertexDraw(onDone, opts = {}) {
  if (!drawInit()) { CTX.toast('Espera a que cargue el mapa'); onDone(null); return; }
  draw = { coords: [], onDone, mode: 'vertex' };
  closePanel();
  CTX.map.getCanvas().style.cursor = 'crosshair';
  CTX.toast(opts.hint || 'Toca el mapa para trazar el sendero');
  draw.clickHandler = (e) => {
    let pt = [e.lngLat.lng, e.lngLat.lat];
    const snapped = opts.snap ? opts.snap(pt) : null;
    if (snapped) { pt = snapped.slice(); }
    if (opts.guard && !opts.guard(pt, !!snapped)) { CTX.toast(opts.guardMsg || 'Ahí no se puede'); return; }
    draw.coords.push(pt); drawUpdate(); updateDrawHud();
    if (snapped) CTX.toast('🧲 pegado');
  };
  CTX.map.on('click', draw.clickHandler);
  showDrawHud();
}
// El trazado por GPS vive en RAM mientras se camina. Media hora de sendero se
// perdía entera si el teléfono se quedaba sin batería o el navegador recargaba
// la pestaña — y volver a caminarlo cuesta media hora más. Se guarda una copia
// en localStorage cada pocos puntos y se ofrece retomarla al empezar de nuevo.
const DRAW_KEY = 'cantares_gpsdraw', DRAW_MAX_AGE_MS = 24 * 3600 * 1000;
function drawSaveDraft() {
  if (!draw || draw.mode !== 'gps') return;
  try { localStorage.setItem(DRAW_KEY, JSON.stringify({ ts: Date.now(), coords: draw.coords })); } catch (e) { /* cuota llena */ }
}
function drawLoadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAW_KEY) || 'null');
    if (!d || !Array.isArray(d.coords) || d.coords.length < 2) return null;
    if (Date.now() - (d.ts || 0) > DRAW_MAX_AGE_MS) return null;   // de otro día: ya no sirve
    return d;
  } catch (e) { return null; }
}
function drawClearDraft() { try { localStorage.removeItem(DRAW_KEY); } catch (e) { /* nada que borrar */ } }

function startGpsDraw(onDone) {
  if (!navigator.geolocation) { CTX.toast('GPS no disponible'); return; }
  if (!drawInit()) { CTX.toast('Espera a que cargue el mapa'); onDone(null); return; }
  // ¿Quedó un trazado a medias? Preguntar ANTES de empezar: arrancar de cero
  // encima de una grabación interrumpida es perderla por segunda vez.
  const saved = drawLoadDraft();
  const mins = saved ? Math.round((Date.now() - saved.ts) / 60000) : 0;
  const resume = saved && confirm(`Hay un trazado sin terminar de hace ${mins} min con ${saved.coords.length} puntos. ¿Seguir con él?\n\n(Cancelar empieza uno nuevo y descarta el anterior.)`);
  if (saved && !resume) drawClearDraft();
  draw = { coords: resume ? saved.coords.slice() : [], onDone, mode: 'gps', ema: null, acc: null, warm: 0, paused: false, startTs: null, lastGoodTs: null, awake: true };
  if (resume) { drawUpdate(); CTX.toast(`↩️ Retomando el trazado (${draw.coords.length} puntos)`); }
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
      if (!last || hav(last, draw.ema) > gate) {
        draw.coords.push(draw.ema.slice()); drawUpdate();
        if (draw.coords.length % 5 === 0) drawSaveDraft();   // copia de seguridad cada 5 puntos
      }
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
// Radio de pegue a vértices de OTROS senderos (imán normal) vs. a PUNTOS del mapa
// (WP_SNAP_M, más pequeño: el punto ya no actúa como imán grande y es más fácil
// dejar el sendero cerca de un punto SIN quedar pegado).
const VX_SNAP_M = 12, VX_INSERT_M = 14, WP_SNAP_M = 4;
function otherTrailVertices(exceptId) {
  const out = [];
  (CTX.state.trails || []).forEach((t) => { if (t.properties.id === exceptId) return; (t.geometry.coordinates || []).forEach((c) => out.push(c)); });
  return out;
}
function nearestVertexSnap(c, targets, rad = VX_SNAP_M) {
  let best = null, bd = rad;
  for (const tc of targets) { const d = hav(c, tc); if (d < bd) { bd = d; best = tc; } }
  return best;
}
// Pegue de un vértice/extremo de SENDERO: a otros senderos (radio grande) y a
// PUNTOS del mapa (radio pequeño). Devuelve la mejor coord de pegue dentro de su
// propio radio, o null.
function snapTrailPoint(c, exceptTrailId) {
  const a = nearestVertexSnap(c, otherTrailVertices(exceptTrailId), VX_SNAP_M);
  const b = nearestVertexSnap(c, allWaypointCoords(), WP_SNAP_M);
  if (a && b) return hav(c, a) <= hav(c, b) ? a : b;
  return a || b;
}
// ---- imán del TRAZO LIBRE ----
// Radio más generoso que el de los senderos (VX_SNAP_M = 12, WP_SNAP_M = 4)
// porque aquí sí se QUIERE quedar pegado: un trazo libre existe para unir la
// casa, el vivero o el jardín de colibríes con la red, y se dibuja con el pulgar
// sobre el mapa, no con un ratón. Se pega a PUNTOS y a EXTREMOS de sendero — no
// a cualquier vértice intermedio, que engancharía a media línea sin querer.
const FREE_SNAP_M = 15;
const trailEndpoints = () => {
  const out = [];
  (CTX.state.trails || []).forEach((t) => {
    const cs = (t.geometry && t.geometry.coordinates) || [];
    if (cs.length) { out.push(cs[0]); out.push(cs[cs.length - 1]); }
  });
  return out;
};
function snapFreePoint(c) {
  const a = nearestVertexSnap(c, allWaypointCoords(), FREE_SNAP_M);
  const b = nearestVertexSnap(c, trailEndpoints(), FREE_SNAP_M);
  if (a && b) return hav(c, a) <= hav(c, b) ? a : b;
  return a || b;
}
// Un trazo libre vive DENTRO de la zona de recorrido libre. Se admite un vértice
// fuera sólo si quedó pegado por imán: es como se empalma con un sendero o un
// punto que está justo en el borde, sin tener que abrir la mano y permitir
// dibujar por toda la reserva.
const freeVertexOk = (pt, snapped) => !!snapped || CTX.inFreeRoam(pt);

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
let editMode = false, editSel = null, editHandles = [], editActiveVx = -1, editAddMode = null, editCutMode = false, editExtendMode = false, editMovePt = false;
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
function editDeselect() { editSel = null; editActiveVx = -1; editCutMode = false; editExtendMode = false; editMovePt = false; clearEditHandles(); markSelectedRow(null); hideEditBar(); }

// ¿Hay un modo de elección en curso (senderos, puntos, inicio/fin, recuadro)?
// Mientras dure, el modo edición NO escucha el mapa: si escucha, un mismo toque
// lo procesan dos manejadores y el segundo deshace lo que hizo el primero.
function pickingActive() { return !!(pick || ptSel || ptPickHandler || marquee || draw); }

function editMapClick(e) {
  if (pickingActive()) return;
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
  let q = p; const snap = snapTrailPoint(p, id);
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
  editSel = { kind, id }; editActiveVx = -1; editCutMode = false; editExtendMode = false; editMovePt = false; _selId = id;
  if (tab !== tabForKind(kind)) { tab = tabForKind(kind); renderPanel(); }   // lleva la lista al tipo correcto
  renderEditSelection();
  markSelectedRow(id); scrollRowIntoView(id); updateEditBar();
  // Punto: el panel abierto ya se desplazó a su fila (nada en el mapa); con el
  // panel cerrado, mostrar su ficha igual que fuera del modo edición. Mover el
  // punto es una acción aparte (botón ✋ Mover) para no soltar una manija encima.
  if (kind === 'punto' && panelEl().classList.contains('hidden') && CTX.showPointPopup) CTX.showPointPopup(id);
}
function scrollRowIntoView(id) {
  const row = [...document.querySelectorAll('#admin-body .admin-row')].find((r) => r.dataset.id === id);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function renderEditSelection() {
  clearEditHandles();
  if (!editSel) return;
  if (editSel.kind === 'punto') { if (editMovePt) renderPointHandle(editSel.id); }   // manija sólo al pulsar ✋ Mover
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
      const snap = snapTrailPoint(c2, id);
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
  const label = k === 'punto' ? `📍 Punto${editMovePt ? ' · moviendo' : ''}` : k === 'sendero' ? `✎ Sendero${mode}` : '🧭 Recorrido';
  h.innerHTML = `<span class="adh-n">${label}</span>
    <button id="eb-data">Datos</button>
    ${k === 'punto' ? `<button id="eb-move" class="${editMovePt ? 'adh-on' : ''}">✋ Mover</button>` : ''}
    ${k === 'sendero' ? `<button id="eb-ext" class="${editExtendMode ? 'adh-on' : ''}">➕ Extender</button><button id="eb-cut" class="${editCutMode ? 'adh-on' : ''}">✂️ Cortar</button>` : ''}
    ${k === 'sendero' && editActiveVx >= 0 ? '<button id="eb-del">🗑️ Vértice</button>' : ''}
    ${k === 'recorrido' ? '<button id="eb-order">🧭 Ordenar</button>' : ''}
    <button id="eb-close">✕</button>`;
  const dataBtn = h.querySelector('#eb-data');
  if (dataBtn) dataBtn.onclick = () => { hideEditBar(); const id = editSel.id; if (k === 'punto') editPunto(id); else if (k === 'sendero') editSendero(id); else editRecorrido(id); };
  const mv = h.querySelector('#eb-move');
  if (mv) mv.onclick = () => { editMovePt = !editMovePt; renderEditSelection(); updateEditBar(); CTX.toast(editMovePt ? '✋ Arrastra el punto a su lugar (se pega a senderos cercanos)' : 'Mover: listo'); };
  const ord = h.querySelector('#eb-order');
  if (ord) ord.onclick = () => {
    const r = CTX.state.routesById[editSel.id]; if (!r) return;
    const s = orderSegmentsStartToEnd((r.segments || []), wpCoord(r.start_id), wpCoord(r.end_id));
    const row = routeFullRow({ ...r, segments: s });
    CTX.applyLocalRow('routes', row); saveRow('routes', row).catch((e) => CTX.toast(friendlyErr(e)));
    renderRouteHandles(editSel.id); CTX.toast('🧭 Senderos ordenados inicio → fin');
  };
  const ext = h.querySelector('#eb-ext'); if (ext) ext.onclick = () => { editExtendMode = !editExtendMode; editCutMode = false; updateEditBar(); CTX.toast(editExtendMode ? '➕ Toca un vértice y luego el mapa para extender desde ahí (un vértice del medio crea una rama).' : 'Extender: listo'); };
  const cut = h.querySelector('#eb-cut'); if (cut) cut.onclick = () => { editCutMode = !editCutMode; editExtendMode = false; updateEditBar(); CTX.toast(editCutMode ? '✂️ Toca sobre el sendero donde quieres cortarlo' : 'Corte cancelado'); };
  const del = h.querySelector('#eb-del'); if (del) del.onclick = () => editTrailDeleteVertex(editSel.id, editActiveVx);
  h.querySelector('#eb-close').onclick = editDeselect;
}

// ---------------- resaltar senderos en el mapa ----------------
// Un tramo de recorrido puede ser un sendero de la red o un TRAZO LIBRE propio
// del recorrido que se está editando (`free:<clave>`). `_freePaths` apunta al
// borrador abierto, de modo que trailFeat resuelve los dos y todo lo que cuelga
// de él —trailEnds, segsTouch, orderSegmentsStartToEnd, highlightSegments— trata
// un trazo libre como un tramo más, sin duplicar una línea de lógica.
const FREE_SEG = 'free:';
const isFreeSeg = (id) => String(id || '').startsWith(FREE_SEG);
const freeSegKey = (id) => String(id).slice(FREE_SEG.length);
let _freePaths = {};
function freeSegCoords(id) {
  if (!isFreeSeg(id)) return null;
  const cs = _freePaths[freeSegKey(id)];
  return Array.isArray(cs) && cs.length >= 2 ? cs : null;
}
const trailFeat = (id) => {
  const cs = freeSegCoords(id);
  if (cs) return { type: 'Feature', properties: { id, name: 'Trazo libre', _free: true }, geometry: { type: 'LineString', coordinates: cs } };
  return CTX.state.trails.find((t) => t.properties.id === id);
};
const wpCoord = (pid) => { const w = pid && CTX.state.waypoints.find((x) => x.properties.id === pid); return w ? w.geometry.coordinates : null; };
// Extremos (primer y último vértice) de un sendero.
const trailEnds = (tid) => { const tr = trailFeat(tid); if (!tr) return null; const c = tr.geometry.coordinates; return [c[0], c[c.length - 1]]; };
const segsTouch = (tid, coord, tolM = 35) => { const e = trailEnds(tid); return !!(e && coord && (hav(coord, e[0]) < tolM || hav(coord, e[1]) < tolM)); };
// Ordena una lista de senderos en cadena, arrancando por el más cercano al punto
// de inicio y siguiendo por extremos compartidos. Los senderos NO tienen dirección
// (el orden lo define el recorrido); mejor esfuerzo si la red tiene huecos.
function orderSegmentsStartToEnd(segIds, startCoord, endCoord) {
  const pool = (segIds || []).filter((id) => trailFeat(id));
  if (pool.length <= 1) return pool.slice();
  let startTid = pool[0];
  if (startCoord) { let bd = Infinity; for (const id of pool) { const e = trailEnds(id); const d = Math.min(hav(startCoord, e[0]), hav(startCoord, e[1])); if (d < bd) { bd = d; startTid = id; } } }
  const used = new Set([startTid]), ordered = [startTid];
  const e0 = trailEnds(startTid);
  let tail = startCoord ? (hav(startCoord, e0[0]) <= hav(startCoord, e0[1]) ? e0[1] : e0[0]) : e0[1];
  while (used.size < pool.length) {
    let next = null, nd = Infinity, nextTail = null;
    for (const id of pool) { if (used.has(id)) continue; const e = trailEnds(id);
      const d0 = hav(tail, e[0]), d1 = hav(tail, e[1]);
      if (d0 < nd) { nd = d0; next = id; nextTail = e[1]; }
      if (d1 < nd) { nd = d1; next = id; nextTail = e[0]; }
    }
    if (!next) break;
    used.add(next); ordered.push(next); tail = nextTail;
  }
  return ordered;
}
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
// Resaltado AMARILLO de los puntos seleccionados para un recorrido (halo sobre el punto).
function ensurePtHl() {
  const map = CTX.map;
  if (!styleReady()) return false;
  if (!map.getSource('admin-pt-hl')) {
    try {
      map.addSource('admin-pt-hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'admin-pt-hl-c', type: 'circle', source: 'admin-pt-hl',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 14, 19, 18],
          'circle-color': '#fab814', 'circle-opacity': 0.4,
          'circle-stroke-color': '#fab814', 'circle-stroke-width': 3, 'circle-stroke-opacity': 0.95 } });
    } catch (e) { return false; }
  }
  // Otras capas admin se añaden después (traza del recorrido, manijas): sin esto
  // el halo puede quedar DEBAJO y no verse. moveLayer es barato e idempotente.
  try { map.moveLayer('admin-pt-hl-c'); } catch (e) { /* aún no está */ }
  return true;
}
// Últimos ids pedidos, para poder redibujar cuando el estilo por fin esté listo.
let _ptHlWant = [];
function setPtHl(ids) {
  _ptHlWant = (ids || []).slice();
  // `isStyleLoaded()` devuelve false mientras haya cualquier cambio de estilo
  // pendiente, y applyWaypointFilter toca setPaintProperty a cada rato. Antes,
  // caer en esa ventana significaba NO PINTAR NADA y no enterarse: el usuario
  // tocaba un punto y no pasaba nada. Ahora se reintenta cuando el mapa está
  // quieto, así que el amarillo aparece igual, sólo un instante después.
  if (!ensurePtHl()) {
    if (CTX.map && CTX.map.once) CTX.map.once('idle', () => setPtHl(_ptHlWant));
    return;
  }
  const feats = _ptHlWant.map((pid) => { const w = CTX.state.waypoints.find((x) => x.properties.id === pid); return w ? { type: 'Feature', properties: {}, geometry: w.geometry } : null; }).filter(Boolean);
  CTX.map.getSource('admin-pt-hl').setData({ type: 'FeatureCollection', features: feats });
}
function clearPtHl() {
  _ptHlWant = [];
  const s = styleReady() && CTX.map.getSource('admin-pt-hl');
  if (s) s.setData({ type: 'FeatureCollection', features: [] });
}

// ---------------- elegir senderos en el mapa (crear recorrido interactivo) ----------------
let pick = null, _routeDraft = null;
// Engorda las líneas de sendero mientras se eligen: un dedo no acierta una línea
// de 2 px. Se restaura al salir (el valor de partida vive en app.js).
const TRAIL_W = 2.2, TRAIL_W_PICK = 5;
function trailPickWidth(on) {
  const map = CTX.map;
  if (!styleReady() || !map.getLayer('trails-all')) return;
  try { map.setPaintProperty('trails-all', 'line-width', on ? TRAIL_W_PICK : TRAIL_W); } catch (e) { /* estilo recargando */ }
}
function startRoutePick(id) {
  const map = CTX.map;
  closePanel();
  // Es un MODO, igual que elegir puntos: se apaga el resto de la edición para que
  // el toque no lo capturen dos manejadores a la vez (era la razón por la que la
  // selección "no permitía" elegir: editMapClick deseleccionaba en el mismo tap).
  document.body.classList.add('picking-points');
  hideEditBar();
  pickDim(true);            // puntos atenuados: manda la red de senderos
  trailPickWidth(true);
  map.getCanvas().style.cursor = 'crosshair';
  CTX.toast('Toca los senderos en orden. Toca uno de nuevo para quitarlo.');
  const seg = _routeDraft.segments;
  pick = { id, orig: seg.slice(), handler: null };
  const update = () => { highlightSegments(seg, _routeDraft.color); updatePickHud(seg.length); };
  pick.handler = (e) => {
    // Con TOLERANCIA (misma caja de ~11 px del modo edición). Antes se consultaba
    // un único píxel: en el teléfono casi nunca cae justo encima de la línea.
    const f = queryTrailsAt(e.point);
    if (!f.length) return;
    const tid = f[0].properties.id; if (tid == null) return;
    const i = seg.indexOf(tid);
    if (i >= 0) seg.splice(i, 1); else seg.push(tid);
    update();
  };
  map.on('click', pick.handler);
  // Resaltar el sendero bajo el mouse ANTES de elegirlo (escritorio).
  pick.hover = (e) => {
    const f = queryTrailsAt(e.point);
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
  document.body.classList.remove('picking-points');
  pickDim(false); trailPickWidth(false);
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

// -------- elegir puntos del recorrido TOCÁNDOLOS (se marcan en amarillo) --------
// Toca un punto para añadirlo/quitarlo; queda resaltado en amarillo. ✓ Listo guarda.
let ptSel = null;
// Opacidad de los puntos NO seleccionados mientras se elige. No se ocultan: hay
// que poder tocarlos para añadirlos. Sólo se apagan para que el amarillo cante.
const PICK_DIM = 0.35;

// Atenúa todos los puntos y deja el mapa con lo justo: los puntos, el halo
// amarillo y la traza del recorrido que se está editando.
function pickDim(on) {
  const map = CTX.map;
  if (!styleReady()) return;
  for (const l of ['waypoints-pt', 'trees-pt']) {
    if (!map.getLayer(l)) continue;
    try {
      if (on) {
        map.setPaintProperty(l, 'circle-opacity', PICK_DIM);
        map.setPaintProperty(l, 'circle-stroke-opacity', PICK_DIM);
      } else {
        // Al salir NO se restauran valores a mano: applyWaypointFilter es quien
        // manda sobre la opacidad (depende del recorrido activo). Reponer un
        // número fijo aquí dejaría el mapa mintiendo hasta el siguiente render.
        CTX.applyWaypointFilter && CTX.applyWaypointFilter();
      }
    } catch (e) { /* estilo recargando */ }
  }
}

function startPointPick(id) {
  const map = CTX.map;
  closePanel();
  // Es un MODO: mientras dure, el resto de la edición no está accesible. Antes
  // se podía entrar a dibujar senderos o mover puntos con una selección a medias.
  document.body.classList.add('picking-points');
  hideEditBar();
  map.getCanvas().style.cursor = 'crosshair';
  const sel = new Set((_routeDraft && _routeDraft.memberPoints) || []);
  const layerList = () => ['waypoints-pt', 'trees-pt'].filter((l) => map.getLayer(l));
  // La traza del recorrido que se está editando, para saber por dónde va.
  if (_routeDraft && (_routeDraft.segments || []).length) {
    highlightSegments(_routeDraft.segments, _routeDraft.color || '#fab814');
  } else clearHighlight();
  pickDim(true);

  const say = (msg) => { const h = document.getElementById('admin-ptsel-hud'); const n = h && h.querySelector('.adh-n'); if (n) n.textContent = msg; };
  const count = () => `${sel.size} punto(s)`;
  const redraw = () => { setPtHl([...sel]); say(count()); };
  const click = (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: layerList() });
    if (!f.length) return;   // hay que tocar un punto (no vértices ni líneas)
    const pid = f[0].properties.id; if (pid == null) return;
    const added = !sel.has(pid);
    if (added) sel.add(pid); else sel.delete(pid);
    setPtHl([...sel]);
    // En táctil no hay hover, así que el HUD hace de etiqueta: dice QUÉ punto se
    // acaba de tocar, no sólo cuántos van. Vuelve al conteo solo.
    say(`${added ? '✓' : '✕'} ${wpTitle(pid)} · ${count()}`);
    clearTimeout(ptSel && ptSel.t);
    if (ptSel) ptSel.t = setTimeout(() => say(count()), 2200);
  };
  // Con ratón: posarse encima dice qué punto es, sin seleccionarlo. Es la razón
  // por la que uno toca un punto a veces — para saber cuál es, no para elegirlo.
  const canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  const hover = (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: layerList() });
    map.getCanvas().style.cursor = f.length ? 'pointer' : 'crosshair';
    if (!canHover) return;
    const pid = f.length ? f[0].properties.id : null;
    if (pid === (ptSel && ptSel.hoverId)) return;         // sin repintar en cada píxel
    if (ptSel) ptSel.hoverId = pid;
    if (pid == null) { clearTimeout(ptSel && ptSel.t); say(count()); return; }
    say(`${sel.has(pid) ? '✓ ' : ''}${wpTitle(pid)} · ${count()}`);
  };
  ptSel = { click, hover, sel, id, t: null, hoverId: null };
  map.on('click', click); map.on('mousemove', hover);
  showPtSelHud();
  redraw();
  CTX.toast('Toca los puntos del recorrido — se marcan en amarillo. Toca de nuevo para quitar. Luego ✓ Listo.');
}
function showPtSelHud() {
  let h = document.getElementById('admin-ptsel-hud');
  if (!h) { h = document.createElement('div'); h.id = 'admin-ptsel-hud'; h.className = 'admin-draw-hud'; (document.getElementById('view-recorridos') || document.body).appendChild(h); }
  h.innerHTML = '<span class="adh-n">0 punto(s)</span><button class="adh-done" id="pts-done">✓ Listo</button><button id="pts-cancel">✕</button>';
  h.querySelector('#pts-done').onclick = () => endPointPick(true);
  h.querySelector('#pts-cancel').onclick = () => endPointPick(false);
}
function endPointPick(keep) {
  const map = CTX.map, st = ptSel; ptSel = null;
  if (st) { map.off('click', st.click); map.off('mousemove', st.hover); clearTimeout(st.t); }
  map.getCanvas().style.cursor = '';
  document.body.classList.remove('picking-points');
  pickDim(false);                 // devuelve la opacidad a quien manda sobre ella
  const h = document.getElementById('admin-ptsel-hud'); if (h) h.remove();
  clearPtHl();
  clearHighlight();
  if (keep && st && _routeDraft) _routeDraft.memberPoints = [...st.sel];   // ✕ = descarta esta sesión
  openPanel(); editRecorrido(st ? st.id : null);
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
    <button class="admin-add" id="fz-edit">🏠 Zona de recorrido libre…</button>
    <input class="admin-search" placeholder="🔎 Buscar sendero… (toca para verlo en el mapa)">
    <div class="admin-list">${trails.map((tr) => `
      <div class="admin-row" data-id="${esc(tr.properties.id)}">
        <span class="admin-row-t">${esc(tr.properties.name || tr.properties.id)} <i>${esc((tr.properties.routes || []).join(', '))}</i></span>
        <button class="admin-edit" data-id="${esc(tr.properties.id)}">Editar</button>
      </div>`).join('')}</div>`;
  body.querySelector('#tr-add').onclick = () => editSendero(null);
  body.querySelector('#fz-edit').onclick = editZonaLibre;
  body.querySelectorAll('.admin-edit').forEach((b) => b.onclick = (e) => { e.stopPropagation(); editSendero(b.dataset.id); });
  wireList('sendero');
  if (_selId) markSelectedRow(_selId);
}

// ---------------- zona de recorrido libre (el claro de la casa) ----------------
// Un solo polígono, guardado como un documento más de la tabla `content`
// (id 'freeroam') — sin migración, con las políticas RLS que ya existen y
// pasando por la cola offline como cualquier otro cambio. Dentro de él los
// recorridos se dibujan rectos (ver freeRoamPath en app.js).
const freeRoamRingOf = () => { const d = CTX.freeRoam && CTX.freeRoam(); const p = d && d.polygon; return Array.isArray(p) && p.length >= 4 ? p : null; };
function showFreeRoam(ring) {
  if (ring) setHl([{ type: 'Feature', properties: { _c: '#ffd000' }, geometry: { type: 'LineString', coordinates: ring } }]);
  else clearHighlight();
}
function editZonaLibre() {
  const body = document.getElementById('admin-body');
  const ring = freeRoamRingOf();
  showFreeRoam(ring);
  body.innerHTML = `
    <div class="admin-form">
      <div class="admin-group-h">🏠 Zona de recorrido libre</div>
      <div class="admin-note">El claro de la casa no es sendero: es pasto. Dentro de esta zona los recorridos
        se trazan en <b>línea recta</b> entre por donde entran y por donde salen, en vez de repetir el zigzag
        con que se grabó la traza. Dibuja el borde tocando el mapa; se cierra solo.</div>
      <div class="admin-loc">
        <span id="fz-state">${ring ? `${ring.length - 1} vértices · ${fmtLen(ring)} de borde` : 'sin definir'}</span>
        <div class="admin-loc-btns">
          <button type="button" class="admin-pick" id="fz-draw">✏️ ${ring ? 'Dibujar de nuevo' : 'Dibujar'}</button>
          ${ring ? '<button type="button" class="admin-pick" id="fz-del">🗑️ Quitar</button>' : ''}
        </div>
      </div>
      <div class="admin-err" id="fz-err"></div>
      <div class="admin-actions"><button class="admin-cancel" id="fz-back">Volver</button></div>
    </div>`;
  body.querySelector('#fz-back').onclick = () => { clearHighlight(); renderSenderos(); };
  body.querySelector('#fz-draw').onclick = () => {
    clearHighlight();
    CTX.toast('Toca el mapa alrededor de la casa. ✓ Terminar cierra el polígono.');
    startVertexDraw(async (coords) => {
      if (!coords) { editZonaLibre(); return; }
      if (coords.length < 3) { editZonaLibre(); document.getElementById('fz-err').textContent = 'Un polígono necesita al menos 3 vértices.'; return; }
      const closed = coords.concat([coords[0]]);   // anillo cerrado
      await saveFreeRoam({ polygon: closed });
    });
  };
  const del = body.querySelector('#fz-del');
  if (del) del.onclick = async () => {
    if (!confirm('¿Quitar la zona de recorrido libre? Los recorridos volverán a seguir la traza original.')) return;
    await saveFreeRoam({ polygon: [] });
  };
}
async function saveFreeRoam(doc) {
  const body = document.getElementById('admin-body');
  const err = body && body.querySelector('#fz-err');
  try {
    const res = await saveRow('content', { id: 'freeroam', doc });
    CTX.setFreeRoam && CTX.setFreeRoam(doc);       // el trazado se recalcula ya, sin recargar
    editZonaLibre();
    CTX.toast(res.queued ? '💾 Zona guardada en el teléfono — se subirá con señal' : 'Zona guardada');
  } catch (e) {
    if (err) err.textContent = friendlyErr(e);
    else CTX.toast(friendlyErr(e));
  }
}
function editSendero(id) {
  const body = document.getElementById('admin-body');
  const existing = id ? CTX.state.trails.find((t) => t.properties.id === id) : null;
  const draft = CTX._draftTrail; CTX._draftTrail = null;
  const p = existing ? { ...existing.properties } : { id: (draft && draft.id) || rid('sendero'), routes: [] };
  if (draft) { p.name = draft.name; p.routes = draft.routes; }
  let coords = CTX._draftLine ? CTX._draftLine : (existing ? existing.geometry.coordinates.slice() : null);
  CTX._draftLine = null;
  body.innerHTML = `
    <div class="admin-form">
      <label>Nombre</label><input id="tr-name" value="${esc(p.name)}">
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
  const saveDraft = () => { CTX._draftTrail = { id: p.id, name: body.querySelector('#tr-name').value, routes: (p.routes || []).slice() }; };
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
    const routes = (p.routes || []).slice();   // se conservan: el recorrido manda, no el sendero
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
  _freePaths = {};   // se sale del editor: ningún borrador de trazos abierto
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
// Reordenar la lista de senderos ARRASTRANDO (⠿). Con Pointer Events, no con el
// drag&drop de HTML5: ese no existe en móvil y este panel se usa con el pulgar.
// Mueve el <li> en el DOM mientras arrastras y, al soltar, devuelve el nuevo
// orden como índices del array original (`onDrop([2,0,1])`).
function wireSegDrag(ol, onDrop) {
  if (!ol) return;
  // La captura y los listeners van sobre el <ol>, que NO se mueve — nunca sobre
  // el grip. El grip vive dentro del <li> que este código mueve con
  // insertBefore, y mover un nodo lo saca antes del documento: eso libera la
  // captura de puntero, así que al primer reordenamiento dejaban de llegar
  // pointermove/pointerup, `end` no corría y `onDrop` no se llamaba nunca. La
  // lista se veía reordenada, pero segWork no cambiaba y el <li> se quedaba
  // fantasma con la clase .dragging.
  ol.querySelectorAll('.seg-grip').forEach((g) => g.onpointerdown = (ev) => {
    const li = g.closest('li'); if (!li) return;
    ev.preventDefault(); ol.setPointerCapture(ev.pointerId);
    li.classList.add('dragging');          // el CSS le quita pointer-events: si no,
                                           // elementFromPoint devolvería el propio li
    const move = (e) => {
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const t = over && over.closest('li');
      if (!t || t === li || t.parentElement !== ol) return;
      const r = t.getBoundingClientRect();
      ol.insertBefore(li, (e.clientY < r.top + r.height / 2) ? t : t.nextSibling);
    };
    const end = () => {
      ol.removeEventListener('pointermove', move);
      ol.removeEventListener('pointerup', end); ol.removeEventListener('pointercancel', end);
      li.classList.remove('dragging');
      onDrop([...ol.children].map((n) => +n.dataset.i));
    };
    ol.addEventListener('pointermove', move);
    ol.addEventListener('pointerup', end); ol.addEventListener('pointercancel', end);
  });
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
  // Trazos libres del recorrido: { clave: [[lng,lat], ...] }. Se referencian
  // desde segWork como `free:<clave>`, así que su sitio en el recorrido es una
  // posición en la lista de tramos, igual que un sendero. `_freePaths` apunta a
  // este borrador para que trailFeat —y con él el resaltado, el orden y los
  // avisos de empalme— los trate como un tramo más mientras se edita.
  let freeWork = JSON.parse(JSON.stringify(r.freeroam_paths || {}));
  _freePaths = freeWork;
  let color = r.color || PALETTE[0], emoji = r.emoji || EMOJIS[0];
  // Puntos del recorrido: inicio, fin e intermedios (por membresía point.routes).
  let startId = r.start_id || null, endId = r.end_id || null;
  let memberWork = new Set(Array.isArray(r.memberPoints) ? r.memberPoints
    : CTX.state.waypoints.filter((w) => (w.properties.routes || []).includes(r.id)).map((w) => w.properties.id));
  if (startId) memberWork.add(startId);
  if (endId) memberWork.add(endId);
  // Guiones por punto (audioguía): { [pointId]: {es, en} }. Se leen en voz alta
  // al llegar a cada punto DURANTE ESTE recorrido. Un punto sin guión no suena.
  let scriptWork = { ...(r.scripts || {}) };
  const wpTitle = (pid) => { const w = CTX.state.waypoints.find((x) => x.properties.id === pid); return w ? (CTX.L(w.properties, 'title') || w.properties.title || pid) : pid; };
  body.innerHTML = `
    <div class="admin-form">
      <label>Nombre (ES)</label><input id="rt-name" value="${esc(r.name)}">
      <label>Name (EN)</label><input id="rt-name-en" value="${esc(r.name_en)}">
      <label>Emoji</label><div class="admin-emojis" id="rt-emojis">${EMOJIS.map((e) => `<button type="button" class="admin-emoji ${e === emoji ? 'sel' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
      <label>Color</label><div class="admin-palette" id="rt-palette">${PALETTE.map((c) => `<button type="button" class="admin-sw ${c === color ? 'sel' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <label>Resumen (ES)</label><textarea id="rt-sum" rows="2">${esc(r.summary)}</textarea>
      <label>Summary (EN)</label><textarea id="rt-sum-en" rows="2">${esc(r.summary_en)}</textarea>
      <label>Duración medida (min) <span class="admin-note">— déjalo vacío para que la calcule la app</span></label>
      <input id="rt-dur" type="number" min="0" step="5" value="${r.duration_min == null ? '' : r.duration_min}" placeholder="p. ej. 105">

      <div class="admin-group-h">🚩 Puntos del recorrido</div>
      <label>Punto de inicio</label>
      <div class="admin-loc"><span id="rt-start-lbl">${startId ? esc(wpTitle(startId)) : 'sin fijar'}</span>
        <button type="button" class="admin-pick" id="rt-start-pick">📍 Elegir en el mapa</button></div>
      <label>Punto de fin</label>
      <div class="admin-loc"><span id="rt-end-lbl">${endId ? esc(wpTitle(endId)) : 'sin fijar'}</span>
        <button type="button" class="admin-pick" id="rt-end-pick">🏁 Elegir en el mapa</button></div>
      <label>Puntos del recorrido</label>
      <div class="admin-loc"><span id="rt-mem-lbl">${memberWork.size} punto(s)</span>
        <div class="admin-loc-btns">
          <button type="button" class="admin-pick" id="rt-mem-pick">🖐️ Tocar puntos en el mapa</button>
          <button type="button" class="admin-pick" id="rt-mem-clear">Limpiar</button>
        </div></div>
      <div class="admin-note">Solo puntos del mapa (no vértices de senderos). Al tocar «🖐️ Tocar puntos» el mapa se queda con lo justo: los puntos atenuados, los elegidos en amarillo y la traza de este recorrido. Toca un punto para añadirlo o quitarlo — arriba se ve cuál es. Al terminar, ✓ Listo (✕ descarta).</div>

      <div class="admin-group-h">🎙️ Guiones por punto (audioguía)</div>
      <div class="admin-note">Escribe el guión de cada punto <em>para este recorrido</em>. Al llegar al punto durante el recorrido, el teléfono lo lee en voz alta (como una audioguía de museo). El mismo punto puede tener otro guión en otro recorrido. Un punto sin guión no activa audio.</div>
      <div id="rt-scripts"></div>

      <div class="admin-group-h">🥾 Senderos del recorrido (en orden)</div>
      <button type="button" class="admin-pick map-pick" id="rt-pick">🗺️ Elegir senderos en el mapa</button>
      <div id="rt-segs"></div>
      <div class="admin-note">El orden define la dirección: el primer sendero debe empezar en el punto de inicio y el último terminar en el de fin. Usa “🧭 Ordenar inicio → fin” para encadenarlos solos, arrastra ⠿ para reordenar a mano, y ⧉ para repetir un sendero (volver por donde viniste).</div>
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
    // Marca el 1º y último si NO tocan el punto de inicio/fin (aviso visual).
    const badFirst = segWork.length && startId && !segsTouch(segWork[0], wpCoord(startId));
    const badLast = segWork.length && endId && !segsTouch(segWork[segWork.length - 1], wpCoord(endId));
    el.innerHTML = `
      <ol class="admin-seglist">${segWork.map((tid, i) => {
        const warn = (i === 0 && badFirst) ? ' ⚠️' : (i === segWork.length - 1 && badLast) ? ' ⚠️' : '';
        // Un trazo libre se ve distinto (✏️) porque se edita distinto: no se
        // elige de una lista, se dibuja. El resto de botones son los mismos.
        if (isFreeSeg(tid)) {
          const cs = freeSegCoords(tid);
          const label = cs ? `✏️ Trazo libre · ${cs.length} pts` : '✏️ Trazo libre (vacío) ⚠️';
          return `<li data-i="${i}" class="seg-free"><span>${label}${warn}</span><span class="admin-seg-btns"><button type="button" class="seg-grip" title="Arrastrar para reordenar">⠿</button><button type="button" data-redraw="${i}" title="Volver a dibujar este trazo">✏️</button><button type="button" data-rm="${i}">✕</button></span></li>`;
        }
        const tr = CTX.state.trails.find((t) => t.properties.id === tid);
        return `<li data-i="${i}"><span>${esc(tr ? tr.properties.name || tid : tid)}${warn}</span><span class="admin-seg-btns"><button type="button" class="seg-grip" title="Arrastrar para reordenar">⠿</button><button type="button" data-dup="${i}" title="Duplicar (p. ej. volver por el mismo sendero)">⧉</button><button type="button" data-rm="${i}">✕</button></span></li>`; }).join('')}</ol>
      <div class="admin-loc-btns" style="margin:2px 0 6px">
        <button type="button" class="admin-pick" id="rt-seg-order">🧭 Ordenar inicio → fin</button>
        <button type="button" class="admin-pick" id="rt-seg-free" title="Dibujar por donde no hay sendero, dentro de la zona de recorrido libre">✏️ ＋ Trazo libre</button>
      </div>
      ${pickerHTML('rt-segsel', '🔎 ＋ añadir sendero… (escribe para filtrar)')}`;
    wirePicker(el, 'rt-segsel', CTX.state.trails.map((t) => ({ id: t.properties.id, label: t.properties.name || t.properties.id })),
      (tid) => { segWork.push(tid); renderSegs(); });
    el.querySelector('#rt-seg-order').onclick = () => { segWork = orderSegmentsStartToEnd(segWork, wpCoord(startId), wpCoord(endId)); renderSegs(); };
    // ✏️ Trazo libre: dibujar por donde NO hay sendero, sin crear uno. Entra en
    // la lista como un tramo más, así que su sitio en el recorrido es explícito
    // (se arrastra, se reordena) en vez de deducido por cercanía.
    el.querySelector('#rt-seg-free').onclick = () => drawFree(null);
    el.querySelectorAll('[data-redraw]').forEach((b) => b.onclick = () => drawFree(+b.dataset.redraw));
    // ⧉ Duplicar: el MISMO sendero otra vez, justo detrás. Un recorrido de ida y
    // vuelta pasa dos veces por el mismo tramo; al encadenar, el segundo se orienta
    // solo en sentido contrario (ver orderedPathFromSegments en app.js).
    el.querySelectorAll('[data-dup]').forEach((b) => b.onclick = () => { const i = +b.dataset.dup; segWork.splice(i + 1, 0, segWork[i]); renderSegs(); });
    el.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { segWork.splice(+b.dataset.rm, 1); renderSegs(); });
    wireSegDrag(el.querySelector('.admin-seglist'), (order) => { segWork = order.map((i) => segWork[i]); renderSegs(); });
    highlightSegments(segWork, color);   // iluminar solo los elegidos, en el color del recorrido
    renderScriptsBlock();   // cambiar los senderos cambia el orden de los guiones
  };
  // Un textarea (ES/EN) por punto miembro. Se sincroniza a scriptWork en cada
  // tecla para sobrevivir a los re-render (elegir puntos/senderos en el mapa).
  const renderScriptsBlock = () => {
    const el = document.getElementById('rt-scripts'); if (!el) return;
    // En el ORDEN del recorrido (proyectando cada punto sobre el trazado), no en
    // el orden en que se fueron tocando en el mapa: escribir la audioguía es
    // seguir el camino, y saltar de un punto a otro sin orden es imposible.
    // Se pasa TAMBIÉN el punto de fin: sin senderos elegidos no había trazado
    // sobre el que proyectar y la lista salía en el orden en que se fueron
    // tocando los puntos en el mapa. Con inicio + fin el orden se deduce por la
    // red de senderos (ver orderPointsAlongSegments en app.js).
    const ids = CTX.orderPointsAlongSegments
      ? CTX.orderPointsAlongSegments(segWork, [...memberWork], startId, endId, freeWork)
      : [...memberWork];
    // El número delante hace visible el orden: si sale mal, se ve aquí y no en
    // el monte con la audioguía contando el punto 4 antes que el 2.
    el.innerHTML = ids.length ? ids.map((pid, i) => {
      const sc = scriptWork[pid] || {};
      const tag = pid === startId ? ' 🚩' : pid === endId ? ' 🏁' : '';
      return `<div class="admin-script" data-pid="${esc(pid)}">
        <div class="admin-script-h"><span class="sc-n">${i + 1}</span> 📍 ${esc(wpTitle(pid))}${tag}</div>
        <textarea class="sc-es" rows="2" placeholder="Guión en español (se lee al llegar)">${esc(sc.es)}</textarea>
        <textarea class="sc-en" rows="2" placeholder="Script in English (optional)">${esc(sc.en)}</textarea>
      </div>`; }).join('')
      : '<div class="admin-note">Agrega puntos al recorrido (arriba) para escribirles un guión.</div>';
    el.querySelectorAll('.admin-script').forEach((d) => {
      const pid = d.dataset.pid;
      const sync = () => {
        const es = d.querySelector('.sc-es').value.trim(), en = d.querySelector('.sc-en').value.trim();
        if (es || en) scriptWork[pid] = { es: es || null, en: en || null }; else delete scriptWork[pid];
      };
      d.querySelector('.sc-es').oninput = sync;
      d.querySelector('.sc-en').oninput = sync;
    });
  };
  renderSegs();   // pinta senderos Y guiones (en el orden del recorrido)
  const saveDraft = () => { _routeDraft = { id: r.id, _new: !id, sort: r.sort,
    name: body.querySelector('#rt-name').value, name_en: body.querySelector('#rt-name-en').value,
    emoji, color, summary: body.querySelector('#rt-sum').value, summary_en: body.querySelector('#rt-sum-en').value,
    start_id: startId, end_id: endId, memberPoints: [...memberWork], scripts: scriptWork,
    segments: segWork.slice(), freeroam_paths: freeWork,
    duration_min: body.querySelector('#rt-dur').value }; };
  // Dibujar un trazo libre (nuevo si atIndex es null, o volver a dibujar el de
  // esa posición). Dibujar cierra el panel, así que el formulario se guarda antes
  // y se reabre después — el mismo ida y vuelta que usa el editor de senderos.
  const newFreeKey = () => { let n = 1; while (freeWork['l' + n]) n++; return 'l' + n; };
  const drawFree = (atIndex) => {
    const ring = (CTX.freeRoam() || {}).polygon;
    if (!Array.isArray(ring) || ring.length < 4) {
      CTX.toast('Primero hay que dibujar la zona de recorrido libre (pestaña Senderos)'); return;
    }
    saveDraft();
    startVertexDraw((c) => {
      if (c && c.length >= 2) {
        const key = atIndex == null ? newFreeKey() : freeSegKey(segWork[atIndex]);
        _routeDraft.freeroam_paths = { ..._routeDraft.freeroam_paths, [key]: c };
        if (atIndex == null) _routeDraft.segments = [...(_routeDraft.segments || []), FREE_SEG + key];
      }
      editRecorrido(id);
    }, { snap: snapFreePoint, guard: freeVertexOk,
      guardMsg: 'Fuera de la zona de recorrido libre. Para empalmar, toca justo sobre un punto o el extremo de un sendero.',
      hint: 'Toca dentro de la zona para trazar. Se pega solo a puntos y extremos de sendero.' });
  };
  body.querySelector('#rt-pick').onclick = () => { saveDraft(); startRoutePick(id); };
  body.querySelector('#rt-start-pick').onclick = () => { saveDraft(); pickRoutePoint(id, 'start'); };
  body.querySelector('#rt-end-pick').onclick = () => { saveDraft(); pickRoutePoint(id, 'end'); };
  body.querySelector('#rt-mem-pick').onclick = () => { saveDraft(); startPointPick(id); };
  body.querySelector('#rt-mem-clear').onclick = () => { memberWork.clear(); if (startId) memberWork.add(startId); if (endId) memberWork.add(endId); document.getElementById('rt-mem-lbl').textContent = `${memberWork.size} punto(s)`; renderScriptsBlock(); };
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
    // Aviso (no bloquea): el 1º sendero debería empezar en el inicio y el último terminar en el fin.
    if (segWork.length && startId && endId) {
      const okFirst = segsTouch(segWork[0], wpCoord(startId)), okLast = segsTouch(segWork[segWork.length - 1], wpCoord(endId));
      if (!(okFirst && okLast) && !confirm('El primer sendero no empieza en el punto de inicio o el último no termina en el de fin. ¿Guardar de todos modos? (Puedes usar “🧭 Ordenar inicio → fin”.)')) return;
    }
    // Guardar solo los guiones de puntos que siguen en el recorrido.
    const scripts = {}; for (const pid of memberWork) if (scriptWork[pid]) scripts[pid] = scriptWork[pid];
    // Y sólo los trazos libres que siguen referenciados desde la lista de tramos:
    // quitar el tramo de la lista es lo que borra el trazo, sin dejar geometría
    // huérfana engordando la fila.
    const freePaths = {};
    for (const sid of segWork) if (isFreeSeg(sid)) { const k = freeSegKey(sid); if (freeWork[k]) freePaths[k] = freeWork[k]; }
    const row = { id: r.id, name: body.querySelector('#rt-name').value.trim() || null, name_en: body.querySelector('#rt-name-en').value.trim() || null,
      emoji, color, summary: body.querySelector('#rt-sum').value.trim() || null, summary_en: body.querySelector('#rt-sum-en').value.trim() || null,
      start_id: startId || null, end_id: endId || null,
      segments: segWork, scripts, freeroam_paths: freePaths, sort: r.sort || 0,
      // Un numero medido caminando gana sobre cualquier modelo. Vacio = que lo calcule la app.
      duration_min: (body.querySelector('#rt-dur').value || '').trim() === '' ? null : Math.max(0, Math.round(+body.querySelector('#rt-dur').value)) || null };
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

// Cantares — editor de administrador (sin código). Permite a los dueños añadir y
// cambiar puntos del mapa, textos, imágenes y especies del inventario, escribiendo
// directo a Supabase. Sólo se activa para cuentas con rol 'admin'.
import { isAdmin, upsertWaypoint, deleteWaypoint, upsertSpecies, deleteSpecies, uploadImage } from './cloud.js';
import { doLogout } from './auth-ui.js';

let CTX = null;
const TIPOS = ['mirador', 'avistamiento', 'agua', 'flora', 'servicio', 'punto'];
const GROUPS = ['flora', 'ave', 'mamifero', 'anfibio', 'otro'];
const rid = (pfx) => `${pfx}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;

// ctx: { state, map, t, L, LANG, toast, refreshWaypoints, refreshSpecies }
export function initAdmin(ctx) {
  CTX = ctx;
  if (!isAdmin()) return;
  document.body.classList.add('is-admin');
  const fab = document.createElement('button');
  fab.id = 'admin-fab'; fab.className = 'admin-fab'; fab.title = 'Administrar';
  fab.textContent = '🛠️';
  fab.onclick = openPanel;
  (document.getElementById('view-recorridos') || document.body).appendChild(fab);
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
      <button class="admin-tab ${tab === 'especies' ? 'sel' : ''}" data-t="especies">Especies</button>
    </div>
    <div class="admin-body" id="admin-body"></div>`;
  el.querySelector('#admin-x').onclick = closePanel;
  el.querySelector('#admin-logout').onclick = doLogout;
  el.querySelectorAll('.admin-tab').forEach((b) => b.onclick = () => { tab = b.dataset.t; renderPanel(); });
  (tab === 'puntos' ? renderPuntos : renderEspecies)();
}

// ---------------- PUNTOS ----------------
function renderPuntos() {
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
  const p = existing ? existing.properties : { id: rid('punto'), routes: [], species_ids: [], tipo: 'punto' };
  const coords = existing ? existing.geometry.coordinates : (CTX._pendingLoc || null);
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
        </div>
      </div>
      <div class="admin-err" id="f-err"></div>
      <div class="admin-actions">
        <button class="admin-save" id="f-save">Guardar</button>
        ${id ? '<button class="admin-del" id="f-del">Eliminar</button>' : ''}
        <button class="admin-cancel" id="f-cancel">Cancelar</button>
      </div>
    </div>`;
  let loc = coords ? coords.slice() : null;
  let photoUrl = p.photo || null;
  const setLoc = (lng, lat) => { loc = [lng, lat]; const s = body.querySelector('#f-loc'); if (s) s.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`; };

  body.querySelector('#f-gps').onclick = () => {
    if (!navigator.geolocation) { CTX.toast('GPS no disponible'); return; }
    const btn = body.querySelector('#f-gps'); const orig = btn.textContent; btn.textContent = 'Buscando…'; btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLoc(pos.coords.longitude, pos.coords.latitude); btn.textContent = orig; btn.disabled = false; CTX.toast(`📡 Ubicación fijada (±${Math.round(pos.coords.accuracy)} m)`); },
      (e) => { btn.textContent = orig; btn.disabled = false; CTX.toast(e.code === 1 ? 'Permiso de ubicación denegado' : 'No se pudo obtener ubicación'); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  };
  body.querySelector('#f-pick').onclick = () => {
    CTX.toast('Toca el mapa para fijar el punto');
    closePanel();
    CTX.map.getCanvas().style.cursor = 'crosshair';
    CTX.map.once('click', (e) => {
      loc = [e.lngLat.lng, e.lngLat.lat];
      CTX.map.getCanvas().style.cursor = '';
      CTX._pendingLoc = loc;
      openPanel(); editPunto(id);   // reabrir con la ubicación fijada
      CTX._pendingLoc = null;
    });
  };
  body.querySelector('#f-photo').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    body.querySelector('#f-err').textContent = 'Subiendo imagen…';
    try { photoUrl = await uploadImage(file, 'waypoints'); body.querySelector('#f-photo-prev').style.backgroundImage = `url('${photoUrl}')`; body.querySelector('#f-err').textContent = ''; }
    catch (err) { body.querySelector('#f-err').textContent = 'Error subiendo imagen: ' + err.message; }
  };
  body.querySelector('#f-cancel').onclick = renderPuntos;
  if (id) body.querySelector('#f-del').onclick = async () => {
    if (!confirm('¿Eliminar este punto?')) return;
    try { await deleteWaypoint(id); await CTX.refreshWaypoints(); renderPuntos(); CTX.toast('Punto eliminado'); }
    catch (err) { body.querySelector('#f-err').textContent = err.message; }
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
    try { await upsertWaypoint(row); await CTX.refreshWaypoints(); renderPuntos(); CTX.toast('Punto guardado'); }
    catch (err) { body.querySelector('#f-err').textContent = err.message; }
  };
}

// ---------------- ESPECIES ----------------
function renderEspecies() {
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
  body.querySelector('#s-photo').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    body.querySelector('#s-err').textContent = 'Subiendo imagen…';
    try { photoUrl = await uploadImage(file, 'species'); body.querySelector('#s-photo-prev').style.backgroundImage = `url('${photoUrl}')`; body.querySelector('#s-err').textContent = ''; }
    catch (err) { body.querySelector('#s-err').textContent = 'Error subiendo imagen: ' + err.message; }
  };
  body.querySelector('#s-cancel').onclick = renderEspecies;
  if (id) body.querySelector('#s-del').onclick = async () => {
    if (!confirm('¿Eliminar esta especie?')) return;
    try { await deleteSpecies(id); await CTX.refreshSpecies(); renderEspecies(); CTX.toast('Especie eliminada'); }
    catch (err) { body.querySelector('#s-err').textContent = err.message; }
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
    try { await upsertSpecies(row); await CTX.refreshSpecies(); renderEspecies(); CTX.toast('Especie guardada'); }
    catch (err) { body.querySelector('#s-err').textContent = err.message; }
  };
}

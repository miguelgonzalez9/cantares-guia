// Cantares — cola offline (outbox). Los cambios del admin se guardan PRIMERO en
// el teléfono (IndexedDB) y se suben a Supabase automáticamente cuando hay señal
// (al volver el internet, al volver a la app, o cada minuto). Así se puede crear
// senderos y puntos en plena montaña sin cobertura.
import { cloudConfigured, uploadImage, upsertWaypoint, deleteWaypoint, upsertSpecies, deleteSpecies,
  upsertTrail, deleteTrail, upsertRoute, deleteRoute, upsertSighting, upsertWalk, deleteWalkCloud,
  upsertMedia, deleteMedia } from './cloud.js';

const UPSERT = { waypoints: upsertWaypoint, trails: upsertTrail, routes: upsertRoute, species: upsertSpecies,
  sightings: upsertSighting, walks: upsertWalk, media: upsertMedia };
const REMOVE = { waypoints: deleteWaypoint, trails: deleteTrail, routes: deleteRoute, species: deleteSpecies,
  walks: deleteWalkCloud, media: deleteMedia };
// La clave de cada fila: id normal, o client_id (avistamientos: el id del
// servidor lo genera la base; el cliente identifica por client_id).
const rowKey = (row) => row.id != null ? row.id : row.client_id;
const WRITE_TIMEOUT = 15000, UPLOAD_TIMEOUT = 60000;

// ---------- IndexedDB (persiste blobs de fotos, sobrevive recargas) ----------
const DB_NAME = 'cantares-outbox', STORE = 'ops';
let _db = null;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(op) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(op); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
async function idbDel(key) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(key); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
export async function pendingOps() {
  const d = await db();
  return new Promise((res, rej) => {
    const rq = d.transaction(STORE).objectStore(STORE).getAll();
    rq.onsuccess = () => res((rq.result || []).sort((a, b) => a.ts - b.ts));
    rq.onerror = () => rej(rq.error);
  });
}
async function idbGet(key) {
  const d = await db();
  return new Promise((res) => { const rq = d.transaction(STORE).objectStore(STORE).get(key); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); });
}

// ---------- helpers ----------
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: sin respuesta de la red')), ms))]);
// ¿El error es de red (reintentable) o real (permisos / datos inválidos)?
function isNetErr(e) {
  if (!navigator.onLine) return true;
  const m = (e && e.message) || String(e || '');
  return (e && e.name === 'TypeError') || /fetch|network|timeout|load failed|abort|conex/i.test(m);
}
// Extensión coherente con el tipo del blob (jpg por defecto; mp4/webm para video),
// para que la subida a Storage no bautice un video como .jpg.
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const blobFile = (b, id) => {
  const type = b.type || 'image/jpeg';
  const ext = EXT[type] || (type.startsWith('video/') ? 'mp4' : 'jpg');
  return new File([b], `${id}_${Date.now().toString(36)}.${ext}`, { type });
};

// ---------- compresión de fotos (celular: 5–12 MB → ~200–400 KB) ----------
export async function compressImage(file, maxDim = 1600, quality = 0.82) {
  if (!file || !/^image\//.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);   // respeta la orientación EXIF
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return (blob && blob.size < file.size) ? blob : file;   // si no ayuda, subir tal cual
  } catch (e) { return file; }   // formato raro (HEIC viejo, etc.) → subir original
}

// ---------- guardar / eliminar con caída a la cola ----------
// `blobs`: una foto (→ campo 'photo') o un mapa { campo: Blob } para varias
// fotos (p.ej. { photo, photo_leaf } de un árbol). Cada blob se sube y su URL
// se guarda en su campo. Sin señal, todo (incl. los blobs) espera en la cola.
function toBlobMap(blobs) {
  if (!blobs) return null;
  if (blobs instanceof Blob) return { photo: blobs };
  const m = {}; for (const f in blobs) if (blobs[f]) m[f] = blobs[f];
  return Object.keys(m).length ? m : null;
}
async function uploadBlobs(r, map, table, key) {
  for (const f in map) r[f] = await withTimeout(uploadImage(blobFile(map[f], key), table), UPLOAD_TIMEOUT);
}
export async function saveRow(table, row, blobs = null) {
  const map = toBlobMap(blobs);
  let uploaded = null;          // fila con las URLs ya subidas (si la subida pasó)
  let softError = null;         // error del servidor (esquema/permiso) — se encola igual
  if (cloudConfigured() && navigator.onLine) {
    try {
      const r = { ...row };
      if (map) await uploadBlobs(r, map, table, rowKey(row));
      uploaded = r;             // subida OK; si el upsert falla, encolamos r sin blobs
      await withTimeout(UPSERT[table](r), WRITE_TIMEOUT);
      return { queued: false, row: r };
    } catch (e) {
      // NUNCA descartar el trabajo de campo. Error de red O real (columna faltante,
      // permiso, dato inválido): se encola y se reintenta. Si es un error real y
      // persistente, flushOutbox avisa por onStuck tras varios intentos; al
      // corregir el esquema/sesión, sincroniza solo. Antes, un error real se
      // lanzaba y el cambio se perdía (así se perdió una especie).
      if (!isNetErr(e)) softError = (e && e.message) || String(e);
    }
  }
  // Si la subida del blob ya pasó pero falló el upsert, encola la fila con URLs
  // (sin blobs) para no re-subir la foto/video en cada reintento.
  const enqueueRow = uploaded || row;
  const enqueueBlobs = uploaded ? null : map;
  await idbPut({ key: `${table}:${rowKey(row)}`, table, op: 'upsert', id: rowKey(row), row: enqueueRow, blobs: enqueueBlobs, ts: Date.now(), tries: 0 });
  notifyPending(); scheduleFlush(softError ? 4000 : 20000);
  // Vista previa local mientras espera subirse:
  const preview = { ...enqueueRow };
  if (enqueueBlobs) for (const f in enqueueBlobs) preview[f] = URL.createObjectURL(enqueueBlobs[f]);
  return { queued: true, row: preview, softError };
}
// Actualiza sólo algunos campos de una fila (p. ej. lng/lat al afinar el GPS en
// segundo plano). Si la fila aún está en la cola (offline, con blobs esperando),
// parchea esa operación SIN tocar los blobs; si ya se subió, guarda la fila
// completa (fullRowFn). Así afinar la ubicación nunca pisa una foto pendiente.
export async function patchRow(table, id, fields, fullRowFn = null) {
  const key = `${table}:${id}`;
  const existing = await idbGet(key);
  if (existing && existing.op === 'upsert') {
    existing.row = { ...existing.row, ...fields };
    await idbPut(existing); notifyPending(); scheduleFlush(3000);
    return { queued: true, row: existing.row };
  }
  return saveRow(table, fullRowFn ? fullRowFn() : { id, ...fields });
}
export async function deleteRow(table, id) {
  if (cloudConfigured() && navigator.onLine) {
    try { await withTimeout(REMOVE[table](id), WRITE_TIMEOUT); return { queued: false }; }
    catch (e) { /* red o servidor: se encola igual, no se pierde la operación */ }
  }
  await idbPut({ key: `${table}:${id}`, table, op: 'delete', id, ts: Date.now(), tries: 0 });
  notifyPending(); scheduleFlush(20000);
  return { queued: true };
}

// ---------- subir la cola ----------
let _flushing = false, _timer = null, _onSynced = null, _onPending = null, _onStuck = null;
export async function flushOutbox() {
  if (_flushing || !navigator.onLine || !cloudConfigured()) return { synced: 0 };
  _flushing = true;
  let synced = 0;
  try {
    for (const op of await pendingOps()) {
      try {
        if (op.op === 'delete') await withTimeout(REMOVE[op.table](op.id), WRITE_TIMEOUT);
        else {
          const r = { ...op.row };
          if (op.blobs) await uploadBlobs(r, op.blobs, op.table, op.id);
          else if (op.photoBlob) r.photo = await withTimeout(uploadImage(blobFile(op.photoBlob, op.id), op.table), UPLOAD_TIMEOUT);   // compat ops viejos
          await withTimeout(UPSERT[op.table](r), WRITE_TIMEOUT);
        }
        await idbDel(op.key); synced++;
      } catch (e) {
        if (isNetErr(e)) break;   // se fue la señal: reintentar en la próxima ronda
        // Error real (permisos, sesión vencida, datos): NUNCA descartar el
        // cambio — es trabajo de campo. Se conserva en la cola (cuenta en el
        // badge) y se sigue reintentando; al fallar varias veces, avisar.
        op.tries = (op.tries || 0) + 1;
        await idbPut(op);
        console.warn('[sync] cambio con error, se reintentará', op.key, e && e.message);
        if (op.tries === 3 && _onStuck) { try { _onStuck(op); } catch (e2) { /* no romper el flush */ } }
      }
    }
  } finally { _flushing = false; }
  notifyPending();
  if (synced && _onSynced) { try { _onSynced(synced); } catch (e) { /* no romper el flush */ } }
  return { synced };
}
function scheduleFlush(ms) { clearTimeout(_timer); _timer = setTimeout(flushOutbox, ms); }
async function notifyPending() {
  if (!_onPending) return;
  try { _onPending((await pendingOps()).length); } catch (e) { /* idb no disponible */ }
}

// Llamar una vez al arrancar. onSynced(n): refrescar datos tras subir; onPending(n):
// mostrar contador de cambios sin subir.
export function initSync({ onSynced, onPending, onStuck } = {}) {
  _onSynced = onSynced || null; _onPending = onPending || null; _onStuck = onStuck || null;
  window.addEventListener('online', () => scheduleFlush(1500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleFlush(2000); });
  setInterval(() => { if (navigator.onLine) flushOutbox(); }, 60000);
  notifyPending(); scheduleFlush(3000);
}

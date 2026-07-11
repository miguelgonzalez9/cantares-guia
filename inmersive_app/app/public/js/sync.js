// Cantares — cola offline (outbox). Los cambios del admin se guardan PRIMERO en
// el teléfono (IndexedDB) y se suben a Supabase automáticamente cuando hay señal
// (al volver el internet, al volver a la app, o cada minuto). Así se puede crear
// senderos y puntos en plena montaña sin cobertura.
import { cloudConfigured, uploadImage, upsertWaypoint, deleteWaypoint, upsertSpecies, deleteSpecies,
  upsertTrail, deleteTrail, upsertRoute, deleteRoute } from './cloud.js';

const UPSERT = { waypoints: upsertWaypoint, trails: upsertTrail, routes: upsertRoute, species: upsertSpecies };
const REMOVE = { waypoints: deleteWaypoint, trails: deleteTrail, routes: deleteRoute, species: deleteSpecies };
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

// ---------- helpers ----------
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: sin respuesta de la red')), ms))]);
// ¿El error es de red (reintentable) o real (permisos / datos inválidos)?
function isNetErr(e) {
  if (!navigator.onLine) return true;
  const m = (e && e.message) || String(e || '');
  return (e && e.name === 'TypeError') || /fetch|network|timeout|load failed|abort|conex/i.test(m);
}
const blobFile = (b, id) => new File([b], `${id}_${Date.now().toString(36)}.jpg`, { type: b.type || 'image/jpeg' });

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
// Intenta escribir directo a la nube; si no hay señal (o falla la red), encola
// y devuelve { queued: true }. Errores REALES (permisos, datos) sí se lanzan.
export async function saveRow(table, row, photoBlob = null) {
  if (cloudConfigured() && navigator.onLine) {
    try {
      const r = { ...row };
      if (photoBlob) r.photo = await withTimeout(uploadImage(blobFile(photoBlob, row.id), table), UPLOAD_TIMEOUT);
      await withTimeout(UPSERT[table](r), WRITE_TIMEOUT);
      return { queued: false, row: r };
    } catch (e) { if (!isNetErr(e)) throw e; }
  }
  await idbPut({ key: `${table}:${row.id}`, table, op: 'upsert', id: row.id, row, photoBlob, ts: Date.now(), tries: 0 });
  notifyPending(); scheduleFlush(20000);
  // Para mostrar la foto localmente mientras espera subirse:
  return { queued: true, row: photoBlob ? { ...row, photo: URL.createObjectURL(photoBlob) } : row };
}
export async function deleteRow(table, id) {
  if (cloudConfigured() && navigator.onLine) {
    try { await withTimeout(REMOVE[table](id), WRITE_TIMEOUT); return { queued: false }; }
    catch (e) { if (!isNetErr(e)) throw e; }
  }
  await idbPut({ key: `${table}:${id}`, table, op: 'delete', id, ts: Date.now(), tries: 0 });
  notifyPending(); scheduleFlush(20000);
  return { queued: true };
}

// ---------- subir la cola ----------
let _flushing = false, _timer = null, _onSynced = null, _onPending = null;
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
          if (op.photoBlob) r.photo = await withTimeout(uploadImage(blobFile(op.photoBlob, op.id), op.table), UPLOAD_TIMEOUT);
          await withTimeout(UPSERT[op.table](r), WRITE_TIMEOUT);
        }
        await idbDel(op.key); synced++;
      } catch (e) {
        if (isNetErr(e)) break;   // se fue la señal: reintentar en la próxima ronda
        op.tries = (op.tries || 0) + 1;   // error real; tras varios intentos se descarta
        if (op.tries >= 8) { console.warn('[sync] descartando cambio', op.key, e); await idbDel(op.key); }
        else await idbPut(op);
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
export function initSync({ onSynced, onPending } = {}) {
  _onSynced = onSynced || null; _onPending = onPending || null;
  window.addEventListener('online', () => scheduleFlush(1500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleFlush(2000); });
  setInterval(() => { if (navigator.onLine) flushOutbox(); }, 60000);
  notifyPending(); scheduleFlush(3000);
}

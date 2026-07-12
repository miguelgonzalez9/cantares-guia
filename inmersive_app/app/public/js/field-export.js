// field-export.js — Flujo de VUELTA (lado app) del Sistema de Información Cantares.
//
// Empaqueta los avistamientos del juego (que viven en IndexedDB del navegador),
// con las fotos embebidas en base64, en un solo archivo JSON descargable
// (`cantares_campo_AAAA-MM-DD.json`). El admin lo deja en
// `inputs/photos/field/_incoming/` y `data_prep/13_ingest_game_photos.py` lo
// reingresa al sistema local (Dropbox): fotos + inventario.
//
// Uso (una línea donde quieras el botón, p. ej. en el panel admin o en «Mis
// registros»):
//     import { exportFieldBackup } from './field-export.js';
//     boton.onclick = exportFieldBackup;
// También queda como window.exportFieldBackup para enganchar sin import.

const DB = 'cantares-game';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function getAll(db, store) {
  return new Promise((res, rej) => {
    if (!db.objectStoreNames.contains(store)) return res([]);
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
function blobToDataURL(blob) {
  return new Promise((res) => {
    if (!(blob instanceof Blob)) return res('');
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => res('');
    fr.readAsDataURL(blob);
  });
}

export async function exportFieldBackup() {
  const db = await openDB();
  const [players, obs] = await Promise.all([getAll(db, 'players'), getAll(db, 'obs')]);
  const nameById = Object.fromEntries(players.map((p) => [p.id, p.name]));

  const observations = [];
  for (const o of obs) {
    observations.push({
      id: o.id,
      player: nameById[o.playerId] || o.playerId,
      time: o.time,
      speciesId: o.speciesId || null,
      sci: o.sci || '',
      common: o.common || '',
      group: o.group || '',
      lat: o.lat != null ? o.lat : null,
      lon: o.lon != null ? o.lon : null,
      acc: o.acc != null ? o.acc : null,
      points: o.points != null ? o.points : null,
      kind: o.kind || 'capture',
      confirmedPossible: !!o.confirmedPossible,
      photo_b64: await blobToDataURL(o.photo),
    });
  }

  const doc = {
    system: 'cantares-campo',
    exported: new Date().toISOString(),
    reserve: 'Reserva Natural Cantares',
    n: observations.length,
    observations,
  };
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cantares_campo_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return observations.length;
}

if (typeof window !== 'undefined') window.exportFieldBackup = exportFieldBackup;

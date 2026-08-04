// archive-intake.js — traer una MUESTRA del archivo local a la app para
// clasificarla a mano.
//
// El archivo de los papás vive en Dropbox (`Cantares/fotos/<categoría>[/<especie>]/`)
// y tiene miles de fotos; la app tiene unos cientos. Subirlo entero no cabe (ni
// hace falta): lo que se quiere es una muestra que llene los HUECOS del
// inventario — especies sin ninguna foto, puntos sin ninguna foto y categorías
// flojas — para clasificarla en la bandeja de Fotos.
//
// El navegador no puede leer Dropbox por su cuenta: eso no es una limitación de
// la app sino de la caja de arena, y está bien que así sea. Por eso el admin
// señala la carpeta UNA vez con el selector de archivos; a partir de ahí decide
// todo la app, que es la única que sabe qué falta.
//
// Si entre lo elegido viene un `catalog_*.json` del clasificador, se usa: aporta
// especie, punto y confianza de las fotos sueltas (las que no están en una
// subcarpeta de especie). Sin él se sigue funcionando con lo que dice la ruta.
//
// Nada se sube sin pasar por `saveRow`, así que va por la cola offline y con la
// sesión de admin: sin claves nuevas y sin caminos de escritura nuevos.

import { saveRow, compressImage } from './sync.js';

// Cuántas fotos entran por tanda. Es una MUESTRA: el objetivo es tener algo que
// clasificar en un rato, no vaciar el archivo. Se puede repetir cuantas veces
// haga falta — lo ya subido se salta por hash.
export const DEFAULT_BATCH = 40;
const IMG_RE = /\.(jpe?g|png|webp)$/i;

// ---------------------------------------------------------------- puras
/** Categoría y especie a partir de la ruta relativa que da el selector.
 *  `fotos/aves/molothrus-bonariensis/x.jpg` → { category:'aves', species:'molothrus-bonariensis' }
 *  `fotos/paisaje/x.jpg`                    → { category:'paisaje', species:null }
 *  Se ignora el primer tramo (el nombre de la carpeta elegida, que cambia según
 *  desde dónde se elija) y se leen los DOS siguientes. */
export function parseArchivePath(rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  if (parts.length < 2) return { category: null, species: null };
  const seg = parts.slice(1, -1);            // entre la raíz elegida y el fichero
  const category = seg[0] || null;
  // Un segundo tramo sólo es especie si parece un slug (`genero-especie`), no una
  // subcarpeta de trabajo (`_originales`, `2019`).
  const sp = seg[1] || '';
  const species = /^[a-z]+(-[a-z0-9]+)+$/.test(sp) ? sp : null;
  return { category, species };
}

/** Qué le falta al inventario, a partir de lo que la app ya tiene cargado.
 *  Especie/punto SIN NINGUNA foto es el hueco que más duele: una ficha sin
 *  imagen se ve rota. Las categorías se miden sobre lo ya traído del archivo. */
export function coverageGaps(state) {
  const has = (t, id) => ((state.media && state.media.bySubject[`${t}:${id}`]) || []).length;
  const speciesMissing = new Set();
  const speciesBySlug = new Map();
  (state.species || []).forEach((s) => {
    if (!has('species', s.id)) speciesMissing.add(s.id);
    const sci = (s.scientific_name || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (sci) speciesBySlug.set(sci, s.id);
    speciesBySlug.set(String(s.id).toLowerCase(), s.id);
  });
  const pointsMissing = new Set();
  (state.waypoints || []).forEach((w) => { if (!has('waypoint', w.properties.id)) pointsMissing.add(w.properties.id); });
  return { speciesMissing, speciesBySlug, pointsMissing };
}

/** Elige la muestra. Devuelve como mucho `n` entradas.
 *
 *  Dos ideas y ya:
 *  1. ESTRATOS. La clave es la especie si se conoce, si no la categoría. Se coge
 *     por turnos de cada estrato (round-robin), así ninguna categoría gorda
 *     —`paisaje` tiene cientos— se lleva la tanda entera. Eso es lo que hace la
 *     muestra representativa y no un «los primeros 40 alfabéticamente»: cada
 *     categoría y cada especie presente en la selección entra con su turno.
 *  2. PRIORIDAD. Primero los estratos que tapan un hueco REAL —una especie o un
 *     punto que hoy no tiene ninguna foto en la app— y luego el resto. Dentro de
 *     cada nivel, round-robin igual.
 *
 *  ponytail: el equilibrio es DENTRO de la tanda, no entre tandas. Para saber de
 *  qué categoría se ha traído más en pasadas anteriores haría falta guardar la
 *  categoría en la fila, y eso es una columna y una migración. Si al repetir se
 *  nota que una categoría se queda corta, esa es la señal para añadirla.
 */
export function planSample(entries, gaps, n = DEFAULT_BATCH) {
  const strata = new Map();
  for (const e of entries) {
    const key = e.speciesId ? `species:${e.speciesId}` : `cat:${e.category || 'sin categoría'}`;
    (strata.get(key) || strata.set(key, []).get(key)).push(e);
  }
  const fills = (e) =>
    (e.speciesId && gaps.speciesMissing.has(e.speciesId)) || (e.punto && gaps.pointsMissing.has(e.punto));
  const groups = [...strata.entries()]
    .map(([key, list]) => ({
      key, tier: list.some(fills) ? 0 : 1,
      // Dentro del estrato, las que tapan un hueco van DELANTE. Sin esto, una
      // foto de un punto sin fotos que cae en `cat:paisaje` queda detrás de sus
      // 50 compañeras de categoría y no entra en la tanda: el estrato subía de
      // nivel gracias a ella y luego la dejaba fuera.
      list: list.slice().sort((x, y) => (fills(y) ? 1 : 0) - (fills(x) ? 1 : 0)),
    }))
    .sort((a, b) => a.tier - b.tier || a.key.localeCompare(b.key));

  const out = [];
  for (const tier of [0, 1]) {
    const g = groups.filter((x) => x.tier === tier && x.list.length);
    while (out.length < n && g.some((x) => x.list.length)) {
      for (const x of g) {
        if (out.length >= n) break;
        if (x.list.length) out.push(x.list.shift());
      }
    }
    if (out.length >= n) break;
  }
  return out;
}

/** sha256 en hexadecimal — la MISMA identidad de contenido que usa
 *  `data_prep/26_sync_media.py`, para que las dos direcciones deduplican igual.
 *  Sin esto, cada tanda volvería a subir lo mismo. */
export async function sha256Hex(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Índice del catálogo del clasificador, si vino entre lo elegido. Devuelve
 *  {nombreDeArchivo: registro}: se cruza por NOMBRE porque la raíz de la ruta
 *  cambia según desde dónde se elija la carpeta. */
export async function readCatalog(files) {
  const f = files.find((x) => /catalog[^/]*\.json$/i.test(x.name));
  if (!f) return {};
  try {
    const doc = JSON.parse(await f.text());
    const rows = doc.photos || doc.items || [];
    const byName = {};
    rows.forEach((r) => { const b = String(r.file || '').split('/').pop(); if (b) byName[b] = r; });
    return byName;
  } catch (e) { console.warn('[intake] catálogo ilegible', e && e.message); return {}; }
}

// ---------------------------------------------------------------- orquestación
/** Construye las entradas candidatas a partir de los ficheros elegidos. */
export function buildEntries(files, catalog, gaps) {
  const out = [];
  for (const f of files) {
    if (!IMG_RE.test(f.name)) continue;
    const { category, species } = parseArchivePath(f.webkitRelativePath || f.name);
    const cat = catalog[f.name] || {};
    // La especie del catálogo manda sobre la de la carpeta: el catálogo la
    // resolvió contra el inventario cerrado; la carpeta es sólo una convención.
    const slug = (cat.species_id || species || '').toLowerCase();
    out.push({
      file: f,
      category: cat.category || category,
      speciesId: gaps.speciesBySlug.get(slug) || null,
      speciesHint: cat.scientific_name || (species ? species.replace(/-/g, ' ') : null),
      punto: cat.punto || null,
    });
  }
  return out;
}

/** Sube la muestra. `onProgress(hechas, total, texto)` para pintar el avance.
 *  Devuelve un resumen; nunca lanza por una foto suelta. */
export async function uploadSample(picks, knownHashes, onProgress = () => {}) {
  const res = { subidas: 0, repetidas: 0, fallidas: 0, encoladas: 0 };
  let i = 0;
  for (const p of picks) {
    i++;
    onProgress(i, picks.length, p.file.name);
    try {
      const hash = await sha256Hex(p.file);
      // Ya está en la nube: no se vuelve a subir. Es lo que hace que se pueda
      // repetir la tanda sin miedo y sin gastar almacenamiento dos veces.
      if (knownHashes.has(hash)) { res.repetidas++; continue; }
      const blob = await compressImage(p.file);
      const r = await saveRow('media', {
        id: `arch_${hash.slice(0, 16)}`,   // id derivado del CONTENIDO → reintentar no duplica
        kind: 'photo', url: null,
        subject_type: null, subject_id: null,      // la clasifica una persona, no esto
        status: 'unclassified', origin: 'local-archive',
        content_hash: hash,
        species_hint: p.speciesHint || null,
        caption: null, caption_en: null, credit: null,
        is_primary: false, sort: 0, focal_x: 0.5, focal_y: 0.5,
        reviewed: false,
      }, { url: blob });
      knownHashes.add(hash);
      res.subidas++;
      if (r && r.queued) res.encoladas++;
    } catch (e) {
      res.fallidas++;
      console.warn('[intake]', p.file.name, e && e.message);
    }
  }
  return res;
}

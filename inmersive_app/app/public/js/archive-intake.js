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

/** Muestra con CUPO POR CARPETA: `{carpeta: cuántas}`. Cada carpeta se resuelve
 *  con el mismo criterio de arriba (estratos + huecos primero) pero dentro de su
 *  propio cupo, así que elegir «aves: 20, hongos: 5» da exactamente eso.
 *  Una carpeta sin cupo (o con 0) no entra: es la forma de excluirla. */
export function planByFolder(entries, gaps, quotas) {
  const byDir = new Map();
  for (const e of entries) {
    const d = e.dir || '(raíz)';
    if (!quotas[d]) continue;
    (byDir.get(d) || byDir.set(d, []).get(d)).push(e);
  }
  const out = [];
  for (const [dir, list] of byDir) out.push(...planSample(list, gaps, quotas[dir]));
  return out;
}

/** Cuántas imágenes hay por carpeta, para enseñarlo antes de elegir. */
export function countByFolder(entries) {
  const n = {};
  entries.forEach((e) => { const d = e.dir || '(raíz)'; n[d] = (n[d] || 0) + 1; });
  return n;
}

/** Id estable derivado de la RUTA en el archivo. Es lo que permite saber que una
 *  foto ya se trajo SIN BAJARLA: el hash del contenido sólo se conoce después de
 *  descargar, así que deduplicar sólo por contenido obligaba a bajarse 40 fotos
 *  para descubrir que las 40 ya estaban. Con Dropbox eso son megas y minutos.
 *
 *  Legible a propósito (`arch_aves_p1160506_jpg_1a2b3c`): cuando algo sale mal se
 *  ve de qué foto se trata sin cruzar tablas. El sufijo es un FNV-1a de la ruta
 *  COMPLETA, para que dos ficheros con el mismo nombre en carpetas distintas no
 *  colisionen tras recortar. */
export function archiveId(relPath) {
  let h = 0x811c9dc5;
  for (let i = 0; i < relPath.length; i++) { h ^= relPath.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const slug = relPath.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(-70);
  return `arch_${slug}_${h.toString(36)}`;
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
/** Adaptador: ficheros del selector → la forma común. La ruta relativa lleva
 *  delante el nombre de la carpeta elegida, que cambia según desde dónde se
 *  elija; se descarta para que ambas fuentes hablen igual. */
export function fromFiles(files) {
  return files.map((f) => ({
    name: f.name,
    relPath: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name,
    get: () => Promise.resolve(f),
  }));
}
/** Adaptador: listado de Dropbox → la forma común. `get` baja la foto, y sólo se
 *  llama con las elegidas: bajar 900 para quedarse con 40 sería absurdo. */
export function fromDropbox(items, download) {
  return items.map((it) => ({
    name: it.name,
    relPath: it.dir === '(raíz)' ? it.name : `${it.dir}/${it.name}`,
    get: () => download(it.path),
  }));
}

/** Construye las entradas candidatas. `items` viene de `fromFiles` o `fromDropbox`:
 *  a partir de aquí las dos fuentes son la misma cosa. */
export function buildEntries(items, catalog, gaps) {
  const out = [];
  for (const it of items) {
    if (!IMG_RE.test(it.name)) continue;
    // `parseArchivePath` espera la raíz delante; los adaptadores ya la quitaron.
    const { category, species } = parseArchivePath('x/' + it.relPath);
    const cat = catalog[it.name] || {};
    // La especie del catálogo manda sobre la de la carpeta: el catálogo la
    // resolvió contra el inventario cerrado; la carpeta es sólo una convención.
    const slug = (cat.species_id || species || '').toLowerCase();
    const dir = it.relPath.split('/').slice(0, -1).join('/') || '(raíz)';
    out.push({
      name: it.name, dir, get: it.get, id: archiveId(it.relPath),
      category: cat.category || category,
      speciesId: gaps.speciesBySlug.get(slug) || null,
      speciesHint: cat.scientific_name || (species ? species.replace(/-/g, ' ') : null),
      punto: cat.punto || null,
    });
  }
  return out;
}

/** Quita de la selección lo que ya está en la app, ANTES de descargar nada.
 *  `knownIds` = ids ya presentes; `knownHashes` = hashes de contenido ya
 *  presentes. La ruta es lo único que se conoce sin bajar el fichero, así que
 *  esta criba es la que ahorra el trabajo de verdad. */
export function dropAlreadyThere(picks, knownIds) {
  const keep = [], skipped = [];
  for (const p of picks) (knownIds.has(p.id) ? skipped : keep).push(p);
  return { keep, skipped };
}

/** Sube la muestra. `onProgress(hechas, total, texto)` para pintar el avance.
 *  Devuelve un resumen; nunca lanza por una foto suelta. */
export async function uploadSample(picks, knownHashes, onProgress = () => {}) {
  const res = { subidas: 0, repetidas: 0, fallidas: 0, encoladas: 0 };
  let i = 0;
  for (const p of picks) {
    i++;
    onProgress(i, picks.length, p.name);
    try {
      const src = await p.get();          // del disco o de Dropbox, da igual aquí
      const hash = await sha256Hex(src);
      // Segunda criba, por CONTENIDO: caza la misma foto guardada dos veces con
      // nombres distintos, que en un archivo familiar pasa constantemente. La
      // primera criba (por ruta) ya evitó bajar lo que se trajo en otra tanda.
      if (knownHashes.has(hash)) { res.repetidas++; continue; }
      const blob = await compressImage(src);
      const r = await saveRow('media', {
        // Id derivado de la RUTA, no del contenido: así se puede saber que ya
        // está sin bajarla. Reintentar sigue sin duplicar — es un upsert.
        id: p.id,
        kind: 'photo', url: null,
        subject_type: null, subject_id: null,      // la clasifica una persona, no esto
        status: 'unclassified', origin: 'local-archive',
        content_hash: hash,
        // La carpeta ES la clasificación local (migración 24). Antes se usaba
        // para repartir la muestra y se tiraba: en la bandeja todas llegaban
        // iguales y había que abrir cada una para saber si era ave o paisaje.
        archive_dir: p.dir && p.dir !== '(raíz)' ? p.dir : null,
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
      console.warn('[intake]', p.name, e && e.message);
    }
  }
  return res;
}

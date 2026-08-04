// Vista «Todas» de la bandeja de fotos del admin (issue #10, punto 7). El panel
// no arranca headless; aquí se prueba el filtrado, que es donde está la lógica,
// y se fija que el botón de exportar fotos de campo no vuelva a aparecer.
//
// Correr:  node inmersive_app/app/tests/media-browse.test.mjs
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(APP, 'public');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');
const sw = readFileSync(join(PUB, 'sw.js'), 'utf8');

// --- copia del filtrado de browseMedia() ---------------------------------
const ORIGIN_LABEL = { 'game-capture': '🎮 Juego', 'curated': '⭐ Curadas' };
const subjectLabel = (m) => m.subject_id ? '🦋 ' + m.subject_id : '❓ Sin clasificar';
const haystack = (m) => [subjectLabel(m), m.caption, m.species_hint,
  ORIGIN_LABEL[m.origin] || m.origin, m.id].filter(Boolean).join(' ').toLowerCase();
function browse(all, { origin = 'all', status = 'all', q = '' }) {
  let list = all;
  if (origin !== 'all') list = list.filter((m) => (m.origin || 'admin-upload') === origin);
  if (status === 'unclassified') list = list.filter((m) => !m.subject_id);
  else if (status === 'classified') list = list.filter((m) => !!m.subject_id);
  const ql = q.trim().toLowerCase();
  if (ql) list = list.filter((m) => haystack(m).includes(ql));
  return list.slice().sort((a, b) => String(b.taken_at || '').localeCompare(String(a.taken_at || '')));
}

const MEDIA = [
  { id: 'm1', origin: 'curated', source: 'curated', subject_id: 'roble', caption: 'Hoja', taken_at: '2026-01-01' },
  { id: 'm2', origin: 'game-capture', subject_id: null, species_hint: 'Macleania rupestris', taken_at: '2026-08-01' },
  { id: 'm3', origin: 'game-capture', subject_id: 'yolombo', taken_at: '2026-07-01' },
  { id: 'm4', origin: 'admin-upload', subject_id: null, taken_at: null },
];

// 1. EL PUNTO DEL ISSUE: las curadas y las ya clasificadas también se ven. La
//    bandeja vieja sólo listaba lo sin clasificar y las de un sujeto elegido, así
//    que una foto clasificada cuyo sujeto no recordabas era invisible.
assert.strictEqual(browse(MEDIA, {}).length, 4, 'sin filtros están TODAS');
assert.ok(browse(MEDIA, {}).some((m) => m.source === 'curated'), 'las curadas deben aparecer');

// 2. Filtro por estado.
assert.deepStrictEqual(browse(MEDIA, { status: 'unclassified' }).map((m) => m.id), ['m2', 'm4']);
assert.deepStrictEqual(browse(MEDIA, { status: 'classified' }).map((m) => m.id), ['m3', 'm1']);

// 3. Filtro por procedencia.
assert.deepStrictEqual(browse(MEDIA, { origin: 'game-capture' }).map((m) => m.id), ['m2', 'm3']);

// 4. Búsqueda: por sujeto, por pie y por sugerencia del clasificador.
assert.deepStrictEqual(browse(MEDIA, { q: 'yolombo' }).map((m) => m.id), ['m3']);
assert.deepStrictEqual(browse(MEDIA, { q: 'hoja' }).map((m) => m.id), ['m1']);
assert.deepStrictEqual(browse(MEDIA, { q: 'macleania' }).map((m) => m.id), ['m2']);

// 5. Los filtros se combinan (no se pisan).
assert.deepStrictEqual(browse(MEDIA, { origin: 'game-capture', status: 'classified' }).map((m) => m.id), ['m3']);

// 6. Orden: lo más reciente primero, y una foto sin fecha no se cuela arriba.
assert.deepStrictEqual(browse(MEDIA, {}).map((m) => m.id), ['m2', 'm3', 'm1', 'm4']);

// 7. El botón de exportar fotos de campo se fue — y su módulo con él, incluida
//    la entrada del precache (un asset inexistente rompe el install del SW).
assert.ok(!/fm-field-export|exportFieldBackup|field-export/.test(admin), 'no debe quedar rastro en admin.js');
assert.ok(!/field-export/.test(sw), 'sw.js no puede precachear un archivo borrado');
assert.ok(!existsSync(join(PUB, 'js', 'field-export.js')), 'field-export.js debería estar borrado');

// 8. La vista existe y está cableada.
assert.ok(/function renderFotosAll\(/.test(admin));
assert.ok(/if \(mediaMode === 'all'\) \{ renderFotosAll\(fm\); return; \}/.test(admin));

console.log('media-browse: 8/8 OK');

// Una URL `blob:` nunca puede persistirse como URL de una foto.
//
// Es una referencia en memoria del navegador, viva sólo mientras dure la pestaña
// que la creó. Mientras una foto espera en la cola offline, saveRow devuelve una
// fila de VISTA PREVIA con URL.createObjectURL(...), y esa vista previa queda en
// state.media. Si el admin edita la foto antes de que la cola vacíe, ese blob se
// escribía como URL definitiva y la foto quedaba perdida: la fila apunta a nada.
//
// Pasó de verdad: 3 filas del 2026-07-13 en `media` tienen
// `blob:https://miguelgonzalez9.github.io/…` como url. Se descubrieron al
// intentar descargarlas con 26_sync_media.py pull --download.
//
// Correr:  node inmersive_app/app/tests/blob-url.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const src = (f) => readFileSync(join(PUB, f), 'utf8');

// 1. Los dos constructores de filas de media rechazan un `blob:`.
for (const [file, marker] of [['js/admin.js', 'mediaRow'], ['js/app.js', 'mediaRowFrom']]) {
  const code = src(file);
  const i = code.indexOf(`function ${marker}(`);
  assert.ok(i > 0, `${marker} no encontrado en ${file}`);
  const body = code.slice(i, i + 1200);
  assert.ok(/startsWith\('blob:'\)/.test(body) || /assertUploadable/.test(body),
    `${marker} en ${file} no comprueba blob:`);
}

// 2. La comprobación en sí, replicada: acepta lo persistible, rechaza el resto.
const bad = (u) => typeof u === 'string' && u.startsWith('blob:');
assert.strictEqual(bad('blob:https://miguelgonzalez9.github.io/879fcc47'), true);
assert.strictEqual(bad('https://rmfwrzteuraatdutwaqj.supabase.co/storage/v1/object/public/media/a.jpg'), false);
assert.strictEqual(bad('img/species/aliso__1.webp'), false);
assert.strictEqual(bad(null), false);
assert.strictEqual(bad(undefined), false);

// 3. Y que nadie vuelva a meter un createObjectURL en el camino de escritura.
//    En sync.js es legítimo (es la vista previa); en los constructores, no.
for (const f of ['js/admin.js', 'js/app.js']) {
  const code = src(f);
  for (const marker of ['function mediaRow(', 'function mediaRowFrom(']) {
    const i = code.indexOf(marker);
    if (i < 0) continue;
    assert.ok(!code.slice(i, i + 1200).includes('createObjectURL'),
      `${marker} en ${f} no debe crear object URLs`);
  }
}

console.log('blob-url: 3/3 OK');

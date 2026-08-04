// Captura del juego (issue #10, puntos 1–6). La cámara, el GPS y Pl@ntNet no
// corren sin navegador; aquí se prueba lo que sí es puro: que el buscador no
// vuelva a romperse con una especie sin nombre científico, y que el filtro de
// confianza deje fuera lo que no llega al 70%. El resto se prueba con el dedo.
//
// Correr:  node inmersive_app/app/tests/capture.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const game = readFileSync(join(PUB, 'js', 'game.js'), 'utf8');
const html = readFileSync(join(PUB, 'index.html'), 'utf8');

// --- copia de la función de filtrado del buscador (game.js renderCandidates) ---
const L = (o, f) => o[f];
function search(list, q) {
  if (!q) return list;
  const ql = q.toLowerCase();
  return list.filter((s) =>
    (L(s, 'common_name') || '').toLowerCase().includes(ql) ||
    (s.common_name || '').toLowerCase().includes(ql) ||
    (s.scientific_name || '').toLowerCase().includes(ql));
}

// 1. EL BUG: una especie creada desde el admin puede no tener scientific_name.
//    `s.scientific_name.toLowerCase()` lanzaba DENTRO del oninput, así que el
//    buscador no filtraba nada — parecía que el filtro no existía.
const INV = [
  { id: 'a', common_name: 'Yolombo', scientific_name: 'Panopsis suaveolens' },
  { id: 'b', common_name: 'Yolombo 1' },                       // ← sin nombre científico
  { id: 'c', common_name: 'Roble', scientific_name: 'Quercus humboldtii' },
];
assert.doesNotThrow(() => search(INV, 'yolo'));
assert.deepStrictEqual(search(INV, 'yolo').map((s) => s.id), ['a', 'b']);

// 2. El buscador sí restringe: escribir de más deja menos.
assert.deepStrictEqual(search(INV, 'rob').map((s) => s.id), ['c']);
assert.deepStrictEqual(search(INV, 'quercus').map((s) => s.id), ['c']);
assert.strictEqual(search(INV, 'zzz').length, 0);
assert.strictEqual(search(INV, '').length, 3);

// 3. Umbral de confianza: sólo se muestran sugerencias ≥70%.
const MIN = Number(/const SUG_MIN_SCORE = ([\d.]+)/.exec(game)[1]);
assert.strictEqual(MIN, 0.70, 'el umbral del código debe ser 0.70');
const cands = [{ sci: 'A', score: 0.95 }, { sci: 'B', score: 0.70 }, { sci: 'C', score: 0.69 }, { sci: 'D', score: 0.12 }];
const kept = cands.filter((s) => (s.score || 0) >= MIN).map((s) => s.sci);
assert.deepStrictEqual(kept, ['A', 'B'], '0.69 no pasa; 0.70 justo sí');

// 4. La ubicación SÓLO se registra cuando la foto se toma con la cámara.
assert.ok(/wiz\.loc = fromCamera \? await snapLocation\(\) : null/.test(game),
  'una foto subida del carrete no puede llevar el GPS de ahora');

// 5. La cámara exige cuenta; subir, no. Sin esto cualquiera «captura en la reserva».
assert.ok(/function hasAccount\(\)/.test(game));
assert.ok(/const cam = hasAccount\(\);/.test(game));
assert.ok(/\$\{cam \? `<button id="gm-cam"/.test(game), 'el botón de cámara depende de la cuenta');
assert.ok(/<button id="gm-up"/.test(game) && !/cam \?[^`]*gm-up/.test(game),
  'subir foto debe estar SIEMPRE disponible');

// 6. La identificación automática es de plantas: sólo con el grupo flora elegido.
assert.ok(/idAvailable\(\) && wiz\.group === 'flora'/.test(game));

// 7. Los tres botones externos ya no están (Pl@ntNet / Merlin / iNaturalist).
for (const gone of ['species-tools', 'id_plant', 'id_bird', 'id_inat', 'inat-link']) {
  assert.ok(!html.includes(gone), `${gone} debería haberse eliminado del HTML`);
}

console.log('capture: 7/7 OK');

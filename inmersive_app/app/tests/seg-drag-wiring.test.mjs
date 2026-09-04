// El arrastre (⠿) para reordenar los senderos de un recorrido no funcionaba.
//
// `wireSegDrag` capturaba el puntero sobre el .seg-grip, que vive DENTRO del
// <li> que ese mismo código mueve con `ol.insertBefore(li, ...)`. Mover un nodo
// lo saca antes del documento, y eso libera la captura de puntero: al primer
// reordenamiento dejaban de llegar pointermove/pointerup al grip, `end` no
// corría, `onDrop` no se llamaba, segWork no cambiaba y el <li> se quedaba
// fantasma con la clase .dragging (y por tanto pointer-events: none).
//
// seg-reorder.test.mjs no lo cazó porque REIMPLEMENTA la aritmética
// (`applyDrop` está definido dentro del propio test) y nunca toca wireSegDrag:
// pasaba perfecto con la función completamente muerta. Esta prueba mira el
// CABLEADO, que es donde estaba el fallo.
//
// Lo que no se puede comprobar aquí: que el dedo arrastre de verdad. Sin DOM ni
// eventos de puntero reales, esto es una prueba de forma. Probar en el teléfono.
//
// Correr:  node inmersive_app/app/tests/seg-drag-wiring.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');
const css = readFileSync(join(PUB, 'css', 'style.css'), 'utf8');

const fn = /function wireSegDrag\(ol, onDrop\) \{([\s\S]*?)\n\}/.exec(admin);
assert.ok(fn, 'wireSegDrag debe existir');
const body = fn[1];

// --- la captura va sobre el <ol>, que no se mueve ---
assert.ok(/ol\.setPointerCapture\(ev\.pointerId\)/.test(body),
  'la captura de puntero tiene que ir sobre el <ol>');
assert.ok(!/\bg\.setPointerCapture\b/.test(body),
  'capturar sobre el grip lo rompe: el grip se mueve con el <li> y se pierde la captura');

// --- los listeners también, y se quitan del mismo sitio ---
for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
  assert.ok(new RegExp(`ol\\.addEventListener\\('${ev}'`).test(body), `${ev} se escucha en el <ol>`);
}
assert.ok(/ol\.removeEventListener\('pointermove'/.test(body), 'pointermove se quita del <ol>');
assert.ok(!/\bg\.addEventListener\(/.test(body),
  'ningún listener del arrastre puede colgar del grip');
assert.ok(!/\bg\.removeEventListener\(/.test(body), 'ni quitarse de él');

// El <li> sí se mueve: por eso no puede sostener nada.
assert.ok(/ol\.insertBefore\(li,/.test(body), 'el <li> se mueve dentro del <ol>');

// --- al soltar se devuelve el orden y se limpia el fantasma ---
assert.ok(/onDrop\(\[\.\.\.ol\.children\]\.map\(\(n\) => \+n\.dataset\.i\)\)/.test(body),
  'al soltar se devuelve el orden como índices del array original');
assert.ok(/li\.classList\.remove\('dragging'\)/.test(body), 'se quita la clase .dragging al soltar');

// --- el CSS que el algoritmo da por hecho ---
assert.ok(/\.admin-seglist li\.dragging \{[^}]*pointer-events:\s*none/.test(css),
  'el li arrastrado necesita pointer-events:none o elementFromPoint se devuelve a sí mismo');
assert.ok(/\.seg-grip \{[^}]*touch-action:\s*none/.test(css),
  'sin touch-action:none el dedo hace scroll en vez de arrastrar');

// --- el <li> lleva su índice original, que es lo que onDrop devuelve ---
assert.ok(/<li data-i="\$\{i\}">/.test(admin), 'cada <li> guarda su índice original en data-i');

console.log('OK — seg-drag-wiring (captura y listeners sobre el <ol>, no sobre el grip)');

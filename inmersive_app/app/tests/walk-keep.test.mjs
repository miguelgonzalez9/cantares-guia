// Guardar o descartar un recorrido al terminarlo (issue #10, punto 8). El GPS no
// corre sin navegador, así que aquí se prueba el umbral de «se movió de verdad» y
// se fija lo que no puede volver a pasar: que parar guarde sin preguntar.
//
// Correr:  node inmersive_app/app/tests/walk-keep.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const rec = readFileSync(join(PUB, 'js', 'recorder.js'), 'utf8');

// --- copia de walkIsReal(), con el umbral leído del propio código ------------
const MIN = Number(/const MIN_WALK_M = (\d+)/.exec(rec)[1]);
const isReal = (w) => (w.points || []).length >= 2 && (w.distanceM || 0) >= MIN;

// 1. Un teléfono quieto en el bolsillo acumula puntos por deriva del GPS: dos
//    lecturas y 4 m no son un recorrido y no deben abrir el diálogo.
assert.strictEqual(isReal({ points: [[0, 0], [0, 0]], distanceM: 4 }), false);
assert.strictEqual(isReal({ points: [[0, 0]], distanceM: 900 }), false, 'un solo punto no es traza');
assert.strictEqual(isReal({ points: [], distanceM: 0 }), false);

// 2. Una caminata real sí pregunta.
assert.strictEqual(isReal({ points: [[0, 0], [0, 1], [0, 2]], distanceM: 800 }), true);
assert.strictEqual(isReal({ points: [[0, 0], [0, 1]], distanceM: MIN }), true, 'el umbral justo cuenta');
assert.strictEqual(isReal({ points: [[0, 0], [0, 1]], distanceM: MIN - 1 }), false);

// 3. EL PUNTO DEL ISSUE: parar ya NO guarda; pregunta. Sin esto, tocar «grabar»
//    sin querer dejaba basura en el historial (y en la nube) para borrar a mano.
assert.ok(/if \(walkIsReal\(walk\)\) askKeepWalk\(walk\);/.test(rec),
  'stopWalk debe preguntar, no guardar');
const stop = rec.slice(rec.indexOf('export async function stopWalk'), rec.indexOf('async function keepWalk'));
assert.ok(!/walkPut\(walk\)/.test(stop), 'stopWalk no puede escribir en IndexedDB');
assert.ok(!/saveRow\('walks'/.test(stop), 'stopWalk no puede subir nada a la nube');

// 4. Sólo al guardar se persiste — local primero, nube después (puede encolarse).
const keep = rec.slice(rec.indexOf('async function keepWalk'), rec.indexOf('function askKeepWalk'));
assert.ok(keep.indexOf('walkPut(walk)') > 0 && keep.indexOf("saveRow('walks'") > keep.indexOf('walkPut(walk)'),
  'lo del usuario se guarda antes de intentar la nube');

// 5. El diálogo no se puede cerrar sin decidir: no lleva × ni cierre por fuera.
const ask = rec.slice(rec.indexOf('function askKeepWalk'), rec.indexOf('function askKeepWalk') + 900);
assert.ok(/#rec-keep/.test(ask) && /#rec-drop/.test(ask), 'las dos opciones deben existir');
assert.ok(!/rec-x/.test(ask), 'sin botón de cerrar: cerrar sería una tercera respuesta ambigua');

console.log('walk-keep: 5/5 OK');

// El fallo de v62: index.html nuevo + app.js viejo en la misma pestaña.
// El service worker sirve el shell stale-while-revalidate ARCHIVO POR ARCHIVO, así
// que al desplegar hay una ventana en la que conviven dos versiones. Con
// #base-toggle ya fuera del HTML pero el app.js viejo aún buscándolo,
// makeDraggable recibía null, `main()` lanzaba y la app se quedaba muerta:
// «Cannot read properties of null (reading 'addEventListener')».
//
// Correr:  node inmersive_app/app/tests/deploy-skew.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');

// --- copia de la guarda de makeDraggable ------------------------------------
const warned = [];
function makeDraggable(el, handle, key) {
  if (!el || !handle) { warned.push(key); return 'skipped'; }
  return 'wired';
}

// 1. Un widget que falta es un widget que falta, no una app muerta.
assert.strictEqual(makeDraggable(null, {}, 'legend'), 'skipped');
assert.strictEqual(makeDraggable({}, null, 'base'), 'skipped');
assert.strictEqual(makeDraggable(null, null, 'x'), 'skipped');
assert.strictEqual(makeDraggable({}, {}, 'ok'), 'wired', 'con los dos presentes se cablea igual');
assert.deepStrictEqual(warned, ['legend', 'base', 'x'], 'y se avisa, no se calla');

// 2. La guarda está DONDE convergen todos los que llaman, no en cada llamada:
//    un solo `if` cubre la leyenda, el GPS y cualquier widget futuro.
const md = app.slice(app.indexOf('function makeDraggable'), app.indexOf('function makeDraggable') + 900);
assert.ok(/if \(!el \|\| !handle\)/.test(md), 'la guarda debe estar en makeDraggable');
assert.ok(/console\.warn/.test(md), 'un widget que no se cablea tiene que dejar rastro');

// 3. La raíz: al tomar el control un service worker NUEVO, la pestaña recarga —
//    así deja de convivir media versión vieja con media nueva.
const sw = app.slice(app.indexOf('async function registerSW'), app.indexOf('// ---------- legend'));
assert.ok(/const had = !!navigator\.serviceWorker\.controller/.test(sw));
assert.ok(/if \(!had\) return;/.test(sw), 'en la primera visita no hay nada viejo: no se recarga');
assert.ok(/addEventListener\('controllerchange'/.test(sw));
assert.ok(/location\.reload\(\)/.test(sw));

// 4. …pero NO se recarga encima de un trabajo a medias: un editor abierto o el
//    modo de elegir puntos pierden lo escrito. Ahí se avisa y decide la persona.
assert.ok(/#ce-ov, \.gm-overlay, #fm-assign/.test(sw), 'editores y modales cuentan como ocupado');
assert.ok(/classList\.contains\('admin-open'\)/.test(sw));
assert.ok(/classList\.contains\('picking-points'\)/.test(sw));
assert.ok(/if \(busy\) \{ toast\(t\('sw_new_version'\)\); return; \}/.test(sw));
// Y una recarga sola: `done` impide el bucle.
assert.ok(/let done = false;/.test(sw) && /if \(done\) return;\s*\n\s*done = true;/.test(sw));

// 5. El aviso existe en los dos idiomas (un t() sin clave devuelve la clave).
assert.strictEqual((app.match(/sw_new_version:/g) || []).length, 2);

console.log('deploy-skew: 5/5 OK');

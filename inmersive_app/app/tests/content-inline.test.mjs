// Edición en sitio de las páginas de texto (Historia / Info).
//
// La invariante que importa aquí no es visual: es que NO SE PUEDE EDITAR sin
// haber cargado la copia de la nube.
//
// `state.historia` es el JSON EMPACADO mientras no llega esa copia — loadCloudData
// se rinde sin conexión —, y como el guardado escribe el documento ENTERO,
// editar en el campo sin señal pisaría con el texto de build todo lo que se
// hubiera escrito antes. Hasta el arreglo de #29 eso no se notaba porque el
// editor no guardaba nada; al arreglarlo, empezó a poder pasar de verdad.
//
// Correr:  node inmersive_app/app/tests/content-inline.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

// --- 1. el bloqueo existe y depende de que la nube haya contestado ---
assert.ok(/contentFromCloud: false,/.test(app), 'la marca arranca en false: el JSON empacado NO es la copia buena');
const blk = /function contentEditBlock\(\) \{([\s\S]*?)\n\}/.exec(app);
assert.ok(blk, 'contentEditBlock tiene que existir');
assert.ok(/if \(!state\.contentFromCloud\) return t\('ie_no_cloud'\);/.test(blk[1]),
  'sin copia de la nube, el motivo del bloqueo');

// La marca se pone donde se sabe que la CONSULTA funcionó, no donde hay filas:
// una tabla content vacía es un estado legítimo y bloquearía la edición para
// siempre si la marca viviera dentro de applyCloudContent.
assert.ok(/if \(cc\) state\.contentFromCloud = true;/.test(app),
  'la marca la pone el resultado de la consulta, no la existencia de filas');
const ac = /function applyCloudContent\(rows\) \{([\s\S]*?)\n\}/.exec(app);
assert.ok(ac && !/contentFromCloud/.test(ac[1]),
  'applyCloudContent no puede ponerla: se llama tambien al guardar en local');

// --- 2. el bloqueo llega al interruptor Y al cableado de los campos ---
const wire = /function wireContentInlineEdit\(root, key, slotId\) \{([\s\S]*?)\n\}\n/.exec(app);
assert.ok(wire, 'wireContentInlineEdit tiene que existir');
assert.ok(/disabledReason: contentEditBlock\(\)/.test(wire[1]), 'el interruptor sale apagado y explica por que');
assert.ok(/if \(!isEditing\(\) \|\| contentEditBlock\(\)\) return;/.test(wire[1]),
  'y ademas no se cablea ni un campo: un interruptor apagado no basta como cierre');

// --- 3. se guarda por RUTA, no por forma de cada pagina ---
assert.ok(/setPath\(doc, path, v\.trim\(\) \|\| null\);/.test(wire[1]), 'se escribe la ruta marcada en data-ie');
assert.ok(/saveRow\('content', \{ id: key, doc \}\)/.test(wire[1]), 'y se manda por la cola, como todo lo demas');
assert.ok(/import \{[^}]*getPath, setPath[^}]*\} from '\.\/admin\.js';/.test(app),
  'getPath/setPath se IMPORTAN de admin.js, no se recopian');

// --- 4. el idioma en pantalla decide que campo se escribe ---
// L() cae al espanol cuando falta el ingles: editar en ingles sin mirar esto
// habria sobrescrito el texto espanol con lo que se escribio en ingles.
assert.ok(/data-ie="secciones\.\$\{i\}\.\$\{en \? 'titulo_en' : 'titulo'\}"/.test(app), 'historia: titulo por idioma');
assert.ok(/data-ie="\$\{en \? 'lead_en' : 'lead'\}"/.test(app), 'historia: entradilla por idioma');
assert.ok(/const k = enL \? `\$\{field\}_en` : field;/.test(app), 'info: campo por idioma');

// --- 5. el editor modal se queda para la ESTRUCTURA ---
assert.ok(/id="hist-edit">🗂️ \$\{t\('ce_sections'\)\}/.test(app), 'historia: boton de secciones');
assert.ok(/id="vi-edit">🗂️ \$\{t\('ce_sections'\)\}/.test(app), 'info: boton de secciones');
assert.ok(/openContentEditor\('historia'\)/.test(app) && /openContentEditor\('reserve_info'\)/.test(app),
  'anadir/borrar/reordenar sigue en el modal, que con el pulgar es mejor');

// --- 6. las dos cadenas nuevas, en los dos idiomas ---
for (const k of ['ie_no_cloud', 'ce_sections', 'ie_on', 'ie_off']) {
  assert.strictEqual((app.match(new RegExp(k + ':', 'g')) || []).length, 2, `${k} en ES y EN`);
}

console.log('OK — content-inline (sin copia de la nube no se edita; se guarda por ruta y por idioma)');

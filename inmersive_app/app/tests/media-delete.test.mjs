// Borrar una foto EMPACADA (media.json) desde la app.
//
// Antes no se podia: `deleteMany` rechazaba toda foto con source 'curated' y
// `delMedia` sacaba un aviso de «editala con el script». No era capricho del
// codigo — esas fotos no tienen fila en la nube, asi que no hay nada que borrar.
// El resultado practico era que las 98 portadas publicadas por el puente
// (23_catalog_to_media) eran INBORRABLES desde el telefono, justo las que hay
// que poder quitar cuando una resulta ser una captura de pantalla o de otro.
//
// La solucion es una LAPIDA: una fila en la nube con la MISMA id y
// status 'deleted'. Esta prueba fija que el merge la respeta, que es reversible
// y que las fotos prestadas (species.photo, foto/hoja del punto) tambien se tapan.
//
// Correr:  node inmersive_app/app/tests/media-delete.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Finales de linea normalizados: git deja CRLF en Windows y las regex con \n
// pegado a un token dejarian de casar sin que nadie haya tocado el codigo.
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8').replace(/\r\n/g, '\n');

// --- comportamiento: se evaluan normMedia + indexMedia de verdad, no su texto ---
const grab = (name) => {
  const re = new RegExp('function ' + name + '\\(([\\s\\S]*?)\\n\\}', 'm');
  const m = re.exec(app);
  assert.ok(m, name + ' debe existir en app.js');
  return 'function ' + name + '(' + m[1] + '\n}';
};
const state = { media: null };
const sandbox = new Function('state',
  grab('normMedia') + '\n' + grab('indexMedia') + '\nreturn { normMedia, indexMedia };')(state);

const estatica = {
  file: 'img/species/copeton__1.webp', jpg: 'img/species/copeton__1.jpg',
  subject_type: 'species', subject_id: 'copeton', is_primary: true,
};

// 1. sin lapida, la foto empacada esta y tiene id estable
let idx = sandbox.indexMedia({ photos: [estatica] }, []);
assert.equal(idx.all.length, 1, 'la foto del build debe aparecer');
const id = idx.all[0].id;
assert.ok(id, 'una foto empacada necesita id derivada (su ruta) o la nube no puede apuntarle');

// 2. con lapida (misma id, status 'deleted') desaparece
idx = sandbox.indexMedia({ photos: [estatica] }, [{ id, url: estatica.jpg, status: 'deleted' }]);
assert.equal(idx.all.length, 0, 'la lapida tiene que ocultar la foto empacada');
assert.ok(idx.deleted.has(id), 'la id tapada se expone para las galerias');
assert.equal((idx.bySubject['species:copeton'] || []).length, 0, 'y no sigue en la galeria');

// 3. es REVERSIBLE: sin la lapida, la foto del build vuelve sola
idx = sandbox.indexMedia({ photos: [estatica] }, []);
assert.equal(idx.all.length, 1, 'quitar la lapida devuelve la foto empacada');

// 4. una fila normal de la nube sigue PISANDO a la empacada, no borrandola
idx = sandbox.indexMedia({ photos: [estatica] },
  [{ id, url: 'https://x/y.jpg', subject_type: 'species', subject_id: 'copeton' }]);
assert.equal(idx.all.length, 1, 'la nube reemplaza por id, no duplica');
assert.equal(idx.all[0].full, 'https://x/y.jpg');

// --- forma: las dos galerias consultan las lapidas ---
// species.photo y la foto/hoja del punto se PRESTAN: nunca pasan por indexMedia,
// asi que sin esta guarda seguirian visibles despues de borrarlas.
const pushes = app.match(/const push = \(m\) => \{[^\n]*\}/g) || [];
assert.equal(pushes.length, 2, 'hay dos galerias con push (especie y punto)');
pushes.forEach((p, i) => assert.ok(/mediaDeleted\(m\.id\)/.test(p),
  'la galeria ' + (i + 1) + ' presta fotos: tiene que mirar las lapidas'));

// --- forma: ningun camino del admin rechaza ya una foto por venir del build ---
assert.ok(!/editala con el script|edítala con el script/.test(admin),
  'delMedia ya no puede rechazar las empacadas');
['deleteMany', 'delMedia'].forEach((fn) => {
  const body = new RegExp('async function ' + fn + '\\(([\\s\\S]*?)\\n\\}', 'm').exec(admin);
  assert.ok(body && /isBundled\(m\)/.test(body[1]),
    fn + ' tiene que usar el mismo criterio isBundled');
});

console.log('media-delete: 11/11 OK');

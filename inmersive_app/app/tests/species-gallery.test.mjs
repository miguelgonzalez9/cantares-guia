// La galería de una especie se gestiona desde la propia ficha (modo edición):
// poner de portada, reclasificar, borrar, añadir, y adoptar una foto prestada.
//
// El riesgo aquí no es visual, es de PÉRDIDA DE TRABAJO: un camino de escritura
// nuevo que no pase por la cola offline pierde lo que se hizo sin señal, que es
// como se usa la app en la reserva. Por eso lo que se fija es que estas acciones
// reutilizan las funciones del panel de Fotos en vez de escribir por su cuenta.
//
// Correr:  node inmersive_app/app/tests/species-gallery.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (...p) => readFileSync(join(PUB, ...p), 'utf8').replace(/\r\n/g, '\n');
const admin = read('js', 'admin.js');
const app = read('js', 'app.js');

// --- 1. las acciones existen y NO abren un camino de escritura propio ---
const ma = /export const mediaActions = \{([\s\S]*?)\n\};/.exec(admin);
assert.ok(ma, 'mediaActions tiene que existir en admin.js');
const body = ma[1];
for (const acc of ['cover', 'reclassify', 'remove', 'add', 'adopt']) {
  assert.ok(new RegExp(`\\b${acc}\\b`).test(body), `falta la acción ${acc}`);
}
// Todo lo que escribe pasa por saveMedia / saveRow / delMedia, que son las que
// encolan. Ni fetch ni supabase directos desde aquí.
assert.ok(!/\bfetch\(/.test(body), 'ninguna acción puede llamar a fetch directamente');
assert.ok(!/supabase|from\('media'\)/.test(body), 'ninguna acción habla con la nube por su cuenta');
assert.ok(/await saveMedia\(/.test(body), 'adoptar usa saveMedia (encola)');
assert.ok(/await delMedia\(/.test(body), 'borrar usa delMedia (encola)');
assert.ok(/await setPrimaryMedia\(/.test(body), 'la portada usa setPrimaryMedia');
assert.ok(/assignPicker\(/.test(body), 'reclasificar reutiliza el selector del panel');
assert.ok(/addMedia\(\{ type: 'species'/.test(body), 'añadir reutiliza addMedia con el sujeto puesto');

// --- 2. el bug que impedía cambiar de portada ---
// Había un `|| s.source === 'curated'` que se saltaba esas filas. Como muchas de
// media.json vienen con is_primary: true, quedaban DOS portadas; y si la elegida
// era curada, no pasaba nada en absoluto.
const sp = /async function setPrimaryMedia\(m\) \{([\s\S]*?)\n\}/.exec(admin);
assert.ok(sp, 'setPrimaryMedia tiene que existir');
assert.ok(!/source === 'curated'/.test(sp[1]),
  'setPrimaryMedia no puede saltarse las fotos curadas: mediaRow ya las convierte a admin');
const rf = /function reframeMakePrimary\(m, type, id\) \{([\s\S]*?)\n\}/.exec(admin);
assert.ok(rf && !/source === 'curated'/.test(rf[1]), 'mismo bug en reframeMakePrimary');
// La vía de escape sigue en su sitio: escribir una fila curada la vuelve 'admin'.
assert.ok(/source: m\.source === 'curated' \? 'admin'/.test(admin),
  'mediaRow convierte curated -> admin, que es lo que hace que la fila de la nube gane');
// Y borrar una curada YA NO está prohibido (antes se rechazaba con un aviso).
// No se puede hacer un DELETE —no hay fila que borrar y volvería en el build—,
// así que se tapa con una lápida: misma id, status 'deleted'. Ver media-delete.test.mjs.
const dm = /async function delMedia\(m\) \{([\s\S]*?)\n\}/.exec(admin);
assert.ok(dm && /isBundled\(m\)/.test(dm[1]) && /status: 'deleted'/.test(dm[1]),
  'borrar una foto del catálogo se hace con lápida, no rechazándola');

// --- 3. la portada anterior se va al final, no se queda a medias ---
assert.ok(/const maxSort = sibs\.reduce/.test(body) && /is_primary: false, sort: maxSort \+ 1/.test(body),
  'al cambiar de portada, la anterior baja al final de la tira');

// --- 4. una foto PRESTADA no se puede borrar desde aquí ---
assert.ok(/const isBorrowedPhoto = \(m\) =>/.test(app), 'hay que distinguir las prestadas');
const gal = /function speciesGalleryHtml\(s, rest, admin\) \{([\s\S]*?)\n\}/.exec(app);
assert.ok(gal, 'speciesGalleryHtml tiene que existir');
const bor = /isBorrowedPhoto\(m\)\s*\?([\s\S]*?):\s*`/.exec(gal[1]);
assert.ok(bor, 'la rama de foto prestada');
assert.ok(/data-a="adopt"/.test(bor[1]), 'a una prestada se le ofrece adoptarla');
assert.ok(!/data-a="del"/.test(bor[1]), 'borrarla quitaría la portada de un punto');
assert.ok(!/data-a="cover"/.test(bor[1]), 'ni ponerla de portada sin adoptarla antes');
// Adoptar apunta a la MISMA url: nunca se duplica el archivo.
assert.ok(/url: m\.full/.test(body), 'adoptar reutiliza la url, no copia el archivo');

// --- 5. fuera del modo edición, la ficha es la de un visitante ---
assert.ok(/const ed = admin && isEditing\(\);/.test(gal[1]),
  'las acciones sólo aparecen con el modo encendido');
assert.ok(/ev\.preventDefault\(\); ev\.stopPropagation\(\);/.test(app),
  'tocar un botón no puede abrir además el visor de la foto');

// --- 6. renderFotos no revienta con el panel cerrado ---
// saveMedia y delMedia la llaman SIEMPRE, y desde la ficha el panel está cerrado.
const rfotos = /function renderFotos\(\) \{([\s\S]*?)\n  const n = /.exec(admin);
assert.ok(rfotos && /if \(!body\) return;/.test(rfotos[1]),
  'renderFotos tiene que rendirse si no hay panel, o subir una foto desde la ficha lanza');

console.log('OK — species-gallery (todo encola, las prestadas se adoptan, las curadas ya se pueden despromover)');

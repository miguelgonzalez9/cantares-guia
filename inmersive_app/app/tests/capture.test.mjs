// Captura del juego (issues #10 y #26). La cámara, el GPS y Pl@ntNet no corren
// sin navegador; aquí se prueba lo que sí es puro: que el buscador no vuelva a
// romperse con una especie sin nombre científico, y que la captura siga siendo
// «guarda primero, identifica después». El resto se prueba con el dedo.
//
// Correr:  node inmersive_app/app/tests/capture.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const game = readFileSync(join(PUB, 'js', 'game.js'), 'utf8');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');
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

// 3. Se enruta por VEREDICTO, no por un umbral de confianza propio.
//    El filtro cliente de 0.70 se tragaba los `outside-inventory`: caían en la
//    rama de «ninguna sugerencia llegó al 70%» y el mejor momento del juego
//    —«puede que hayas encontrado algo nuevo»— no le salía nunca a nadie.
assert.ok(!/SUG_MIN_SCORE/.test(game), 'el umbral cliente debe haber desaparecido');
assert.ok(/verdict === 'outside-inventory'/.test(game), 'outside-inventory necesita su propia rama');
assert.ok(/verdict === 'ok'/.test(game));

// 4. GUARDA PRIMERO: la foto se escribe antes de saber qué es.
assert.ok(/cap\.obs = await saveCapture\(/.test(game));
assert.ok(/idPending: true/.test(game), 'la captura nace sin identificar');
assert.ok(/points: 0, breakdown: \[\]/.test(game), 'y sin puntos: llegan al identificar');

// 5. El gate duro del geocerco va en la ESCRITURA, sobre el fix que ya se toma.
//    Sin fix se guarda igual — un GPS mudo bajo el dosel no puede impedir
//    registrar (sync.js: nunca se descarta trabajo de campo).
assert.ok(/if \(loc && !\(await inReserve\(/.test(game),
  'el geocerco se evalúa sólo cuando hay fix, y bloquea el guardado');

// 6. Fuera la subida desde galería: sólo cámara.
assert.ok(!/gm-file-up/.test(game), 'la subida desde galería debe haber desaparecido');
assert.ok(/id="gm-file-cam" type="file" accept="image\/\*" capture="environment"/.test(game));

// 7. Un solo predicado de permiso, y vive en app.js.
assert.ok(!/function hasAccount\(\)/.test(game), 'game.js ya no define el suyo');
assert.ok(!/isGuestVisitor/.test(app), 'el proxy por flag de invitado debe haber desaparecido');
assert.ok(/const hasAccount = \(\) => !!Cloud\.currentUser\(\);/.test(app));

// 8. La identificación automática la decide el enrutador, no el juego.
assert.ok(/idAvailableFor\(cap\.group\)/.test(game));
assert.ok(!/identifyPlant/.test(game), 'el juego llama al enrutador, no al backend');

// 9. `species_hint` lleva la conjetura del MOTOR y `subject_id` la de la PERSONA.
//    Antes las dos llevaban lo mismo, así que un desacuerdo era invisible en la
//    bandeja y no había nada que revisar.
assert.ok(/species_hint: obs\.engineSci \|\| null/.test(game));

// 10. Duplicados por contenido, con la misma huella que usa la ingesta del admin.
assert.ok(/import \{ sha256Hex \} from '\.\/archive-intake\.js'/.test(game));
assert.ok(/isDuplicatePhoto\(player\.id, hash\)/.test(game));

// 11. Sin premios: los puntos los escribe el cliente y nadie puede comprobarlos.
assert.ok(!/prizes:/.test(game), 'los premios deben haberse eliminado');

// 12. Los tres botones externos siguen fuera (Pl@ntNet / Merlin / iNaturalist).
for (const gone of ['species-tools', 'id_plant', 'id_bird', 'id_inat', 'inat-link']) {
  assert.ok(!html.includes(gone), `${gone} debería haberse eliminado del HTML`);
}

// 13. El juego vive en su pestaña, y el panel viejo ya no existe.
assert.ok(html.includes('data-view="juego"') && html.includes('id="game-tab"'));
assert.ok(!html.includes('id="game-panel"'), 'el panel dentro de Especies debe haber desaparecido');

console.log('capture: 13/13 OK');

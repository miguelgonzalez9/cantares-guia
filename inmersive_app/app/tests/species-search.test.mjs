// Buscador de la pestaña Especies.
//
// Había CUATRO buscadores de especies ad-hoc repartidos por el código
// (app.js: pickSpeciesFor, game.js: renderCandidates, admin.js: assignPicker y
// el de la bandeja) y ninguno en la propia pestaña, que es donde 744 especies
// hacen que recorrer la rejilla no sea viable.
//
// Se ejecuta la función REAL extraída de app.js, no una réplica.
//
// Correr:  node inmersive_app/app/tests/species-search.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');
const html = readFileSync(join(PUB, 'index.html'), 'utf8');

const a = app.indexOf('let speciesQuery');
const b = app.indexOf('function groupFiltered()');
assert.ok(a >= 0 && b > a, 'no encuentro el bloque del buscador');
const { normTxt, matchesQuery } = new Function(`${app.slice(a, b)}\nreturn { normTxt, matchesQuery };`)();

const terms = (q) => normTxt(q).split(/\s+/).filter(Boolean);
const busca = (s, q) => matchesQuery(s, terms(q));

// Especies reales del inventario (campos tal cual salen de species.json).
const tucan = { common_name: 'Tucán pechiazul / Terlaque', common_name_en: 'Black-billed Mountain-Toucan',
  scientific_name: 'Andigena nigrirostris', family: 'Ramphastidae', family_common: 'Toucans',
  ebird_common_es: 'Tucán Piquinegro', ebird_common_en: 'Black-billed Mountain-Toucan' };
const arbol = { common_name: 'Nervios amarillos', common_name_en: null,
  scientific_name: 'Chrysochlamys colombiana', family: 'Clusiaceae' };

// --- sin texto no se filtra nada ---
assert.ok(busca(tucan, ''), 'sin búsqueda entran todas');
assert.ok(busca(arbol, '   '), 'sólo espacios tampoco filtra');

// --- las tildes no pueden ser un obstáculo: nadie las escribe en el móvil ---
assert.ok(busca(tucan, 'tucan'), '«tucan» tiene que encontrar «Tucán»');
assert.ok(busca(tucan, 'TUCÁN'), 'ni las mayúsculas ni las tildes importan');
assert.ok(busca(tucan, 'pechiazul'));

// --- los cuatro nombres por los que alguien conoce un bicho ---
assert.ok(busca(tucan, 'andigena'), 'por nombre científico');
assert.ok(busca(tucan, 'ramphastidae'), 'por familia');
assert.ok(busca(tucan, 'mountain-toucan'), 'por nombre común en inglés');
assert.ok(busca(tucan, 'piquinegro'), 'por el nombre de eBird, que es el que sale en Merlin');
assert.ok(busca(arbol, 'clusiaceae'), 'un árbol sin nombre en inglés se busca igual');

// --- varias palabras: TODAS tienen que aparecer, o el filtro no filtra ---
assert.ok(busca(tucan, 'tucan pechiazul'), 'dos palabras del mismo campo');
assert.ok(busca(tucan, 'tucan ramphastidae'), 'palabras de campos distintos');
assert.ok(!busca(tucan, 'tucan azulejo'), 'si una palabra no está, no coincide');

// --- lo que no es ---
assert.ok(!busca(arbol, 'tucan'));
assert.ok(!busca({ common_name: null, scientific_name: null }, 'algo'),
  'una especie sin ningún nombre no casa con nada, y no revienta');

// --- el campo existe en la pestaña y está antes de los chips de grupo ---
assert.ok(html.includes('id="species-q"'), 'el input existe');
assert.ok(html.indexOf('id="species-q"') < html.indexOf('id="species-filters"'),
  'el buscador va ANTES de los chips: con 744 especies es la puerta de entrada');
assert.ok(/data-i18n-ph="sp_search_ph"/.test(html), 'el placeholder se traduce');
assert.ok(/\$\$\('\[data-i18n-ph\]'\)/.test(app), 'applyStaticI18n aplica los placeholders');
for (const dict of ['sp_search_ph', 'sp_no_match']) {
  assert.strictEqual((app.match(new RegExp(dict + ':', 'g')) || []).length, 2,
    `${dict} tiene que estar en ES y en EN`);
}

// --- se combina con el chip de grupo, no lo sustituye ---
assert.ok(/const base = groupFiltered\(\)\.filter\(\(s\) => matchesQuery\(s, terms\)\);/.test(app),
  'el texto filtra SOBRE el grupo elegido');

console.log('OK — species-search (sin tildes, 4 nombres, todas las palabras)');

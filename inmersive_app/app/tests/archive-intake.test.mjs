// Muestreo del archivo local hacia la app para clasificar a mano.
// El selector de carpeta, crypto.subtle y la subida no existen en node, así que
// aquí se prueba lo que decide QUÉ se sube — que es donde está el criterio.
//
// Correr:  node inmersive_app/app/tests/archive-intake.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArchivePath, coverageGaps, planSample, planByFolder, countByFolder,
  buildEntries, fromFiles, fromDropbox, DEFAULT_BATCH } from '../public/js/archive-intake.js';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');
const sw = readFileSync(join(PUB, 'sw.js'), 'utf8');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');

// 1. La ruta da categoría y, cuando la hay, especie. El primer tramo es el nombre
//    de la carpeta elegida y cambia según desde dónde se elija: se ignora.
assert.deepStrictEqual(parseArchivePath('fotos/aves/molothrus-bonariensis/x.jpg'),
  { category: 'aves', species: 'molothrus-bonariensis' });
assert.deepStrictEqual(parseArchivePath('fotos/paisaje/x.jpg'), { category: 'paisaje', species: null });
assert.deepStrictEqual(parseArchivePath('otra-raiz/aves/x.jpg'), { category: 'aves', species: null });
// Una subcarpeta de trabajo no es una especie: `_originales` o `2019` no lo son.
assert.strictEqual(parseArchivePath('fotos/aves/_originales/x.jpg').species, null);
assert.strictEqual(parseArchivePath('fotos/aves/2019/x.jpg').species, null);
// Sin ruta (selección múltiple a mano en el móvil) no se inventa nada.
assert.deepStrictEqual(parseArchivePath('x.jpg'), { category: null, species: null });

// 2. Los huecos salen de lo que la app YA tiene: especie o punto sin ninguna foto.
const STATE = {
  species: [
    { id: 'roble', scientific_name: 'Quercus humboldtii' },
    { id: 'yolombo', scientific_name: 'Panopsis suaveolens' },
  ],
  waypoints: [{ properties: { id: 'punto_1' } }, { properties: { id: 'punto_2' } }],
  media: { bySubject: { 'species:roble': [{ id: 'm1' }], 'waypoint:punto_1': [{ id: 'm2' }] }, all: [] },
};
const gaps = coverageGaps(STATE);
assert.deepStrictEqual([...gaps.speciesMissing], ['yolombo'], 'roble ya tiene foto');
assert.deepStrictEqual([...gaps.pointsMissing], ['punto_2']);
// El slug de carpeta y el nombre científico apuntan al mismo id de la app.
assert.strictEqual(gaps.speciesBySlug.get('panopsis-suaveolens'), 'yolombo');
assert.strictEqual(gaps.speciesBySlug.get('roble'), 'roble');

// 3. EL PUNTO DEL ASUNTO: la muestra se reparte, no se lleva la categoría gorda.
//    `paisaje` tiene 100 fotos y `hongos` 2; con «los primeros 40» saldrían 40
//    paisajes y ningún hongo.
const many = (cat, n) => Array.from({ length: n }, (_, i) => ({ name: `${cat}${i}.jpg`, dir: cat, category: cat, speciesId: null, punto: null }));
const mixed = [...many('paisaje', 100), ...many('hongos', 2), ...many('aves', 30)];
const pick = planSample(mixed, gaps, 12);
assert.strictEqual(pick.length, 12);
const porCat = pick.reduce((a, p) => (a[p.category] = (a[p.category] || 0) + 1, a), {});
assert.strictEqual(porCat.hongos, 2, 'las 2 de hongos entran enteras');
assert.ok(porCat.paisaje <= 5 && porCat.aves <= 5, `ninguna categoría acapara: ${JSON.stringify(porCat)}`);

// 4. Prioridad: un estrato que tapa un hueco real va ANTES que el resto.
const conHueco = [
  ...many('paisaje', 50),
  { name: 'y.jpg', dir: 'arboles', category: 'arboles', speciesId: 'yolombo', punto: null },   // especie sin fotos
  { name: 'p.jpg', dir: 'paisaje', category: 'paisaje', speciesId: null, punto: 'punto_2' },   // punto sin fotos
];
const first3 = planSample(conHueco, gaps, 3);
assert.ok(first3.some((p) => p.speciesId === 'yolombo'), 'la especie sin fotos entra primero');
assert.ok(first3.some((p) => p.punto === 'punto_2'), 'el punto sin fotos también');

// 5. Pedir más de lo que hay devuelve lo que hay, sin repetir ni quedarse colgado.
const pocas = many('hongos', 3);
const todas = planSample(pocas, gaps, DEFAULT_BATCH);
assert.strictEqual(todas.length, 3);
assert.strictEqual(new Set(todas.map((p) => p.name)).size, 3, 'sin repetidos');
assert.deepStrictEqual(planSample([], gaps, 10), []);

// 6. El catálogo del clasificador manda sobre la carpeta: resolvió la especie
//    contra el inventario cerrado, la carpeta es sólo una convención.
const files = [
  { name: 'a.jpg', webkitRelativePath: 'fotos/paisaje/a.jpg' },
  { name: 'b.jpg', webkitRelativePath: 'fotos/aves/quercus-humboldtii/b.jpg' },
  { name: 'notas.txt', webkitRelativePath: 'fotos/notas.txt' },
];
const cat = { 'a.jpg': { category: 'plantas', scientific_name: 'Panopsis suaveolens', species_id: 'panopsis-suaveolens', punto: 'punto_2' } };
const ent = buildEntries(fromFiles(files), cat, gaps);
assert.strictEqual(ent.length, 2, 'lo que no es imagen se ignora');
assert.strictEqual(ent[0].category, 'plantas', 'la categoría del catálogo gana a la carpeta');
assert.strictEqual(ent[0].speciesId, 'yolombo');
assert.strictEqual(ent[0].punto, 'punto_2');
assert.strictEqual(ent[1].speciesId, 'roble', 'sin catálogo, el slug de la carpeta resuelve');
assert.strictEqual(ent[1].speciesHint, 'quercus humboldtii');

// 7. Lo que se sube entra SIN clasificar y con su procedencia: quien decide qué
//    es una foto es una persona, no esto.
const src = readFileSync(join(PUB, 'js', 'archive-intake.js'), 'utf8');
assert.ok(/status: 'unclassified'/.test(src) && /origin: 'local-archive'/.test(src));
assert.ok(/subject_type: null, subject_id: null/.test(src));
// El hash es la identidad del CONTENIDO — igual que 26_sync_media.py — y el id
// se deriva de él, así que repetir la tanda no duplica ni vuelve a subir.
assert.ok(/if \(knownHashes\.has\(hash\)\) \{ res\.repetidas\+\+; continue; \}/.test(src));
assert.ok(/id: p\.id,/.test(src), 'el id sale de la RUTA (ver caso 15), no del contenido');
assert.ok(/'SHA-256'/.test(src));
// Y va por saveRow: cola offline, sesión de admin, sin caminos de escritura nuevos.
assert.ok(/await saveRow\('media'/.test(src) && !/fetch\(/.test(src), 'nada de subir a mano');

// 8. Cableado: el botón existe, el módulo se precachea (si no, 404 sin señal) y
//    refreshMedia llega al contexto de admin o la bandeja no se refresca.
assert.ok(/id="fm-intake"/.test(admin) && /onclick = pickArchiveFolder/.test(admin));
assert.ok(/webkitdirectory = true/.test(admin), 'elegir carpeta entera, no fichero a fichero');
assert.ok(/'js\/archive-intake\.js',/.test(sw), 'falta en SHELL_ASSETS');
assert.ok(/refreshRoutes, refreshTrails, refreshMedia,/.test(app));


// 9. CUPO POR CARPETA: elegir «aves: 3, hongos: 1» da exactamente eso, y una
//    carpeta con 0 (o sin cupo) no entra — así es como se excluye.
const conCarpetas = [...many('aves', 30), ...many('hongos', 10), ...many('paisaje', 50)];
const porCarpeta = planByFolder(conCarpetas, gaps, { aves: 3, hongos: 1 });
const cuenta = porCarpeta.reduce((a, p) => (a[p.dir] = (a[p.dir] || 0) + 1, a), {});
assert.deepStrictEqual(cuenta, { aves: 3, hongos: 1 }, 'ni una de paisaje, que no tenía cupo');
assert.deepStrictEqual(planByFolder(conCarpetas, gaps, { aves: 0 }), [], 'cupo 0 = excluida');
assert.deepStrictEqual(planByFolder(conCarpetas, gaps, {}), [], 'sin cupos no se trae nada');
// Pedir más de lo que hay devuelve lo que hay, sin repetir.
const dieces = planByFolder(conCarpetas, gaps, { hongos: 99 });
assert.strictEqual(dieces.length, 10);
assert.strictEqual(new Set(dieces.map((p) => p.name)).size, 10);

// 10. El conteo por carpeta es lo que se enseña antes de elegir.
assert.deepStrictEqual(countByFolder(conCarpetas), { aves: 30, hongos: 10, paisaje: 50 });

// 11. Las dos fuentes producen la MISMA forma: a partir de buildEntries, Dropbox
//     y el selector de carpeta son indistinguibles. `get` es lo único distinto —
//     y sólo se llama con las elegidas, para no bajar 900 y quedarse con 40.
const dbxItems = [{ name: 'b.jpg', path: '/cantares/fotos/aves/b.jpg', dir: 'aves' }];
let bajadas = 0;
const entDbx = buildEntries(fromDropbox(dbxItems, () => { bajadas++; return Promise.resolve('blob'); }), {}, gaps);
assert.strictEqual(entDbx.length, 1);
assert.strictEqual(entDbx[0].dir, 'aves');
assert.strictEqual(entDbx[0].category, 'aves');
assert.strictEqual(bajadas, 0, 'listar NO puede bajar nada');
assert.strictEqual(await entDbx[0].get(), 'blob');
assert.strictEqual(bajadas, 1, 'sólo se baja al pedirlo');

// 12. Dropbox: el argumento viaja en una CABECERA HTTP, que sólo admite ASCII.
//     El archivo tiene tildes y eñes; sin escapar, Dropbox devuelve 400 y parece
//     un problema de permisos.
const { headerSafeJSON } = await import('../public/js/dropbox.js');
const h = headerSafeJSON({ path: '/Cantares/fotos/LÉEME ñ.jpg' });
assert.ok(!/[^\x00-\x7F]/.test(h), `la cabecera debe ser ASCII pura: ${h}`);
assert.deepStrictEqual(JSON.parse(h), { path: '/Cantares/fotos/LÉEME ñ.jpg' }, 'y seguir significando lo mismo');
assert.strictEqual(headerSafeJSON({ path: '/a/b.jpg' }), '{"path":"/a/b.jpg"}', 'el ASCII se deja en paz');


// 13. PRIVACIDAD. Lo que se sube queda alcanzable por URL pública (la tabla
//     `media` es de lectura pública), y este archivo es familiar. Las carpetas
//     sin revisar NO pueden quedar marcadas solas: publicar una captura de
//     WhatsApp por darle a un botón no puede ser el camino por defecto.
const { insideArchive } = await import('../public/js/dropbox.js');
const SKIP = (dir) => dir === '(raíz)' || /(^|\/)_/.test(dir);
for (const d of ['(raíz)', '_sin_clasificar', '_desde_app', 'aves/_originales'])
  assert.ok(SKIP(d), `${d} no puede marcarse sola`);
for (const d of ['aves', 'plantas', 'hongos', 'aves/molothrus-bonariensis'])
  assert.ok(!SKIP(d), `${d} sí es una categoría revisada`);

// 14. Con Full Dropbox el token puede leer TODA la cuenta, así que el código no
//     puede pedir nada fuera del archivo. Es defensa en profundidad — la frontera
//     de verdad es elegir una app de tipo App folder.
assert.ok(insideArchive('/Cantares/fotos/aves/x.jpg', '/Cantares/fotos'));
assert.ok(insideArchive('/cantares/FOTOS/aves/x.jpg', '/Cantares/fotos'), 'Dropbox no distingue mayúsculas');
for (const bad of ['/info/escrituras.pdf', '/Cantares/documentos/x.pdf', '/Cantares/fotos-privado/x.jpg',
                   '/Cantares/fotos/../../info/x.pdf'])
  assert.ok(!insideArchive(bad, '/Cantares/fotos'), `debe rechazar ${bad}`);
// Con App folder la raíz ES la carpeta de la app: todo vale menos escaparse.
assert.ok(insideArchive('/aves/x.jpg', ''));
assert.ok(!insideArchive('/../otro/x.jpg', ''));


// 15. DUPLICADOS SIN DESCARGAR. El hash del contenido sólo se conoce tras bajar
//     el fichero, así que deduplicar sólo por contenido obliga a bajarse 40 fotos
//     para descubrir que las 40 ya estaban. El id sale de la RUTA, que sí se sabe
//     de antemano.
const { archiveId, dropAlreadyThere } = await import('../public/js/archive-intake.js');
assert.strictEqual(archiveId('aves/x.jpg'), archiveId('aves/x.jpg'), 'estable');
assert.notStrictEqual(archiveId('aves/x.jpg'), archiveId('flores/x.jpg'),
  'mismo nombre en carpetas distintas NO puede colisionar');
assert.ok(/^arch_[a-z0-9_]+$/.test(archiveId('Aves/P1160506.JPG')), 'id apto para una clave de texto');
assert.ok(archiveId('aves/p1160506.jpg').includes('p1160506'), 'legible: se ve de qué foto habla');
// Rutas largas: se recorta el slug, pero el sufijo va de la ruta COMPLETA, así que
// dos rutas que sólo difieren al principio siguen dando ids distintos.
const a = 'aves/' + 'x'.repeat(90) + '/f.jpg', b = 'flores/' + 'x'.repeat(90) + '/f.jpg';
assert.notStrictEqual(archiveId(a), archiveId(b));
assert.ok(archiveId(a).length < 100);

const picks = [{ id: 'arch_a', name: 'a.jpg' }, { id: 'arch_b', name: 'b.jpg' }, { id: 'arch_c', name: 'c.jpg' }];
const { keep, skipped } = dropAlreadyThere(picks, new Set(['arch_b']));
assert.deepStrictEqual(keep.map((p) => p.id), ['arch_a', 'arch_c']);
assert.deepStrictEqual(skipped.map((p) => p.id), ['arch_b']);
assert.strictEqual(dropAlreadyThere(picks, new Set(['arch_a', 'arch_b', 'arch_c'])).keep.length, 0,
  'una tanda repetida no baja ni un byte');
assert.strictEqual(dropAlreadyThere([], new Set()).keep.length, 0);

// 16. LA CLASIFICACIÓN LOCAL VIAJA. La carpeta ES la clasificación del archivo;
//     antes se usaba para repartir la muestra y se tiraba al subir, así que en la
//     bandeja todas llegaban iguales. Ahora se guarda (migración 24).
const src2 = readFileSync(join(PUB, 'js', 'archive-intake.js'), 'utf8');
assert.ok(/archive_dir: p\.dir && p\.dir !== '\(raíz\)' \? p\.dir : null/.test(src2),
  'la carpeta se guarda, y la raíz no cuenta como carpeta');
assert.ok(/id: p\.id,/.test(src2), 'el id sube derivado de la ruta');
const appSrc = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');
assert.ok(/archive_dir: r\.archive_dir \|\| null/.test(appSrc), 'debe sobrevivir al merge nube/estático');
const adminSrc = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');
assert.ok(/archive_dir: m\.archive_dir \|\| null/.test(adminSrc), 'un upsert no puede borrarla');
assert.ok(/fm-dir/.test(adminSrc), 'y se ve en la tarjeta');

console.log('archive-intake: 16/16 OK');

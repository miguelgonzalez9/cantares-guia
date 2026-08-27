// «Guarda primero, identifica después» (issue #26). Comprueba que una captura
// sin identificar es un estado sano y no una fila rota: no puntúa, no cuenta
// como especie, y al identificarse recibe sus puntos.
//
// Correr:  node inmersive_app/app/tests/game-pending.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const game = readFileSync(join(PUB, 'js', 'game.js'), 'utf8');
const sync = readFileSync(join(PUB, 'js', 'sync.js'), 'utf8');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');

// --- copias de game.js ---
const playerObs = (obs, pid) => obs.filter((o) => o.playerId === pid);
const playerPoints = (obs, pid) => playerObs(obs, pid).reduce((s, o) => s + (o.points || 0), 0);
const distinctSpecies = (obs, pid) =>
  new Set(playerObs(obs, pid).filter((o) => o.speciesId).map((o) => o.speciesId)).size;

// 1. Una captura recién guardada: 0 puntos, sin especie, marcada como pendiente.
const pending = { id: 'x1', playerId: 'p', speciesId: null, points: 0, idPending: true };
const obs = [pending];
assert.strictEqual(playerPoints(obs, 'p'), 0);
assert.strictEqual(distinctSpecies(obs, 'p'), 0,
  'una captura sin identificar no puede contar como especie: inflaría el ranking');

// 2. Al identificarse, suma. Éste es el parcheo que hace `applyId`.
Object.assign(pending, { speciesId: 'roble', points: 20, idPending: false });
assert.strictEqual(playerPoints(obs, 'p'), 20);
assert.strictEqual(distinctSpecies(obs, 'p'), 1);

// 3. Duplicados por huella de contenido, no por nombre de archivo.
const isDup = (list, pid, hash) => !!hash && playerObs(list, pid).some((o) => o.hash === hash);
const withHash = [{ id: 'a', playerId: 'p', hash: 'deadbeef' }];
assert.ok(isDup(withHash, 'p', 'deadbeef'), 'la misma foto otra vez es duplicada');
assert.ok(!isDup(withHash, 'p', 'otra'), 'otra foto no lo es');
assert.ok(!isDup(withHash, 'p', null), 'sin huella no se puede afirmar que sea duplicada');
assert.ok(!isDup(withHash, 'q', 'deadbeef'), 'el duplicado es por jugador, no global');

// 4. La cola encola por `tabla:id`, así que reidentificar reemplaza la operación
//    pendiente en vez de apilar otra. Es lo que permite llamar a pushCloud dos
//    veces (al guardar y al identificar) sin duplicar filas ni subir dos fotos.
assert.ok(/key: `\$\{table\}:\$\{rowKey\(row\)\}`/.test(sync));
assert.ok(/const rowKey = \(row\) => row\.id != null \? row\.id : row\.client_id;/.test(sync));

// 5. `sightings` se puede borrar: estaba en UPSERT y no en REMOVE, así que
//    borrar una captura dejaba la fila y su foto en la nube para siempre.
assert.ok(/sightings: deleteSighting/.test(sync));
assert.ok(/deleteRow\('sightings', id\)/.test(game));
assert.ok(/deleteRow\('media', 'gm-' \+ id\)/.test(game));

// 6. El reintento se cuelga de los disparadores que ya usa la cola, no de un
//    temporizador propio, y se rinde tras un intento fallido: lo demás lo
//    recoge la bandeja del admin, que existe justo para eso.
assert.ok(/window\.addEventListener\('online'/.test(game));
assert.ok(/visibilitychange/.test(game));
assert.ok(/if \(r\.verdict === 'unavailable' \|\| r\.verdict === 'quota'\) return;/.test(game),
  'si el motor sigue sin poder, no se insiste en bucle');

// 7. La captura entra SIEMPRE sin clasificar, aunque el visitante eligiera una
//    especie: quien toca una tarjeta no está confirmando una identificación.
assert.ok(/status: 'unclassified'/.test(game));
assert.ok(/reviewed: false/.test(game));

// 8. Un DESACUERDO entre la persona y el motor tiene que VERSE en la bandeja.
//    El chip del clasificador se pintaba solo cuando no habia nada clasificado
//    (`species_hint && !subject_id`), asi que justo el caso que hay que revisar
//    -foto con especie puesta y conjetura contraria- no se veia.
assert.ok(!/m\.species_hint && !m\.subject_id \?/.test(admin),
  'la condicion vieja escondia los conflictos');
assert.ok(/function hintChip\(m\)/.test(admin));
assert.ok(/fm-hint-conflict/.test(admin), 'un desacuerdo se marca aparte');

// --- la comparacion, tal cual la hace admin.js ---
const norm = (x) => (x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
assert.strictEqual(norm(' Quercus  humboldtii '), norm('quercus humboldtii'));
assert.strictEqual(norm('Quercus humboldtii'), norm('Quércus Humboldtii'),
  'acentos y mayusculas no pueden inventar un conflicto');
assert.notStrictEqual(norm('Quercus humboldtii'), norm('Panopsis suaveolens'));

console.log('game-pending: 11/11 OK');

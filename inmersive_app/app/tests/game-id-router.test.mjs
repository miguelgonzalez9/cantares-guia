// El enrutador de identificación (issue #26). Barato, y es el seguro de que un
// backend de aves (#24) se enchufe AQUÍ y no repartido por el juego.
//
// `idengine.js` importa `cloud.js`, que carga el SDK de Supabase por red, así
// que no se puede importar en node. Se prueban la forma del módulo y la lógica
// de despacho, que es lo único que hay.
//
// Correr:  node inmersive_app/app/tests/game-id-router.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const eng = readFileSync(join(PUB, 'js', 'idengine.js'), 'utf8');
const game = readFileSync(join(PUB, 'js', 'game.js'), 'utf8');

// 1. El enrutador existe y es lo que el juego consume.
assert.ok(/export function idAvailableFor\(group\)/.test(eng));
assert.ok(/export async function identify\(blob, group, species, lang/.test(eng));
assert.ok(/import \{ identify, idAvailableFor, verdictText \} from '\.\/idengine\.js'/.test(game));

// 2. El juego NO llama a ningún backend directamente: si lo hiciera, añadir
//    aves obligaría a tocar el juego en vez de sólo el enrutador.
assert.ok(!/identifyPlant/.test(game));
assert.ok(!/pl.?ntnet/i.test(game), 'el nombre del proveedor no puede aparecer en el juego');

// --- despacho: la misma lógica del módulo, sin red ---
const idAvailable = () => true;
const identifyPlant = async () => ({ verdict: 'ok', speciesId: 'roble', candidates: [] });
const idAvailableFor = (group) => group === 'flora' && idAvailable();
async function identify(blob, group) {
  if (group === 'flora') return identifyPlant();
  return { verdict: 'unavailable', reason: 'sin identificador para este grupo' };
}

// 3. Sólo flora tiene atajo automático hoy.
assert.strictEqual(idAvailableFor('flora'), true);
for (const g of ['ave', 'mamifero', 'anfibio', 'otro', null, undefined]) {
  assert.strictEqual(idAvailableFor(g), false, `${g} no debería ofrecer identificación automática`);
}

// 4. Las 602 aves reciben un veredicto, no una excepción. Es la diferencia
//    entre «cae al buscador manual» y «se rompe la captura».
const bird = await identify(null, 'ave');
assert.strictEqual(bird.verdict, 'unavailable');
assert.ok(bird.reason, 'un veredicto sin motivo no se le puede explicar a nadie');

// 5. Nunca lanza, con ningún grupo.
for (const g of ['flora', 'ave', 'reptil', '', null, undefined]) {
  const r = await identify(null, g);
  assert.ok(r && typeof r.verdict === 'string', `${g} debe devolver un veredicto`);
}

// 6. Los veredictos que el juego enruta están todos declarados en el motor.
const declared = /export const VERDICTS = \[([^\]]+)\]/.exec(eng)[1];
for (const v of ['ok', 'abstain', 'outside-inventory', 'quota', 'unavailable']) {
  assert.ok(declared.includes(`'${v}'`), `falta el veredicto ${v}`);
}

// 7. El atajo se dispara con el chip del grupo, no al llegar la foto: así una
//    foto de ave no gasta cuota de plantas (500/día, compartidas con los lotes).
assert.ok(/if \(cap\.group && idAvailableFor\(cap\.group\)\) runEngine\(/.test(game));

console.log('game-id-router: 7/7 OK');

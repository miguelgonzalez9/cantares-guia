// Prueba de la lógica de decisión de la Edge Function `identify`, sin red, sin
// clave y sin Deno: se copian las dos funciones puras y se ejercitan los casos
// que importan. Correr con:  node supabase/functions/identify/identify.test.mjs
//
// (No se importa index.ts a propósito: ese archivo llama a Deno.serve al cargarse.
//  Si cambias `decide` allí, cambia también la copia de aquí — el selftest avisa
//  de la divergencia comparando el texto de las dos, más abajo.)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCORE_MIN = 0.40, MARGIN_MIN = 0.10;

function normSci(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function decide(candidates, inventory) {
  if (!candidates.length) return { verdict: 'abstain', reason: 'sin candidatos', candidates: [] };
  const ranked = candidates.map((c) => ({ ...c, speciesId: inventory.get(normSci(c.sci)) ?? null }));
  const inHouse = ranked.filter((c) => c.speciesId);
  if (!inHouse.length) {
    return { verdict: 'outside-inventory', reason: `«${ranked[0].sci}» no está en el inventario de la reserva`,
             candidates: ranked.slice(0, 5) };
  }
  const top = inHouse[0], second = inHouse[1]?.score ?? 0;
  if (top.score < SCORE_MIN) return { verdict: 'abstain', reason: 'score bajo', candidates: ranked.slice(0, 5) };
  if (top.score - second < MARGIN_MIN) return { verdict: 'abstain', reason: 'margen bajo', candidates: ranked.slice(0, 5) };
  return { verdict: 'ok', speciesId: top.speciesId, sci: top.sci, common: top.common,
           score: top.score, candidates: ranked.slice(0, 5) };
}

const INV = new Map([
  ['panopsis suaveolens', 'panopsis-suaveolens'],
  ['cedrela montana', 'cedrela-montana'],
]);

// 1. Caso bueno: en inventario, score alto, margen amplio.
{
  const r = decide([{ sci: 'Panopsis suaveolens', common: 'Yolombo', score: 0.91 }], INV);
  assert.strictEqual(r.verdict, 'ok');
  assert.strictEqual(r.speciesId, 'panopsis-suaveolens');
}

// 2. LA guardia: el mejor candidato NO está en la reserva → nunca se asigna.
//    Pl@ntNet conoce el mundo entero; sin esto, cualquier planta de jardín
//    entraría al inventario como especie de la reserva.
{
  const r = decide([
    { sci: 'Monstera deliciosa', common: 'Costilla de Adán', score: 0.97 },
    { sci: 'Ficus lyrata', common: '', score: 0.02 },
  ], INV);
  assert.strictEqual(r.verdict, 'outside-inventory');
  assert.ok(!('speciesId' in r) || !r.speciesId);
}

// 3. Score alto pero dos especies DE LA RESERVA empatadas → abstenerse.
{
  const r = decide([
    { sci: 'Panopsis suaveolens', common: '', score: 0.52 },
    { sci: 'Cedrela montana', common: '', score: 0.48 },
  ], INV);
  assert.strictEqual(r.verdict, 'abstain');
}

// 4. El margen se mide contra el 2º DEL INVENTARIO, no contra el 2º global:
//    que Pl@ntNet dude entre dos especies ajenas no debe restarle confianza a
//    la única que sí existe aquí.
{
  const r = decide([
    { sci: 'Panopsis suaveolens', common: '', score: 0.45 },
    { sci: 'Quercus robur', common: '', score: 0.44 },   // fuera del inventario
  ], INV);
  assert.strictEqual(r.verdict, 'ok', 'el 2º ajeno no debe provocar abstención');
}

// 5. Score por debajo del mínimo → abstenerse aunque esté en el inventario.
{
  const r = decide([{ sci: 'Panopsis suaveolens', common: '', score: 0.31 }], INV);
  assert.strictEqual(r.verdict, 'abstain');
}

// 6. Sin candidatos → abstenerse, no reventar.
assert.strictEqual(decide([], INV).verdict, 'abstain');

// 7. Normalización: acentos, mayúsculas y espacios de más no deben romper el join.
assert.strictEqual(normSci('  Panópsis   SUAVEOLENS '), 'panopsis suaveolens');

// 8. Los umbrales de esta copia deben seguir siendo los del index.ts real.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'index.ts'), 'utf8');
  const num = (name) => Number(new RegExp(`${name}\\s*=\\s*([\\d.]+)`).exec(src)[1]);
  assert.strictEqual(num('SCORE_MIN'), SCORE_MIN, 'SCORE_MIN divergió de index.ts');
  assert.strictEqual(num('MARGIN_MIN'), MARGIN_MIN, 'MARGIN_MIN divergió de index.ts');
}

console.log('identify: 8/8 OK');

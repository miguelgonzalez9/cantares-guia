// La puntuación del juego (issue #26). Es la vía del dinero — lo que decide el
// ranking — y no tenía ni una prueba. Los valores se leen de game.js para que
// cambiar GAME_CFG sin querer rompa aquí y no en la reserva.
//
// Correr:  node inmersive_app/app/tests/game-score.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const game = readFileSync(join(PUB, 'js', 'game.js'), 'utf8');

const num = (k) => {
  const m = new RegExp(`${k}:\\s*([\\d.]+)`).exec(game);
  assert.ok(m, `GAME_CFG.${k} debería existir en game.js`);
  return Number(m[1]);
};
const base = (g) => Number(new RegExp(`basePoints:[^}]*\\b${g}:\\s*(\\d+)`).exec(game)[1]);

const CFG = {
  basePoints: { flora: base('flora'), ave: base('ave'), mamifero: base('mamifero'), anfibio: base('anfibio'), otro: base('otro') },
  flagshipBonus: num('flagshipBonus'),
  confirmMultiplier: num('confirmMultiplier'),
  firstEverBonus: num('firstEverBonus'),
  repeatPoints: num('repeatPoints'),
  unknownPoints: num('unknownPoints'),
  newFindingPoints: num('newFindingPoints'),
  dailyMultiplier: num('dailyMultiplier'),
};

// --- copia de scoreCapture (game.js) ---
const T = (k) => k;
function scoreCapture(species, { repeat, firstEver, isDaily }) {
  const lines = [];
  let pts = CFG.basePoints[species.group] || CFG.basePoints.otro;
  lines.push(['base', pts]);
  if (species.flagship) { lines.push(['flagship', CFG.flagshipBonus]); pts += CFG.flagshipBonus; }
  if (species.status === 'possible') {
    const bonus = pts * (CFG.confirmMultiplier - 1);
    lines.push(['confirm', bonus]); pts += bonus;
  }
  if (repeat) { lines.length = 0; lines.push(['repeat', CFG.repeatPoints]); return { pts: CFG.repeatPoints, lines }; }
  if (firstEver) { lines.push(['first', CFG.firstEverBonus]); pts += CFG.firstEverBonus; }
  if (isDaily) { lines.push(['daily', pts]); pts *= CFG.dailyMultiplier; }
  return { pts, lines };
}

const S = (o = {}) => ({ group: 'flora', flagship: false, status: null, ...o });
const plain = { repeat: false, firstEver: false, isDaily: false };

// 1. Base por grupo. La fauna vale más que la flora.
assert.strictEqual(scoreCapture(S(), plain).pts, CFG.basePoints.flora);
assert.strictEqual(scoreCapture(S({ group: 'ave' }), plain).pts, CFG.basePoints.ave);
assert.ok(CFG.basePoints.anfibio > CFG.basePoints.flora, 'los anfibios valen más que las plantas');

// 2. Bandera suma antes de multiplicar.
assert.strictEqual(scoreCapture(S({ flagship: true }), plain).pts,
  CFG.basePoints.flora + CFG.flagshipBonus);

// 3. `possible` multiplica el acumulado, no sólo la base.
assert.strictEqual(scoreCapture(S({ flagship: true, status: 'possible' }), plain).pts,
  (CFG.basePoints.flora + CFG.flagshipBonus) * CFG.confirmMultiplier);

// 4. REPETIR LA MISMA ESPECIE NO SUMA. Es la regla anti-trampa barata: sin
//    esto, veinte fotos del mismo yarumo escalaban el ranking.
assert.strictEqual(CFG.repeatPoints, 0, 'una recaptura no puede dar puntos');
const rep = scoreCapture(S({ flagship: true, status: 'possible' }), { ...plain, repeat: true });
assert.strictEqual(rep.pts, 0, 'ni siquiera una bandera «possible» puntúa al repetirse');
assert.strictEqual(rep.lines.length, 1, 'y el desglose no debe prometer puntos que no llegan');

// 5. Repetir gana a firstEver: no se pueden dar las dos cosas a la vez.
assert.strictEqual(scoreCapture(S(), { repeat: true, firstEver: true, isDaily: true }).pts, 0);

// 6. La especie del día multiplica AL FINAL, sobre el total ya bonificado.
const daily = scoreCapture(S({ flagship: true }), { ...plain, isDaily: true });
assert.strictEqual(daily.pts, (CFG.basePoints.flora + CFG.flagshipBonus) * CFG.dailyMultiplier);
assert.strictEqual(daily.lines[daily.lines.length - 1][0], 'daily', 'el ×2 va el último');

// 7. Nunca negativo, nunca NaN, ni con un grupo desconocido.
for (const g of ['flora', 'ave', 'mamifero', 'anfibio', 'otro', 'reptil', undefined]) {
  for (const r of [true, false]) for (const fe of [true, false]) for (const d of [true, false]) {
    const { pts } = scoreCapture(S({ group: g }), { repeat: r, firstEver: fe, isDaily: d });
    assert.ok(Number.isFinite(pts) && pts >= 0, `puntos raros para ${g}/${r}/${fe}/${d}: ${pts}`);
  }
}

// 8. «No sé qué es» es PLANO. Por grupo, «di que es un ave y llévate 25» sería
//    la estrategia dominante: puntuar por no identificar nada.
assert.ok(CFG.unknownPoints > 0 && CFG.unknownPoints < CFG.basePoints.flora,
  'debe premiar la honestidad sin competir con identificar de verdad');
assert.ok(/points: GAME_CFG\.unknownPoints/.test(game));
assert.ok(!/unknownPoints\[/.test(game) && !/unknownPoints\.\w/.test(game), 'plano, no por grupo');

// 9. Un hallazgo vale más que cualquier captura normal: es lo que hace crecer
//    el inventario.
assert.ok(CFG.newFindingPoints > Math.max(...Object.values(CFG.basePoints)));

console.log('game-score: 9/9 OK');

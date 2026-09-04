// TRAZO LIBRE como tramo del recorrido.
//
// Alrededor de la casa no hay sendero, hay pasto. Para hacer pasar un recorrido
// por ahí se fueron dibujando senderos de verdad, y hoy la zona de recorrido
// libre se traga 11 de los 19 tramos del Recorrido de Árboles. Un trazo libre
// permite pasar por donde no hay sendero SIN crear uno: entra en `segments` como
// `free:<clave>` y su geometría vive en `routes.freeroam_paths`.
//
// Lo que fija esta prueba, que es donde está el riesgo real:
//   1. `orderedPathFromSegments` resuelve `free:*` contra los trazos del propio
//      recorrido y devuelve, en paralelo, qué coordenadas vienen de uno.
//   2. `freeRoamPath` NO endereza esas coordenadas. Sin la máscara, el trazo
//      —que está entero dentro del polígono— se colapsaría a una recta entre su
//      entrada y su salida, borrando justo lo que se acababa de dibujar.
//
// Se ejecutan las funciones REALES extraídas de app.js, no una réplica: una
// réplica es lo que dejó pasar el bug del arrastre durante semanas
// (seg-reorder.test.mjs reimplementaba la aritmética y nunca tocó wireSegDrag).
//
// Correr:  node inmersive_app/app/tests/freeroam-seg.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');

// --- extraer los trozos reales por sus límites en el archivo ---
const chunk = (startMark, endMark) => {
  const a = app.indexOf(startMark);
  assert.ok(a >= 0, `no encuentro: ${startMark}`);
  const b = app.indexOf(endMark, a);
  assert.ok(b > a, `no encuentro el final: ${endMark}`);
  return app.slice(a, b);
};

const src = [
  chunk('function haversine(a, b) {', '\nfunction ', ),
  chunk('function inPolygon(pt, ring) {', '\nfunction freeRoamRing'),
  chunk('function freeRoamRing() {', '\n// `keep` es la máscara'),
  chunk('function freeRoamPath(cs, keep) {', "\n// Encadena senderos en el ORDEN"),
  chunk('const trailById = (tid) =>', "\n// Greedily chain a route's segments"),
].join('\n');

const build = new Function('state', `${src}\nreturn { orderedPathFromSegments, freeRoamPath, freeRoamRing };`);

// --- escenario: un cuadrado de ~zona libre y dos senderos que la cruzan ---
// La zona va de (0,0) a (0.001,0.001) en grados (~110 m de lado, como la real).
const ZONA = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
const dentro = (x, y) => [0.0002 + x, 0.0002 + y];

const trail = (id, coords) => ({ properties: { id }, geometry: { coordinates: coords } });
const state = {
  freeroam: { polygon: ZONA },
  trails: [
    // entra en la zona por abajo-izquierda y sale por arriba-derecha, con 3
    // vértices intermedios dentro (el zigzag que el enderezado existe para tirar)
    trail('t_cruza', [[-0.0005, -0.0005], dentro(0, 0), dentro(0.0002, 0.0004),
      dentro(0.0004, 0.0001), dentro(0.0006, 0.0006), [0.0015, 0.0015]]),
    trail('t_fuera', [[0.0015, 0.0015], [0.0030, 0.0015]]),
  ],
};
const { orderedPathFromSegments, freeRoamPath, freeRoamRing } = build(state);

assert.ok(freeRoamRing(), 'la zona de prueba debe tener anillo válido');

// ---------- 1. sin trazo libre: el enderezado sigue haciendo su trabajo ----------
const solo = orderedPathFromSegments(['t_cruza'], {});
assert.ok(solo && solo.path.length === 6, 'el sendero entra entero');
assert.deepStrictEqual(solo.free, new Array(6).fill(false), 'nada viene de un trazo libre');

const enderezado = freeRoamPath(solo.path, solo.free);
assert.ok(enderezado.length < solo.path.length,
  'los 4 vértices de dentro de la zona se colapsan a entrada + salida');

// Sin máscara el resultado es el mismo: la máscara sólo puede AÑADIR protección.
assert.deepStrictEqual(freeRoamPath(solo.path), enderezado,
  'sin máscara el comportamiento es el de siempre');

// ---------- 2. un tramo `free:` se resuelve desde el propio recorrido ----------
const TRAZO = [dentro(0.0001, 0.0001), dentro(0.0003, 0.0005), dentro(0.0006, 0.0006)];
const freePaths = { l1: TRAZO };
const built = orderedPathFromSegments(['free:l1'], freePaths);
assert.ok(built, 'el tramo free: se resuelve');
assert.deepStrictEqual(built.path, TRAZO, 'sale la geometría del trazo, tal cual');
assert.deepStrictEqual(built.free, [true, true, true], 'marcadas como dibujadas');

// ---------- 3. EL PUNTO DE TODO: el trazo NO se endereza ----------
const respetado = freeRoamPath(built.path, built.free);
assert.deepStrictEqual(respetado, TRAZO,
  'el trazo libre está entero dentro de la zona: enderezarlo lo borraría');

// Y para que quede claro que la protección es lo que lo salva, no la casualidad:
const sinProteger = freeRoamPath(built.path, [false, false, false]);
assert.strictEqual(sinProteger.length, 2,
  'sin la máscara ese mismo trazo se colapsa a una recta — el bug que la máscara evita');

// ---------- 4. mezclado: sendero + trazo libre en la misma lista ----------
const mix = orderedPathFromSegments(['t_cruza', 'free:l1'], freePaths);
assert.ok(mix.path.length === mix.free.length, 'la máscara va en paralelo al trazado');
assert.ok(mix.free.some(Boolean) && mix.free.some((f) => !f), 'hay de los dos tipos');
const mixOut = freeRoamPath(mix.path, mix.free);
for (const c of TRAZO) {
  assert.ok(mixOut.some((p) => p[0] === c[0] && p[1] === c[1]),
    'cada vértice del trazo dibujado sobrevive al enderezado');
}

// ---------- 5. un trazo que falta no rompe el recorrido ----------
const falta = orderedPathFromSegments(['t_cruza', 'free:no_existe'], freePaths);
assert.ok(falta && falta.path.length === 6, 'el tramo sin geometría se ignora, no revienta');
assert.strictEqual(orderedPathFromSegments(['free:no_existe'], freePaths), null,
  'un recorrido cuyo único tramo falta devuelve null, como cuando no hay senderos');

// ---------- 6. sin zona definida, todo esto es un no-op ----------
const sinZona = build({ freeroam: null, trails: state.trails });
assert.deepStrictEqual(sinZona.freeRoamPath(solo.path, solo.free), solo.path,
  'sin polígono no se endereza nada');

console.log('OK — freeroam-seg (free:* se resuelve y el enderezado lo respeta)');

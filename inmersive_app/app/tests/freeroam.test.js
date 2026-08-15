// Prueba de la zona de recorrido libre: dentro del polígono el trazado se
// vuelve una recta (entra → sale) y fuera no se toca nada.
// Copia literal de las dos funciones de js/app.js (el archivo no es un módulo
// importable sin el DOM). Si allá cambian, esta prueba deja de valer — por eso
// la comparación es de comportamiento, no de implementación.
// Correr:  node app/tests/freeroam.test.js
import assert from 'node:assert';

function inPolygon(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
function freeRoamPath(cs, ring) {
  if (!ring || ring.length < 4 || !Array.isArray(cs) || cs.length < 3) return cs;
  const out = [];
  let i = 0;
  while (i < cs.length) {
    if (!inPolygon(cs[i], ring)) { out.push(cs[i]); i++; continue; }
    let j = i;
    while (j + 1 < cs.length && inPolygon(cs[j + 1], ring)) j++;
    out.push(cs[i]);
    if (j > i) out.push(cs[j]);
    i = j + 1;
  }
  return out.length >= 2 ? out : cs;
}

// Cuadrado unitario alrededor del origen (anillo cerrado).
const RING = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];

// 1. Punto dentro / fuera.
assert.strictEqual(inPolygon([0, 0], RING), true, 'el centro está dentro');
assert.strictEqual(inPolygon([5, 5], RING), false, 'lejos está fuera');

// 2. Un zigzag que ATRAVIESA la zona se colapsa: se conservan el primer y el
//    último vértice de dentro, y desaparecen los intermedios.
const zigzag = [[-3, 0], [-0.9, 0], [-0.5, 0.8], [0, -0.8], [0.5, 0.8], [0.9, 0], [3, 0]];
const smooth = freeRoamPath(zigzag, RING);
assert.deepStrictEqual(smooth, [[-3, 0], [-0.9, 0], [0.9, 0], [3, 0]], 'recta entre entrada y salida');

// 3. Un trazado que NO pasa por la zona queda idéntico.
const away = [[-3, 5], [0, 5], [3, 5]];
assert.deepStrictEqual(freeRoamPath(away, RING), away, 'fuera de la zona no se toca');

// 4. Sin polígono definido (o degenerado) es un no-op — la app funciona igual
//    antes de que el admin dibuje la zona.
assert.deepStrictEqual(freeRoamPath(zigzag, null), zigzag, 'sin zona, sin cambios');
assert.deepStrictEqual(freeRoamPath(zigzag, [[0, 0], [1, 1]]), zigzag, 'anillo degenerado, sin cambios');

// 5. Un trazado ENTERO dentro de la zona queda como una sola recta.
const allIn = [[-0.9, 0], [-0.2, 0.5], [0.3, -0.5], [0.9, 0]];
assert.deepStrictEqual(freeRoamPath(allIn, RING), [[-0.9, 0], [0.9, 0]], 'todo dentro → una recta');

// 6. Dos entradas separadas a la zona se simplifican por separado: de cada
//    tramo dentro sobreviven solo su entrada y su salida.
const twice = [
  [-3, 0], [-0.5, 0], [0, 0.6], [0.5, 0.2], [3, 0],          // 1er tramo dentro: 3 vértices → 2
  [3, 3], [-3, 3],                                            // rodeo por fuera
  [-3, -0.5], [-0.5, -0.5], [0, -0.9], [0.5, -0.2], [3, -3],  // 2º tramo dentro: 3 vértices → 2
];
assert.deepStrictEqual(freeRoamPath(twice, RING), [
  [-3, 0], [-0.5, 0], [0.5, 0.2], [3, 0],
  [3, 3], [-3, 3],
  [-3, -0.5], [-0.5, -0.5], [0.5, -0.2], [3, -3],
], 'cada tramo dentro conserva solo entrada y salida');

console.log('freeroam: 6 casos OK');

// El geocerco del juego (issue #26). Es el número que decide si un visitante de
// verdad, parado en el parqueadero y con el GPS confundido bajo el dosel, puede
// registrar o no. Nunca había tenido prueba.
//
// Las funciones se copian aquí a propósito: `auth-ui.js` es un módulo ES que
// toca `document` al importarse, y `app/` no declara `"type": "module"`. Si la
// copia se desincroniza del original, la aserción de forma al final lo caza.
//
// Correr:  node inmersive_app/app/tests/game-geofence.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const authui = readFileSync(join(PUB, 'js', 'auth-ui.js'), 'utf8');
const game = readFileSync(join(PUB, 'js', 'game.js'), 'utf8');
const gj = JSON.parse(readFileSync(join(PUB, 'data', 'boundary.geojson'), 'utf8'));

// Los dos parámetros salen del código, no de una constante repetida aquí.
const BUFFER = Number(/const GEOFENCE_BUFFER_M = (\d+)/.exec(authui)[1]);
const ACC_CAP = Number(/Math\.min\(accuracy \|\| 0, (\d+)\)/.exec(authui)[1]);

// --- copia literal de auth-ui.js ---
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function polysOf(g) {
  return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
}
function inGeoJSON(pt, gjson) {
  const feats = gjson.type === 'FeatureCollection' ? gjson.features : [gjson];
  for (const f of feats) {
    const g = f.geometry || f; if (!g) continue;
    for (const poly of polysOf(g)) {
      if (pointInRing(pt, poly[0])) {
        let hole = false;
        for (let k = 1; k < poly.length; k++) if (pointInRing(pt, poly[k])) { hole = true; break; }
        if (!hole) return true;
      }
    }
  }
  return false;
}
function distToRingM(pt, ring) {
  const lat0 = pt[1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const ax = (ring[i][0] - pt[0]) * kx, ay = (ring[i][1] - pt[1]) * ky;
    const bx = (ring[i + 1][0] - pt[0]) * kx, by = (ring[i + 1][1] - pt[1]) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((0 - ax) * dx + (0 - ay) * dy) / len2)) : 0;
    min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return min;
}
function distToBoundaryM(pt, gjson) {
  const feats = gjson.type === 'FeatureCollection' ? gjson.features : [gjson];
  let min = Infinity;
  for (const f of feats) {
    const g = f.geometry || f; if (!g) continue;
    for (const poly of polysOf(g)) min = Math.min(min, distToRingM(pt, poly[0]));
  }
  return min;
}
const inReserve = (pt, acc = 0) =>
  inGeoJSON(pt, gj) || distToBoundaryM(pt, gj) <= BUFFER + Math.min(acc || 0, ACC_CAP);

// --- un punto de dentro: el centroide del primer anillo ---
const feats = gj.type === 'FeatureCollection' ? gj.features : [gj];
const ring0 = polysOf(feats[0].geometry || feats[0])[0][0];   // [0] = polígono, [0][0] = anillo exterior
const centro = ring0.reduce((a, c) => [a[0] + c[0] / ring0.length, a[1] + c[1] / ring0.length], [0, 0]);
assert.ok(inReserve(centro, 0), 'el centroide de la reserva tiene que estar dentro');

// --- 5 km al este: fuera, sin discusión ---
const kx = 111320 * Math.cos(centro[1] * Math.PI / 180);
const este = (m) => [centro[0] + m / kx, centro[1]];
assert.ok(!inReserve(este(5000), 0), '5 km al este está fuera');

// --- el buffer: justo fuera del borde, con un GPS mediocre, entra ---
// Se busca un punto a ~(BUFFER - 15) m por fuera del lindero, en el este.
let justOut = null;
for (let m = 100; m < 30000; m += 25) {
  const p = este(m);
  if (!inGeoJSON(p, gj)) {
    const d = distToBoundaryM(p, gj);
    if (d > 10 && d < BUFFER - 10) { justOut = { p, d }; break; }
  }
}
assert.ok(justOut, 'debería existir un punto justo fuera del lindero');
assert.ok(inReserve(justOut.p, 30), `a ${Math.round(justOut.d)} m fuera y ±30 m de GPS, el buffer lo admite`);

// --- el tope de precisión: un fix malísimo NO abre el geocerco de par en par ---
// A 400 m fuera, ni con una precisión declarada de 100 km se entra: la
// tolerancia está acotada a ACC_CAP. Sin ese tope, cualquiera «está» dentro.
let farOut = null;
for (let m = 100; m < 60000; m += 50) {
  const p = este(m);
  if (!inGeoJSON(p, gj) && distToBoundaryM(p, gj) > BUFFER + ACC_CAP + 100) { farOut = p; break; }
}
assert.ok(farOut, 'debería existir un punto claramente fuera');
assert.ok(!inReserve(farOut, 50), 'fuera del buffer + tope no entra');
assert.ok(!inReserve(farOut, 100000), 'una precisión absurda no puede colar a nadie');

// --- forma: el original sigue exportando lo que el juego importa ---
assert.ok(/export async function inReserve\(coords, accuracy = 0\)/.test(authui));
assert.ok(/catch \(e\) \{ return true; \}/.test(authui),
  'sin polígono debe fallar ABIERTO: no se bloquea trabajo de campo');
assert.ok(/import \{ inReserve \} from '\.\/auth-ui\.js'/.test(game));

console.log(`game-geofence: 8/8 OK (buffer ${BUFFER} m, tope de precisión ${ACC_CAP} m)`);

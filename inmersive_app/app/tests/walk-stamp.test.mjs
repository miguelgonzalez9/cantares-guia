// La estampa del recorrido (recorder.js) dibuja la traza SOBRE tiles de satélite.
// Si la proyección de la traza no es la misma que la de los tiles, la línea queda
// corrida respecto a la foto — y en pantalla se ve "casi bien", que es peor.
// Aquí se fija la aritmética: Web Mercator y la eleccion de zoom.
// Correr: node tests/walk-stamp.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// Copia literal de recorder.js (no se puede importar: el modulo toca el DOM).
const lon2px = (lon, z) => (lon + 180) / 360 * 256 * Math.pow(2, z);
const lat2px = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * Math.pow(2, z);
};
function pickZoom(minX, minY, maxX, maxY, maxTiles = 3) {
  for (let z = 18; z >= 12; z--) {
    const w = (lon2px(maxX, z) - lon2px(minX, z)) / 256;
    const h = (lat2px(minY, z) - lat2px(maxY, z)) / 256;
    if (w <= maxTiles && h <= maxTiles) return z;
  }
  return 12;
}

// 1. Mercator en los puntos que se saben de memoria.
assert.strictEqual(lon2px(-180, 0), 0);
assert.strictEqual(lon2px(180, 0), 256);
assert.ok(Math.abs(lon2px(0, 0) - 128) < 1e-9, 'el meridiano 0 cae en el centro');
assert.ok(Math.abs(lat2px(0, 0) - 128) < 1e-9, 'el ecuador cae en el centro');
// Y crece hacia el SUR (el canvas dibuja de arriba a abajo).
assert.ok(lat2px(5.1, 12) < lat2px(5.0, 12), 'mas al norte = menos pixeles');

// 2. La escala dobla con cada zoom.
assert.ok(Math.abs(lon2px(-75.5, 13) - lon2px(-75.5, 12) * 2) < 1e-6);

// 3. Cantares: un recorrido tipico (~600 m) debe caber en pocos tiles y con
//    detalle. Si esto baja de 16, la estampa sale borrosa.
const z = pickZoom(-75.5050, 5.0000, -75.4990, 5.0055);
assert.ok(z >= 16 && z <= 18, `zoom fuera de rango para un recorrido de reserva: ${z}`);
const w = (lon2px(-75.4990, z) - lon2px(-75.5050, z)) / 256;
const h = (lat2px(5.0000, z) - lat2px(5.0055, z)) / 256;
assert.ok(w <= 3 && h <= 3, 'cabe en el presupuesto de tiles');
// Y el siguiente zoom ya NO cabria: se elige el mayor que cabe, no uno cualquiera.
const w2 = (lon2px(-75.4990, z + 1) - lon2px(-75.5050, z + 1)) / 256;
const h2 = (lat2px(5.0000, z + 1) - lat2px(5.0055, z + 1)) / 256;
assert.ok(w2 > 3 || h2 > 3 || z === 18, 'debe elegirse el zoom mas alto que cabe');

// 4. Una traza enorme (toda la reserva y mas) sigue devolviendo un zoom valido.
assert.ok(pickZoom(-75.6, 4.9, -75.4, 5.1) >= 12, 'nunca por debajo del suelo');

// 5. El codigo real sigue usando esta misma aritmetica y el logo de la marca,
//    no un arbolito generico.
const rec = readFileSync(new URL('../public/js/recorder.js', import.meta.url), 'utf8');
assert.ok(/const lon2px = /.test(rec) && /const lat2px = /.test(rec), 'la proyeccion vive en recorder.js');
assert.ok(/cantares-icon\.png/.test(rec), 'el pie lleva el icono de Cantares');
assert.ok(!/🌲/.test(rec), 'y ya no el arbolito');
// El canvas se puede ensuciar con tiles de otro dominio: tiene que haber salida.
assert.ok(/catch[\s\S]{0,200}drawWalk\(walk, size, false\)/.test(rec), 'falta el plan B sin fondo');

console.log(`walk-stamp: proyeccion OK · zoom elegido para un recorrido tipico: ${z}`);

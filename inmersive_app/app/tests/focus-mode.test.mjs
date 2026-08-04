// Lógica del modo enfocado (issue #4). El GPS, la voz y el mapa no corren sin
// navegador, así que aquí se prueba lo único que sí es puro: el rumbo en
// palabras, el umbral de llegada al inicio y la elección escuchar/leer. Lo demás
// se prueba caminando.
//
// Correr:  node inmersive_app/app/tests/focus-mode.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');
const css = readFileSync(join(PUB, 'css', 'style.css'), 'utf8');

// --- copias de las funciones puras de app.js -------------------------------
const R = 6371000;
const rad = (d) => d * Math.PI / 180;
function haversine(a, b) {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearingWord(from, to, LANG = 'es') {
  const dLng = (to[0] - from[0]) * Math.cos((from[1] + to[1]) * Math.PI / 360);
  const dLat = to[1] - from[1];
  const deg = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
  const es = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
  const en = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return (LANG === 'en' ? en : es)[Math.round(deg / 45) % 8];
}

// 1. Los cuatro rumbos cardinales, en los dos idiomas.
const O = [-75.50, 5.00];
assert.strictEqual(bearingWord(O, [-75.50, 5.01]), 'norte');
assert.strictEqual(bearingWord(O, [-75.50, 4.99]), 'sur');
assert.strictEqual(bearingWord(O, [-75.49, 5.00]), 'este');
assert.strictEqual(bearingWord(O, [-75.51, 5.00]), 'oeste');
assert.strictEqual(bearingWord(O, [-75.50, 5.01], 'en'), 'north');
assert.strictEqual(bearingWord(O, [-75.49, 5.00], 'en'), 'east');

// 2. Diagonales — el redondeo a 45° no debe irse a un cardinal.
assert.strictEqual(bearingWord(O, [-75.49, 5.01]), 'noreste');
assert.strictEqual(bearingWord(O, [-75.51, 4.99]), 'suroeste');

// 3. El umbral del inicio (30 m) separa «ya llegaste» de «te falta».
const TRAILHEAD_M = 30;
const start = [-75.5000, 5.0000];
assert.ok(haversine([-75.50005, 5.00005], start) <= TRAILHEAD_M, 'a ~7 m ya llegó');
assert.ok(haversine([-75.5010, 5.0000], start) > TRAILHEAD_M, 'a ~111 m aún no');
// Y el valor del test es el que está en el código, no uno inventado aquí.
assert.strictEqual(Number(/const TRAILHEAD_M = (\d+)/.exec(app)[1]), TRAILHEAD_M);

// 4. El modo por defecto es escuchar: vas caminando, no mirando la pantalla.
assert.ok(/localStorage\.getItem\('cantares_tour_mode'\) \|\| 'listen'/.test(app),
  'el modo por defecto debe ser listen');

// 5. Sólo se pregunta la primera vez; después se recuerda.
assert.ok(/if \(localStorage\.getItem\('cantares_tour_mode'\)\) startGuiding\(id\);/.test(app),
  'con el modo ya elegido, el botón debe arrancar directo');

// 6. Modo enfocado: se ocultan leyenda, satélite y buscador, pero NO la barra de
//    pestañas — se puede consultar Especies a mitad de camino y volver.
const hide = /body\.guiding #legend,[\s\S]*?\{ display: none; \}/.exec(css);
assert.ok(hide, 'falta la regla que oculta el cromo en modo guiado');
assert.ok(/#legend/.test(hide[0]) && /#base-slider-box/.test(hide[0]) && /#search-btn/.test(hide[0]));
assert.ok(!/body\.guiding[^{]*\.tabbar/.test(css), 'la barra de pestañas NO debe ocultarse');

// 7. Entrar y salir del recorrido deben ser simétricos: lo que se añade se quita.
assert.ok(/document\.body\.classList\.add\('guiding'\)/.test(app));
assert.ok(/document\.body\.classList\.remove\('guiding'\)/.test(app));
assert.ok(/pushBack\('guiding'/.test(app) && /popBack\('guiding'\)/.test(app),
  'el botón atrás debe salir del recorrido antes que de la app');

// 8. La llegada a un punto ya no dispara toast + popup + voz a la vez.
const prox = app.slice(app.indexOf('function checkProximity'), app.indexOf('function checkProximity') + 900);
assert.ok(/showGuideCard\(wp\)/.test(prox), 'la llegada debe mostrar UNA tarjeta');
assert.ok(!/miniPopup\(wp\)/.test(prox), 'ya no debe abrir además el mini-popup');

console.log('focus-mode: 8/8 OK');

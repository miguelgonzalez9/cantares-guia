// Interfaz del mapa (issue #10, puntos 11–13): la cortina 2015 ↔ actual, la
// leyenda que se abre hacia arriba y el bloqueo del pellizco sobre el header.
// Nada de esto corre headless (WebGL, gestos), así que se prueba la aritmética
// del recorte y se fija lo estructural.
//
// Correr:  node inmersive_app/app/tests/map-ui.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');
const css = readFileSync(join(PUB, 'css', 'style.css'), 'utf8');
const html = readFileSync(join(PUB, 'index.html'), 'utf8');

// --- copia del cálculo de setCompare() --------------------------------------
const CMP_OPEN_MAX = Number(/const CMP_OPEN_MAX = (\d+)/.exec(app)[1]);
const clampPct = (p) => Math.max(0, Math.min(100, p));
const clipFor = (p) => `inset(0 ${(100 - clampPct(p)).toFixed(2)}% 0 0)`;
const isOpen = (p) => clampPct(p) <= CMP_OPEN_MAX;

// 1. El recorte deja ver la franja IZQUIERDA (el pasado). Al 30% se ve el 30% de
//    la izquierda: se recorta el 70% de la derecha.
assert.strictEqual(clipFor(30), 'inset(0 70.00% 0 0)');
assert.strictEqual(clipFor(0), 'inset(0 100.00% 0 0)', 'a la izquierda del todo: sólo el pasado');
assert.strictEqual(clipFor(100), 'inset(0 0.00% 0 0)');

// 2. Fuera de rango no rompe el recorte (un dedo se sale del mapa al arrastrar).
assert.strictEqual(clipFor(-40), 'inset(0 100.00% 0 0)');
assert.strictEqual(clipFor(180), 'inset(0 0.00% 0 0)');

// 3. Aparcada a la derecha la cortina se considera CERRADA, y entonces el segundo
//    mapa se destruye: un contexto WebGL de más en un teléfono no se deja
//    encendido por si acaso.
assert.strictEqual(isOpen(100), false);
assert.strictEqual(isOpen(99), true);
assert.ok(/if \(x > CMP_OPEN_MAX\) \{ el\.classList\.remove\('on'\); destroyCmpMap\(\); return; \}/.test(app));
assert.ok(/setCompare\(100\)/.test(app), 'arranca cerrada: en reposo no pesa nada');

// 4. El mapa del pasado no puede robarle toques al mapa real.
const cmpCss = /\.cmp-map \{[^}]*\}/.exec(css)[0];
assert.ok(/pointer-events: none/.test(cmpCss));
const barCss = /\.base-compare \{[^}]*\}/.exec(css)[0];
assert.ok(/pointer-events: none/.test(barCss), 'la capa del tirador tampoco');
assert.ok(/\.bc-handle \{[\s\S]*?pointer-events: auto/.test(css), 'salvo el tirador');

// 5. La cámara del segundo mapa sigue a la del principal, o la comparación
//    mentiría en cuanto alguien mueva el mapa.
assert.ok(/state\.map\.on\('move', syncCmpMap\)/.test(app));
assert.ok(/cmpMap\.jumpTo\(\{ center: state\.map\.getCenter\(\)/.test(app));

// 6. El widget viejo se fue entero (HTML, JS y CSS): dejarlo a medias deja un
//    control muerto flotando sobre el mapa.
for (const gone of ['base-slider-box', 'base-toggle', 'base-year', 'base-ticks', 'base-vtrack']) {
  assert.ok(!html.includes(gone), `${gone} sigue en el HTML`);
  assert.ok(!css.includes(gone), `${gone} sigue en el CSS`);
}
for (const gone of ['renderBaseTicks', 'setBaseLayer', 'base_forest_title', 'base_label']) {
  assert.ok(!app.includes(gone), `${gone} sigue en app.js`);
}

// 7. Leyenda hacia arriba: sólo aplica cuando fue arrastrada (en su sitio de
//    origen está anclada por `bottom` y crece hacia arriba sola), y el botón no
//    puede moverse al abrir — el dedo iría a buscarlo donde ya no está.
const tl = app.slice(app.indexOf('function toggleLegend'), app.indexOf('function toggleType'));
assert.ok(/const dragged = !!el\.style\.top/.test(tl));
assert.ok(/dragged && !el\.classList\.contains\('collapsed'\)/.test(tl));
assert.ok(/el\.offsetTop \+ el\.offsetHeight > parent\.clientHeight/.test(tl), 'debe medir el desborde real');
assert.ok(/yBefore - yAfter/.test(tl), 'debe compensar para que el botón no se mueva');
assert.ok(/\.legend\.up \{ flex-direction: column-reverse; \}/.test(css));

// 8. Pellizco sobre el header: Chrome en Android ignora user-scalable=no, así que
//    el meta no basta y hace falta touch-action.
assert.ok(/\.app-header \{[\s\S]*?touch-action: none;[\s\S]*?\}/.test(css));
assert.ok(/user-scalable=no/.test(html), 'el meta se queda: cubre iOS y escritorio');

console.log('map-ui: 8/8 OK');

// Interfaz del mapa (issue #10, puntos 11–13): la cortina 2015 ↔ actual, la
// leyenda que se abre hacia arriba y el bloqueo del pellizco sobre el header.
// Nada de esto corre headless (WebGL, gestos), así que se prueba la aritmética
// del recorte y se fija lo estructural — sobre todo el reparto de capas, que es
// lo que se rehízo: lo dibujado NO puede vivir en un lienzo que se recorta.
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
const clampPct = (p) => Math.max(0, Math.min(100, p));
const clipFor = (p) => `inset(0 0 0 ${clampPct(p).toFixed(2)}%)`;

// 1. Se recorta la imagen ACTUAL por la IZQUIERDA: se ve de la línea hacia la
//    derecha, y por la izquierda asoma la antigua, que está debajo entera.
assert.strictEqual(clipFor(30), 'inset(0 0 0 30.00%)');
assert.strictEqual(clipFor(0), 'inset(0 0 0 0.00%)', 'a la izquierda del todo: sólo la actual');
assert.strictEqual(clipFor(100), 'inset(0 0 0 100.00%)', 'a la derecha del todo: sólo la antigua');

// 2. Fuera de rango no rompe el recorte (un dedo se sale del mapa al arrastrar).
assert.strictEqual(clipFor(-40), 'inset(0 0 0 0.00%)');
assert.strictEqual(clipFor(180), 'inset(0 0 0 100.00%)');

// 3. LA CORRECCIÓN DE FONDO: lo dibujado (zonas, senderos, puntos, GPS) vive en
//    #map, que va TRANSPARENTE y ENCIMA y no se recorta nunca. Antes el mapa del
//    pasado iba encima y tapaba los puntos de media pantalla.
assert.ok(/function buildStyle\(\) \{\s*return \{ version: 8, sources: \{\}, layers: \[\] \};/.test(app),
  'el mapa principal no puede llevar ni imagen ni fondo');
assert.ok(/#map \{[^}]*background: transparent;[^}]*z-index: 3;/.test(css));
assert.ok(/#img-old \{ z-index: 1; \}/.test(css) && /#img-now \{ z-index: 2; \}/.test(css),
  'las imágenes van DEBAJO del mapa dibujado');
// El recorte se aplica a la imagen, jamás al mapa que lleva los puntos.
assert.ok(/if \(now\) now\.style\.clipPath/.test(app));
assert.ok(!/\$\('#map'\)\.style\.clipPath/.test(app), '#map no se recorta nunca');

// 4. Arranca en el MEDIO: la comparación es el punto de la herramienta.
assert.ok(/setCompare\(50\);/.test(app));
assert.ok(/aria-valuenow="50"/.test(html), 'el HTML arranca coherente con el JS');

// 5. Los dos mapas de imagen siguen a la cámara del principal a la vez, así que
//    al hacer zoom van acompasados y la costura entre ellos no se rompe.
assert.ok(/state\.map\.on\('move', syncImagery\)/.test(app));
assert.ok(/state\.map\.on\('resize', syncImagery\)/.test(app));
const sync = app.slice(app.indexOf('function syncImagery'), app.indexOf('// pct = posición'));
assert.ok(/imgMaps\.old\.jumpTo\(c\)/.test(sync) && /imgMaps\.now\.jumpTo\(c\)/.test(sync),
  'los dos con la MISMA cámara, o la costura baila');

// 6. Los mapas de imagen no roban toques ni traen controles duplicados.
assert.ok(/\.img-map \{[^}]*pointer-events: none/.test(css));
assert.ok(/interactive: false, attributionControl: false/.test(app));
// …pero la atribución de Esri no puede perderse: es obligatoria por licencia y
// ahora la fuente raster ya no la aporta al mapa que sí tiene control.
assert.ok(/customAttribution: 'Imagery © Esri, Maxar, Earthstar Geographics'/.test(app));

// 7. Sin tirador (recorrido guiado, elegir puntos) la imagen actual vuelve a
//    cubrirlo todo: si no, se quedaría media pantalla en 2015 sin poder moverla.
assert.ok(/body\.guiding #img-now,\s*\n\s*body\.picking-points #img-now \{ clip-path: none !important; \}/.test(css));
assert.ok(/body\.guiding #base-compare/.test(css) && /body\.picking-points #base-compare/.test(css));

// 8. El widget viejo se fue entero (HTML, JS y CSS): dejarlo a medias deja un
//    control muerto flotando sobre el mapa.
for (const gone of ['base-slider-box', 'base-toggle', 'base-year', 'base-ticks', 'base-vtrack', 'cmp-map']) {
  assert.ok(!html.includes(gone), `${gone} sigue en el HTML`);
  assert.ok(!css.includes(gone), `${gone} sigue en el CSS`);
}
for (const gone of ['renderBaseTicks', 'setBaseLayer', 'base_forest_title', 'base_label']) {
  assert.ok(!app.includes(gone), `${gone} sigue en app.js`);
}

// 9. Leyenda hacia arriba: sólo aplica cuando fue arrastrada (en su sitio de
//    origen está anclada por `bottom` y crece hacia arriba sola), y el botón no
//    puede moverse al abrir — el dedo iría a buscarlo donde ya no está.
const tl = app.slice(app.indexOf('function toggleLegend'), app.indexOf('function toggleType'));
assert.ok(/const dragged = !!el\.style\.top/.test(tl));
assert.ok(/el\.offsetTop \+ el\.offsetHeight > parent\.clientHeight/.test(tl), 'debe medir el desborde real');
assert.ok(/yBefore - yAfter/.test(tl), 'debe compensar para que el botón no se mueva');
assert.ok(/\.legend\.up \{ flex-direction: column-reverse; \}/.test(css));

// 10. Pellizco sobre el header: Chrome en Android ignora user-scalable=no, así
// 10. Pellizco sobre el header: se defiende con touch-action, NO quitandole el
//     zoom a toda la pagina (Chrome en Android ignora user-scalable de todas formas).
const vp = /<meta name="viewport"[^>]*>/.exec(html)[0];
assert.ok(!/user-scalable=no|maximum-scale/.test(vp), 'el zoom se deja abierto: agrandar la letra es accesibilidad');

console.log('map-ui: 10/10 OK');

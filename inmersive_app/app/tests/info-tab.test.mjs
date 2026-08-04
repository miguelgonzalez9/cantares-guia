// Pestaña Info (issue #10, puntos 9 y 10). Nada de esto corre headless, así que
// aquí se fija lo estructural: el orden de los bloques, que el editor de la
// visita esté cableado de punta a punta, y que lo que se quitó no haya quedado a
// medias (un `t()` sin clave devuelve la clave y se ve en pantalla).
//
// Correr:  node inmersive_app/app/tests/info-tab.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html = readFileSync(join(PUB, 'index.html'), 'utf8');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');
const css = readFileSync(join(PUB, 'css', 'style.css'), 'utf8');

// 1. Orden en la pestaña Info: datos → comercial → planea tu visita.
const info = html.slice(html.indexOf('<section id="view-info"'), html.indexOf('<!-- Ficha'));
const iFacts = info.indexOf('class="facts"');
const iCom = info.indexOf('id="comercial"');
const iVisit = info.indexOf('id="visit-info"');
assert.ok(iFacts > 0 && iCom > 0 && iVisit > 0, 'los tres bloques deben existir');
assert.ok(iFacts < iCom, 'la información comercial va DEBAJO de los primeros datos');
assert.ok(iCom < iVisit, 'la comercial va ANTES de «Planea tu visita»');

// 2. El mapa ilustrado de senderos ya no está en Info (sí sigue en Historia, que
//    es otro panel: el «antes/después» de la ortofoto).
assert.ok(!/map_illus/.test(info) && !/illus-map/.test(info), 'fuera de Info');
assert.ok(!/map_illus/.test(app), 'y su clave i18n también');
assert.ok(/illus-map/.test(css), 'la clase sigue viva para el panel de Historia');

// 3. El bloque de seguridad se fue entero: panel, claves i18n y CSS. Un `t()` sin
//    clave devuelve la propia clave, así que media limpieza se VE en pantalla.
for (const gone of ['v_safety_h', 'v_lost', 'v_emergency', 'cm_reviews_link']) {
  assert.ok(!app.includes(gone), `${gone} debería haberse eliminado de app.js`);
}
for (const gone of ['v-safety', 'v-emg-btn', 'v-emergency', '.cm-btn']) {
  assert.ok(!css.includes(gone), `${gone} debería haberse eliminado del CSS`);
}

// 4. Un solo enlace a Airbnb. Antes había dos al MISMO destino (arriba y bajo las
//    reseñas), lo que hace dudar de si llevan a sitios distintos.
assert.strictEqual((app.match(/airbnb_url/g) || []).length, 1, 'exactamente un uso de airbnb_url');

// 5. Los íconos son SVG EN LÍNEA: la app tiene que verse igual sin señal.
const icons = app.slice(app.indexOf('const APP_ICONS'), app.indexOf('function linkCard'));
for (const k of ['airbnb', 'wa', 'ig', 'mail']) assert.ok(icons.includes(`${k}:`), `falta el ícono ${k}`);
assert.ok(!/https?:\/\//.test(icons), 'ningún ícono puede venir de la red');

// 6. Los enlaces externos llevan rel="noopener"; mailto: no debe abrir pestaña.
const lc = app.slice(app.indexOf('function linkCard'), app.indexOf('function linkCard') + 600);
assert.ok(/\/\^https\?:\/\.test\(url\)/.test(lc.replace(/\s+/g, '')) || /\^https\?:/.test(lc));
assert.ok(/rel="noopener"/.test(lc));

// 7. El editor de «datos de la visita» está cableado de punta a punta: esquema,
//    origen del borrador, aplicación del guardado y re-render.
assert.ok(/reserve_info: \{/.test(admin), 'falta el esquema reserve_info');
assert.ok(/reserve_info: CTX\.state\.reserveInfo/.test(admin), 'el borrador debe salir del estado');
assert.ok(/openContentEditor\('reserve_info'\)/.test(app), 'el botón debe abrirlo');
assert.ok(/r\.id === 'reserve_info'\) state\.reserveInfo = r\.doc/.test(app), 'la nube debe sobrescribirlo');
assert.ok(/renderHistoria\(\); renderComercial\(\); renderVisitInfo\(\);/.test(app),
  'guardar debe repintar la visita, o el cambio no se ve hasta recargar');
// Y las dos claves i18n del botón, en los dos idiomas.
assert.strictEqual((app.match(/ce_edit_visit:/g) || []).length, 2, 'ce_edit_visit en ES y EN');

console.log('info-tab: 7/7 OK');

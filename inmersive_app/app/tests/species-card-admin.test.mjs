// Editar y reclasificar desde la REJILLA de especies, no desde un interruptor.
//
// Antes la pestaña Especies tenia un unico boton general: para arreglar una
// especie que ves mal en la rejilla habia que encender el modo, abrir la ficha
// y buscar el sitio. Y no habia forma de llegar a las fotos de ESA especie, que
// es donde se reclasifica una foto que quedo en la especie equivocada.
//
// Ahora cada tarjeta trae ✏️ (editar esa especie) y 🖼️ (sus fotos). El
// interruptor general sigue existiendo porque el modo es GLOBAL —gobierna la
// ficha y el texto en sitio de otras pestañas— pero solo se ve para APAGARLO.
//
// Correr:  node inmersive_app/app/tests/species-card-admin.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(PUB, 'css', 'style.css'), 'utf8');

const grid = /function renderSpeciesGrid\(highlightId\) \{([\s\S]*?)\nfunction /.exec(app);
assert.ok(grid, 'renderSpeciesGrid tiene que existir');
const body = grid[1];

// --- 1. las acciones viven en la TARJETA y solo las ve un admin ---
assert.ok(/isAdminUser\(\) \? `<span class="sp-adm">/.test(body),
  'los botones se pintan en la tarjeta, y solo para admin');
['edit', 'fotos'].forEach((a) => assert.ok(new RegExp('data-a="' + a + '"').test(body),
  'falta el boton ' + a + ' en la tarjeta'));

// --- 2. el clic del boton NO abre ademas la ficha ---
const wire = /card\.querySelectorAll\('\.sp-adm button'\)([\s\S]*?)\n    \}\);/.exec(body);
assert.ok(wire, 'los botones de la tarjeta tienen que cablearse');
assert.ok(/ev\.stopPropagation\(\)/.test(wire[1]),
  'sin stopPropagation el clic burbujea a card.onclick y abre la ficha encima');

// --- 3. 🖼️ va a las fotos de ESA especie (reclasificar), no a la bandeja entera ---
assert.ok(/openMediaFor\('species', s\.id\)/.test(wire[1]),
  'el boton de fotos tiene que abrir el gestor filtrado por esta especie');
assert.ok(/openMediaFor/.test(app.split('\n').find((l) => l.includes("from './admin.js'")) || ''),
  'openMediaFor tiene que importarse de admin.js');

// --- 4. ✏️ enciende el modo global y abre esa especie ---
assert.ok(/if \(!isEditing\(\)\) setEditing\(true\);/.test(wire[1]) && /showSpecies\(s\)/.test(wire[1]),
  'editar desde la tarjeta no puede exigir buscar antes un interruptor');

// --- 5. el interruptor de edicion vive en la FICHA, no sobre la rejilla ---
// En la rejilla no hay nada que mirar mientras el modo esta encendido; en la
// ficha si (titulo, galeria y texto se vuelven editables). La barra de la
// rejilla se queda solo con «+ nueva especie».
assert.ok(!/editToggleButton/.test(body),
  'el interruptor no puede seguir sobre la rejilla');
const sheet = /function showSpecies\(s\) \{([\s\S]*?)\n\}/.exec(app);
assert.ok(sheet, 'showSpecies tiene que existir');
assert.ok(/editToggleButton\(\{ label: t\('ie_on'\)/.test(sheet[1]),
  'al abrir una especie tiene que aparecer el interruptor de edicion');
assert.ok(/onToggle: \(\) => \{ showSpecies\(s\); renderSpeciesGrid\(\); \}/.test(sheet[1]),
  'al cambiar el modo hay que repintar la ficha (la galeria solo se cablea encendida) y la rejilla');
assert.ok(/sp-admin-actions/.test(sheet[1]),
  'va con las demas acciones de admin de la ficha');

// --- 6. paridad ES/EN de la etiqueta nueva + no tapa la estrella ---
assert.equal((app.match(/sp_photos:/g) || []).length, 2, 'sp_photos tiene que estar en ES y EN');
assert.ok(/\.species-card \.sp-adm \{[^}]*left:/.test(css) && /\.species-card \.star \{[^}]*right:/.test(css),
  'las acciones van a la izquierda: la derecha es de la estrella de destacada');

console.log("species-card-admin: 13/13 OK");

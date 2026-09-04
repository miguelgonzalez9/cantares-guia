// Todo lo que la app carga tiene que estar en el precache del service worker.
//
// Este es el fallo que no se ve nunca en el escritorio: un módulo o un JSON
// nuevo funciona perfectamente con señal, y en la reserva —sin cobertura, que es
// donde se usa la app— da 404 y se rompe la pantalla que lo necesitaba. Ya pasó
// antes con un `data/*.json`; hoy casi vuelve a pasar con `js/inline-edit.js`.
//
// La guarda es mecánica a propósito: no depende de que nadie se acuerde de
// añadir el archivo a la lista, sino de que el test lo compruebe.
//
// Correr:  node inmersive_app/app/tests/precache-complete.test.mjs
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (...p) => readFileSync(join(PUB, ...p), 'utf8').replace(/\r\n/g, '\n');
const sw = read('sw.js');
const html = read('index.html');

// --- lo que el service worker promete tener offline ---
const listOf = (name) => {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(sw);
  assert.ok(m, `no encuentro ${name} en sw.js`);
  return (m[1].match(/'([^']+)'/g) || []).map((x) => x.slice(1, -1));
};
const precached = new Set([...listOf('CORE_ASSETS'), ...listOf('SHELL_ASSETS')]);

// --- 1. todo modulo JS local, alcanzable desde el HTML, esta precacheado ---
const entry = (html.match(/src="(js\/[^"]+)"/g) || []).map((x) => x.slice(5, -1));
assert.ok(entry.length, 'el HTML tiene que cargar al menos un modulo');

const seen = new Set();
const pend = [...entry];
while (pend.length) {
  const f = pend.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  let src;
  try { src = read(f); } catch (e) { assert.fail(`${f} se importa pero no existe en disco`); }
  // import ... from './x.js'  |  import('./x.js')
  for (const m of src.matchAll(/from\s+'\.\/([^']+\.js)'|import\('\.\/([^']+\.js)'\)/g)) {
    pend.push('js/' + (m[1] || m[2]));
  }
}
for (const f of seen) {
  assert.ok(precached.has(f), `${f} se carga pero NO esta en el precache del sw: online funciona, en la reserva da 404`);
}

// --- 2. todo data/*.json que la app pide al arrancar esta precacheado ---
const app = read('js/app.js');
const cfg = /data: \{([\s\S]*?)\n  \},/.exec(app);
assert.ok(cfg, 'no encuentro CONFIG.data');
for (const m of cfg[1].matchAll(/'(data\/[^']+)'/g)) {
  assert.ok(precached.has(m[1]), `${m[1]} esta en CONFIG.data pero NO en el precache`);
}

// --- 3. nada en el precache que ya no exista en disco ---
const enDisco = new Set(readdirSync(join(PUB, 'js')).map((f) => 'js/' + f));
for (const a of precached) {
  if (a.startsWith('js/')) {
    assert.ok(enDisco.has(a), `${a} esta en el precache pero ya no existe: el sw fallaria al instalar`);
  }
}

// --- 4. la version del sw se toca en cada despliegue ---
assert.ok(/const VERSION = 'cantares-v\d+';/.test(sw), 'VERSION tiene que existir y llevar numero');

console.log(`OK — precache-complete (${seen.size} modulos, ${precached.size} entradas)`);

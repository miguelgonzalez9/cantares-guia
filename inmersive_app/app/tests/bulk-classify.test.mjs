// Clasificar varias fotos a la vez (bandeja del admin). El panel no arranca
// headless, así que aquí se fija lo que no puede volver a romperse: que el lote
// no repinte por foto, que relea el estado en cada vuelta, y que la selección
// sobreviva al repintado.
//
// Correr:  node inmersive_app/app/tests/bulk-classify.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');
const css = readFileSync(join(PUB, 'css', 'style.css'), 'utf8');
const fn = (name) => {
  const i = admin.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} no encontrado`);
  return admin.slice(i, i + 2200);
};

// 1. La selección vive FUERA del render. La bandeja se repinta a cada guardado;
//    una selección guardada en el DOM se perdería en el primer repintado.
assert.ok(/^const mediaSel = new Set\(\);/m.test(admin));
assert.ok(/const sel = mediaSel\.has\(m\.id\);/.test(admin), 'la tarjeta se pinta desde el Set');

// 2. EL PUNTO: el lote NO repinta ni avisa por foto. Con 30 seleccionadas serían
//    30 repintados y 30 avisos, y el repintado se llevaría la barra de progreso.
// Acotado al cuerpo real: una ventana de N caracteres se metía en deleteMany y
// contaba sus repintados como si fueran del lote de clasificar.
const many = admin.slice(admin.indexOf('async function classifyMany('), admin.indexOf('async function deleteMany('));
assert.ok(!/saveMedia\(/.test(many), 'no puede pasar por saveMedia (repinta y avisa)');
assert.ok(/await saveRow\('media'/.test(many) && /CTX\.applyLocalRow\('media', res\.row\)/.test(many));
assert.strictEqual((many.match(/renderFotos\(\)/g) || []).length, 1, 'un solo repintado, al final');
assert.strictEqual((many.match(/CTX\.toast\(/g) || []).length, 1, 'un solo aviso, al final');

// 3. Relee cada fila del estado en cada vuelta. `mediaRow` reconstruye la fila
//    ENTERA: partir de una copia vieja borraría lo que cambió entretanto.
assert.ok(/const m = allMedia\(\)\.find\(\(x\) => x\.id === ids\[i\]\);/.test(many));

// 4. Cuenta lo que falla en vez de darlo por bueno, y limpia la selección.
assert.ok(/fail\+\+/.test(many) && /selClear\(\)/.test(many));
assert.ok(/queued/.test(many), 'lo que quede en cola debe decirse');

// 5. Un solo selector para una y para muchas: duplicarlo dejaría dos buscadores
//    que se separan con el tiempo.
const pick = admin.slice(admin.indexOf('function assignPicker('), admin.indexOf('// Abre el clasificador directamente'));
assert.ok(/const many = Array\.isArray\(m\);/.test(pick));
assert.ok(/if \(many\) await classifyMany\(ids, pt, it\.dataset\.id\);/.test(pick));
assert.ok(/\$\{!many && m\.subject_id \?/.test(pick), '«dejar sin clasificar» no aplica a un lote');

// 6. Borrado en lote: las curadas viven en el catálogo del build y no se pueden
//    borrar desde aquí — contarlas como éxito sería mentir.
const del = admin.slice(admin.indexOf('async function deleteMany('), admin.indexOf('function renderSelBar('));
assert.ok(/m\.source === 'curated'/.test(del) && /confirm\(/.test(del));

// 7. «Seleccionar las visibles» alterna: si ya están todas, las quita.
const all = fn('wireSelAll');
assert.ok(/const todas = list\.every\(\(m\) => mediaSel\.has\(m\.id\)\);/.test(all));

// 8. La casilla no se pelea con abrir la foto grande: van en sitios distintos y
//    la casilla corta la propagación.
assert.ok(/cb\.onchange = \(e\) => \{\s*\n\s*e\.stopPropagation\(\);/.test(admin));
assert.ok(/\.fm-pick \{ position: absolute/.test(css));
assert.ok(/\.fm-card\.sel \{ outline/.test(css), 'lo seleccionado tiene que verse');

console.log('bulk-classify: 8/8 OK');

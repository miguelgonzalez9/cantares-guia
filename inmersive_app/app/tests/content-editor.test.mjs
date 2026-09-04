// El editor de páginas (historia / comercial / reserve_info) no guardaba NADA.
//
// `inputFor(f, val, id)` usaba su tercer argumento como el id COMPLETO del
// elemento, pero los tres llamadores le pasan un PREFIJO ('top_',
// `f_${li}_${ii}_`). Así que todos los campos se pintaban con el mismo
// `id="top_"`, y `harvest()` -> `readInto` buscaba `#top_lead`, que no existía:
// salía por `if (!el) return` en cada campo y no recogía nada. Al guardar se
// escribía la copia profunda sin tocar. En Supabase quedó la prueba: el doc de
// 'historia' escrito el 2026-08-30 es idéntico byte a byte al historia.json
// empacado.
//
// Esta prueba ejecuta el inputFor REAL del archivo (no una réplica, que es lo
// que dejó pasar el bug en seg-reorder.test.mjs) y comprueba que el id que
// emite es exactamente el que readInto va a buscar.
//
// Correr:  node inmersive_app/app/tests/content-editor.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');

// --- extraer el inputFor real y ejecutarlo ---
const m = /const inputFor = \(f, val, prefix\) => \{([\s\S]*?)\n  \};/.exec(admin);
assert.ok(m, 'inputFor debe recibir un PREFIJO, no un id ya compuesto');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inputFor = new Function('esc', `return (f, val, prefix) => {${m[1]}\n};`)(esc);

const idOf = (html) => (/ id="([^"]*)"/.exec(html) || [])[1];

// --- campos de primer nivel: prefijo 'top_' ---
const lead = inputFor({ k: 'lead', t: 'area', l: 'Frase' }, 'hola', 'top_');
const leadEn = inputFor({ k: 'lead_en', t: 'area', l: 'Opening' }, 'hi', 'top_');
assert.strictEqual(idOf(lead), 'top_lead');
assert.strictEqual(idOf(leadEn), 'top_lead_en');
assert.notStrictEqual(idOf(lead), idOf(leadEn), 'dos campos no pueden compartir id');

// --- ítems de lista: prefijo `f_${li}_${ii}_` ---
assert.strictEqual(idOf(inputFor({ k: 'titulo', t: 'text', l: 'T' }, 'x', 'f_0_1_')), 'f_0_1_titulo');
assert.strictEqual(idOf(inputFor({ k: 'hito', t: 'check', l: 'H' }, true, 'f_1_2_')), 'f_1_2_hito');

// El <label for> tiene que apuntar al mismo id, o tocar la etiqueta no enfoca.
assert.ok(lead.includes('for="top_lead"'), 'el label debe apuntar al id compuesto');

// --- el contrato con readInto: busca '#' + prefix + f.k ---
assert.ok(/const el = ov\.querySelector\('#' \+ prefix \+ f\.k\)/.test(admin),
  'readInto compone el selector con el mismo prefijo + clave');

// --- todos los llamadores pasan un prefijo, no un id ---
assert.ok(/inputFor\(f, doc\[f\.k\], 'top_'\)/.test(admin), 'campos de primer nivel');
assert.ok(/inputFor\(f, it\[f\.k\], `f_\$\{li\}_\$\{ii\}_`\)/.test(admin), 'campos de lista');

// --- guardar recoge la pantalla ANTES de escribir ---
const save = /ov\.querySelector\('\.ce-save'\)\.onclick = async \(\) => \{([\s\S]*?)saveRow\('content'/.exec(admin);
assert.ok(save && /harvest\(\);/.test(save[1]), 'ce-save debe llamar a harvest() antes de saveRow');

console.log('OK — content-editor (el id se compone del prefijo; historia/comercial/info guardan)');

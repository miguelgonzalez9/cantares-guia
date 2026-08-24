// Cada paso de la guía (js/guide.js) señala un elemento REAL por su selector.
// Un botón renombrado deja el paso apuntando al vacío — y como el motor degrada
// a tarjeta en vez de reventar, el fallo es SILENCIOSO. Esta prueba lo hace
// ruidoso: comprueba que cada `anchor`/`wait` existe en el código de la app.
// Correr: node tests/guide-anchors.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const guide = read('js/guide.js');
const haystack = ['index.html', 'js/app.js', 'js/admin.js'].map(read).join('\n');

// Selectores declarados en la guía: anchor: '…' / wait: '…'
const sels = [...guide.matchAll(/\b(?:anchor|wait):\s*'([^']+)'/g)].map((m) => m[1])
  // click('#pt-add') abre una rama: si ese id cambia, el sub-tutorial sale vacio.
  .concat([...guide.matchAll(/click\('([^']+)'\)/g)].map((m) => m[1]));
assert.ok(sels.length >= 20, `pocos selectores encontrados (${sels.length}) — ¿cambió el formato?`);

// De un selector a los trozos que TIENEN que aparecer en el código de la app:
// '#pt-add' → 'pt-add'; '.admin-tab[data-t="fotos"]' → 'admin-tab' + 'data-t' + 'fotos'.
function needles(sel) {
  const out = [];
  for (const m of sel.matchAll(/#([\w-]+)/g)) out.push(m[1]);
  for (const m of sel.matchAll(/\.([\w-]+)/g)) out.push(m[1]);
  for (const m of sel.matchAll(/\[([\w-]+)(?:[~|^$*]?=\s*"([^"]*)")?\]/g)) { out.push(m[1]); if (m[2]) out.push(m[2]); }
  return out;
}

const missing = [];
for (const sel of new Set(sels)) {
  for (const n of needles(sel)) {
    if (!haystack.includes(n)) missing.push(`${sel}  →  no encuentro "${n}"`);
  }
}
assert.deepStrictEqual(missing, [], 'anclas rotas:\n  ' + missing.join('\n  '));

// Los pasos de tarjeta (card: true) no necesitan ancla, pero un paso NORMAL sin
// ancla se vería siempre como tarjeta: casi siempre es un descuido, no un diseño.
const steps = [...guide.matchAll(/\{\s*title:[\s\S]*?\n\s*(?=\{\s*title:|\]\s*\})/g)].map((m) => m[0]);
assert.ok(steps.length >= 25, `solo ${steps.length} pasos troceados — el regex de pasos dejo de funcionar`);
const sinAncla = steps.filter((s) => !/\b(?:anchor|card):/.test(s));
assert.deepStrictEqual(sinAncla, [], `hay pasos sin anchor ni card: ${sinAncla.length}`);

console.log(`guide-anchors: ${new Set(sels).size} selectores, todos presentes — OK`);

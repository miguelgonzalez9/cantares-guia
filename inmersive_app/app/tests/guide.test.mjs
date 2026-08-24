// Invariantes del contenido de la guía (js/guide.js). El motor es DOM y se prueba
// a mano en el teléfono; lo que sí rompe solo es el CONTENIDO — añadir un tema y
// olvidar `tab`, o un paso de acción sin `run`. Eso se ve aquí.
// Correr: node tests/guide.test.mjs
import assert from 'node:assert';
import { _TOPICS } from '../public/js/guide.js';

const { visitor, admin } = _TOPICS;

// --- visitante: bilingüe y alineado ---
assert.ok(visitor.es.length >= 6, 'el tour del visitante se quedó corto');
assert.strictEqual(visitor.es.length, visitor.en.length, 'ES y EN tienen distinto número de pasos');
visitor.es.forEach((s, i) => {
  assert.ok(s.title && s.body, `paso ES ${i} sin título o cuerpo`);
  assert.ok(visitor.en[i].title && visitor.en[i].body, `paso EN ${i} sin título o cuerpo`);
  // Mismo esqueleto en los dos idiomas: si uno señala un botón, el otro también.
  assert.strictEqual(s.anchor, visitor.en[i].anchor, `paso ${i}: ancla distinta entre ES y EN`);
  assert.strictEqual(!!s.action, !!visitor.en[i].action, `paso ${i}: acción solo en un idioma`);
});
// El paso del GPS es el único con acción, y su botón tiene que hacer algo.
const conAccion = visitor.es.filter((s) => s.action);
assert.strictEqual(conAccion.length, 1, 'se esperaba exactamente un paso con acción (la ubicación)');
assert.strictEqual(typeof conAccion[0].action.run, 'function');
assert.ok(conAccion[0].action.label, 'la acción no tiene etiqueta');

// --- admin: dos bloques, y cada tema sabe dónde dejar la app ---
const start = admin.filter((t) => t.block === 'start');
const later = admin.filter((t) => t.block === 'later');
assert.strictEqual(start.length, 3, 'el bloque «Empieza aquí» son 3 temas');
assert.ok(later.length >= 3, 'faltan temas de consulta');
assert.strictEqual(start.length + later.length, admin.length, 'hay temas sin bloque válido');

const ids = admin.map((t) => t.id);
assert.strictEqual(new Set(ids).size, ids.length, 'ids de tema repetidos');

for (const t of admin) {
  assert.ok(t.emoji && t.title, `tema ${t.id} sin emoji o título`);
  assert.ok(['sheet', 'full', 'closed'].includes(t.panel), `tema ${t.id}: panel inválido (${t.panel})`);
  // Un tema que abre el panel TIENE que decir en qué pestaña: sin `tab` se abre
  // en la última que quedó abierta y sus anclas apuntan a otra pantalla.
  if (t.panel !== 'closed') assert.ok(t.tab, `tema ${t.id} abre el panel sin decir la pestaña`);
  assert.ok(t.steps.length >= 2, `tema ${t.id} con menos de 2 pasos`);
  t.steps.forEach((s, i) => {
    assert.ok(s.title && s.body, `tema ${t.id}, paso ${i}: sin título o cuerpo`);
    assert.ok(s.anchor || s.card, `tema ${t.id}, paso ${i}: ni ancla ni tarjeta`);
    if (s.go) assert.strictEqual(typeof s.go, 'function', `tema ${t.id}, paso ${i}: go no es función`);
  });
}

// El tema del circuito de Dropbox es de referencia pura: si alguien le pone un
// ancla, es que la guía empezó a mentir sobre algo que no está en pantalla.
const circuito = admin.find((t) => t.id === 'circuito');
assert.ok(circuito.steps.every((s) => s.card), 'el tema del circuito debe ser solo tarjetas');

console.log(`guide: ${visitor.es.length} pasos de visitante (ES/EN) · ${admin.length} temas de admin (${start.length} + ${later.length}) — OK`);

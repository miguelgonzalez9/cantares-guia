// Invariantes del contenido de la guía (js/guide.js). El motor es DOM y se prueba
// a mano en el teléfono; lo que sí rompe solo es el CONTENIDO — añadir un tema y
// olvidar `tab`, una rama sin pasos, o el tour del invitado prometiendo cosas que
// solo existen estando en la reserva. Eso se ve aquí.
// Correr: node tests/guide.test.mjs
import assert from 'node:assert';
import { _TOPICS } from '../public/js/guide.js';

const { visitor, guest, admin } = _TOPICS;
const stepsOf = (list) => list.flatMap((s) => [s, ...(s.branches || []).flatMap((b) => b.steps)]);

// --- los dos tours del visitante: bilingües y alineados ---
for (const [name, tour] of [['visitante', visitor], ['invitado', guest]]) {
  assert.ok(tour.es.length >= 6, `el tour ${name} se quedó corto`);
  assert.strictEqual(tour.es.length, tour.en.length, `${name}: ES y EN tienen distinto número de pasos`);
  tour.es.forEach((s, i) => {
    assert.ok(s.title && s.body, `${name} ES paso ${i} sin título o cuerpo`);
    assert.ok(tour.en[i].title && tour.en[i].body, `${name} EN paso ${i} sin título o cuerpo`);
    // Mismo esqueleto en los dos idiomas: si uno señala un botón, el otro también.
    assert.strictEqual(s.anchor, tour.en[i].anchor, `${name} paso ${i}: ancla distinta entre ES y EN`);
    assert.strictEqual(!!s.action, !!tour.en[i].action, `${name} paso ${i}: acción solo en un idioma`);
    assert.strictEqual((s.branches || []).length, (tour.en[i].branches || []).length, `${name} paso ${i}: ramas distintas entre idiomas`);
  });
}

// El paso del GPS es el único con acción, y solo en el tour de quien está allí:
// desde casa, pedir la ubicación no sirve para nada.
const conAccion = visitor.es.filter((s) => s.action);
assert.strictEqual(conAccion.length, 1, 'se esperaba exactamente un paso con acción (la ubicación)');
assert.strictEqual(typeof conAccion[0].action.run, 'function');
assert.ok(conAccion[0].action.label, 'la acción no tiene etiqueta');
assert.strictEqual(guest.es.filter((s) => s.action).length, 0, 'el invitado no debe activar el GPS');

// El invitado es más corto y NO enseña a caminar un recorrido.
assert.ok(guest.es.length < visitor.es.length, 'el tour del invitado debe ser más corto');
const guestAnchors = stepsOf(guest.es).map((s) => s.anchor);
assert.ok(!guestAnchors.includes('#ri-start'), 'el invitado no debe enseñar a empezar un recorrido');
assert.ok(!guestAnchors.includes('#locate-btn'), 'el invitado no debe enseñar el GPS');
// Pero sí lo que puede hacer desde casa: el bosque, las especies y cómo reservar.
for (const a of ['#bc-handle', '#legend', '.cm-links']) {
  assert.ok(guestAnchors.includes(a), `al invitado le falta ${a}`);
}

// --- ramas: existen, tienen etiqueta y pasos ---
const conRama = stepsOf(visitor.es).filter((s) => s.branches);
assert.ok(conRama.length >= 2, 'el tour completo debe bifurcar en recorridos y en especies');
for (const list of [visitor.es, visitor.en, guest.es, guest.en, ...admin.map((t) => t.steps)]) {
  for (const s of list) {
    for (const b of s.branches || []) {
      assert.ok(b.label, `rama sin etiqueta en «${s.title}»`);
      assert.ok(Array.isArray(b.steps) && b.steps.length >= 2, `rama «${b.label}» con menos de 2 pasos`);
      b.steps.forEach((x, i) => assert.ok(x.title && x.body && (x.anchor || x.card), `rama «${b.label}», paso ${i} incompleto`));
    }
  }
}

// --- admin: dos bloques, y cada tema sabe dónde dejar la app ---
const start = admin.filter((t) => t.block === 'start');
const later = admin.filter((t) => t.block === 'later');
assert.deepStrictEqual(start.map((t) => t.id), ['puntos', 'senderos', 'recorridos'],
  'el bloque «Empieza aquí» es puntos, senderos y recorridos, en ese orden');
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
  for (const s of stepsOf(t.steps)) {
    assert.ok(s.title && s.body, `tema ${t.id}: paso «${s.title}» sin título o cuerpo`);
    assert.ok(s.anchor || s.card, `tema ${t.id}: paso «${s.title}» ni ancla ni tarjeta`);
    if (s.go) assert.strictEqual(typeof s.go, 'function', `tema ${t.id}: go no es función en «${s.title}»`);
    if (s.panel) assert.ok(['sheet', 'full', 'closed'].includes(s.panel), `tema ${t.id}: panel de paso inválido`);
  }
}

// El paso que señala la llave inglesa vive FUERA del panel: si el panel estuviera
// abierto la taparía (a pantalla completa en el teléfono). Este fue un bug real.
const fab = admin.find((t) => t.id === 'puntos').steps.find((s) => s.anchor === '#admin-fab');
assert.strictEqual(fab.panel, 'closed', 'el paso del botón 🛠️ debe pedir el panel cerrado');

// Los tres temas de arranque enseñan a CREAR, cada uno con su rama.
for (const id of ['puntos', 'senderos', 'recorridos']) {
  const t = admin.find((x) => x.id === id);
  assert.ok(t.steps.some((s) => (s.branches || []).length), `el tema ${id} debe bifurcar a un sub-tutorial`);
}

// El tema del circuito de Dropbox es de referencia pura: si alguien le pone un
// ancla, es que la guía empezó a mentir sobre algo que no está en pantalla.
const circuito = admin.find((t) => t.id === 'circuito');
assert.ok(circuito.steps.every((s) => s.card), 'el tema del circuito debe ser solo tarjetas');

console.log(`guide: visitante ${visitor.es.length} pasos · invitado ${guest.es.length} · admin ${admin.length} temas (${start.length}+${later.length}) · ${conRama.length} bifurcaciones — OK`);

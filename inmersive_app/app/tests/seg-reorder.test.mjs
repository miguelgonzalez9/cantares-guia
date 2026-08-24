// Prueba de la lista de senderos de un recorrido (admin.js): reordenar
// arrastrando (⠿) y duplicar (⧉). Se replica la lógica, no el DOM real:
// wireSegDrag mueve el <li> y devuelve el orden como índices del array
// original; aquí se simula ese movimiento. Correr: node tests/seg-reorder.test.mjs
import assert from 'node:assert';

// --- simula el insertBefore que hace wireSegDrag: mover el nodo `from` a `to` ---
const domMove = (nodes, from, to) => { const n = nodes.slice(); const [x] = n.splice(from, 1); n.splice(to, 0, x); return n; };
// --- lo que hace el onDrop: nuevo array = orden del DOM leído sobre el viejo ---
const applyDrop = (segs, order) => order.map((i) => segs[i]);
// --- ⧉ duplicar: el mismo sendero otra vez, justo detrás ---
const dup = (segs, i) => { const s = segs.slice(); s.splice(i + 1, 0, s[i]); return s; };

const segs = ['a', 'b', 'c', 'd'];
const nodes = segs.map((_, i) => i);          // data-i de cada <li> al renderizar

// arrastrar el último al principio
assert.deepStrictEqual(applyDrop(segs, domMove(nodes, 3, 0)), ['d', 'a', 'b', 'c']);
// arrastrar el primero al medio
assert.deepStrictEqual(applyDrop(segs, domMove(nodes, 0, 2)), ['b', 'c', 'a', 'd']);
// soltar donde estaba = sin cambios
assert.deepStrictEqual(applyDrop(segs, nodes), segs);

// duplicar deja la copia PEGADA al original (la vuelta por el mismo tramo)
assert.deepStrictEqual(dup(segs, 1), ['a', 'b', 'b', 'c', 'd']);
assert.deepStrictEqual(dup(segs, 3), ['a', 'b', 'c', 'd', 'd']);
// y con duplicados, reordenar sigue siendo consistente
const d = dup(segs, 3);
assert.deepStrictEqual(applyDrop(d, domMove(d.map((_, i) => i), 4, 0)), ['d', 'a', 'b', 'c', 'd']);

console.log('OK — seg-reorder (arrastrar + duplicar)');

// El wakelock lo piden dos dueños a la vez (modo guiado + grabador de
// caminatas). La regla es una sola: la pantalla se suelta cuando se va el
// ÚLTIMO, no el primero. Antes se soltaba con el primero y el GPS moría a
// mitad de recorrido, en silencio.
// Correr:  node app/tests/wakelock.test.js
import assert from 'node:assert';

// Stubs mínimos del navegador ANTES de importar el módulo (registra un listener
// de visibilitychange al cargarse).
let live = 0, requests = 0;
globalThis.document = { addEventListener() {}, hidden: false };
// En Node 24 `navigator` existe y es de solo lectura: se le injerta la API que
// falta en vez de reemplazar el objeto entero.
Object.defineProperty(globalThis.navigator, 'wakeLock', {
  configurable: true,
  value: {
    async request() {
      requests++; live++;
      return { release() { live--; }, addEventListener() {} };
    },
  },
});

const { keepAwake, releaseAwake, releaseAwakeAll } = await import('../public/js/wakelock.js');

// 1. Un solo dueño: pide y suelta.
assert.strictEqual(await keepAwake(), true);
assert.strictEqual(live, 1, 'la pantalla queda encendida');
releaseAwake();
assert.strictEqual(live, 0, 'con un dueño, soltar apaga');

// 2. Dos dueños (guía + grabador): el primero en soltar NO apaga.
requests = 0;
await keepAwake();          // startGuiding
await keepAwake();          // startWalk
assert.strictEqual(requests, 1, 'no se piden dos locks: uno basta');
releaseAwake();             // stopWalk — el visitante sigue caminando el recorrido
assert.strictEqual(live, 1, 'sigue encendida: el modo guiado no ha terminado');
releaseAwake();             // stopGuiding
assert.strictEqual(live, 0, 'ahora sí se apaga');

// 3. Soltar de más no deja el contador en negativo (un release huérfano no
//    puede robarle la pantalla al siguiente dueño).
releaseAwake(); releaseAwake();
await keepAwake();
assert.strictEqual(live, 1, 'un keepAwake tras releases huérfanos sí enciende');
releaseAwake();
assert.strictEqual(live, 0);

// 4. releaseAwakeAll corta pase lo que pase.
await keepAwake(); await keepAwake(); await keepAwake();
releaseAwakeAll();
assert.strictEqual(live, 0, 'releaseAwakeAll suelta con varios dueños');

console.log('wakelock: 4 casos OK');

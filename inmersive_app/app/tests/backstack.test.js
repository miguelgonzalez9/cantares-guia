// Prueba del botón «atrás» (app.js): simula el historial del navegador y
// comprueba que atrás deshace UNA capa por pulsación y sólo sale de la app
// cuando no queda nada abierto. Correr con: node js/test_backstack.js
import assert from 'node:assert';

// --- historial simulado (pushState / back / popstate) ---
function makeHistory() {
  const h = { entries: [{ state: null }], i: 0, exited: false, onpop: null };
  h.pushState = (st) => { h.entries.length = h.i + 1; h.entries.push({ state: st }); h.i++; };
  h.back = () => {
    if (h.i === 0) { h.exited = true; return; }      // atrás en la entrada base = salir de la app
    h.i--; if (h.onpop) h.onpop();
  };
  return h;
}

// --- copia literal de la lógica de app.js (backStack / armBack / popstate) ---
function makeNav(history) {
  const backStack = [];
  let _sentinel = false, _undoing = false;
  const armBack = () => { if (_sentinel) return; history.pushState({ cantares: 1 }); _sentinel = true; };
  const pushBack = (name, undo) => {
    if (_undoing) return;
    const i = backStack.findIndex((b) => b.name === name);
    if (i >= 0) backStack.splice(i, 1);
    backStack.push({ name, undo });
    armBack();
  };
  const popBack = (name) => {
    const i = backStack.findIndex((b) => b.name === name);
    if (i >= 0) backStack.splice(i, 1);
  };
  history.onpop = () => {
    _sentinel = false;
    const it = backStack.pop();
    if (!it) return;
    _undoing = true;
    try { it.undo(); } finally { _undoing = false; }
    if (backStack.length) armBack();
  };
  return { backStack, pushBack, popBack, open: () => backStack.map((b) => b.name) };
}

// 1. Mapa, nada abierto: atrás sale de la app.
{
  const h = makeHistory(); makeNav(h);
  h.back();
  assert.strictEqual(h.exited, true, 'sin capas, atrás debe salir de la app');
}

// 2. Pestaña + ficha: dos atrás deshacen ambas, el tercero sale.
{
  const h = makeHistory(); const nav = makeNav(h);
  let view = 'recorridos', card = false;
  nav.pushBack('view', () => { view = 'recorridos'; }); view = 'especies';
  card = true; nav.pushBack('card', () => { card = false; });
  assert.deepStrictEqual(nav.open(), ['view', 'card']);

  h.back();
  assert.strictEqual(card, false, 'el 1er atrás cierra la ficha');
  assert.strictEqual(view, 'especies', 'y NO cambia de pestaña todavía');
  assert.strictEqual(h.exited, false);

  h.back();
  assert.strictEqual(view, 'recorridos', 'el 2º atrás vuelve a la pestaña anterior');
  assert.strictEqual(h.exited, false, 'todavía no debe salir');

  h.back();
  assert.strictEqual(h.exited, true, 'el 3er atrás ya sale de la app');
}

// 3. Cerrar con el botón ×: atrás nunca deja al usuario atrapado. El centinela
// sobrante se gasta sin efecto y el siguiente atrás sale (compromiso conocido:
// consumirlo al vuelo es asíncrono y pisaba el cambio de pestaña — ver popBack).
{
  const h = makeHistory(); const nav = makeNav(h);
  let card = true;
  nav.pushBack('card', () => { card = false; });
  nav.popBack('card'); card = false;              // el usuario tocó ×
  assert.deepStrictEqual(nav.open(), []);
  h.back();
  assert.strictEqual(h.exited, false, 'el centinela sobrante se gasta sin efecto');
  h.back();
  assert.strictEqual(h.exited, true, 'y el siguiente atrás sí sale');
}

// 3b. Cambiar de pestaña con una ficha abierta NO debe rebotar (la carrera que
// tenía el history.back() asíncrono dentro de popBack).
{
  const h = makeHistory(); const nav = makeNav(h);
  let view = 'especies', card = true;
  nav.pushBack('view', () => { view = 'recorridos'; });
  nav.pushBack('card', () => { card = false; });
  // switchView('info'): cierra la ficha (popBack) y apila la pestaña.
  nav.popBack('card'); card = false;
  nav.pushBack('view', () => { view = 'especies'; }); view = 'info';
  assert.strictEqual(view, 'info', 'la pestaña debe quedarse en info');
  assert.deepStrictEqual(nav.open(), ['view']);
  h.back();
  assert.strictEqual(view, 'especies', 'atrás vuelve a la pestaña anterior');
}

// 4. Reabrir la misma capa no la duplica en la pila.
{
  const h = makeHistory(); const nav = makeNav(h);
  nav.pushBack('card', () => {});
  nav.pushBack('card', () => {});
  assert.deepStrictEqual(nav.open(), ['card']);
}

// 5. Capa sobre capa (ficha → visor de foto): atrás cierra sólo la de encima.
{
  const h = makeHistory(); const nav = makeNav(h);
  let card = true, lightbox = true;
  nav.pushBack('card', () => { card = false; });
  nav.pushBack('lightbox', () => { lightbox = false; });
  h.back();
  assert.strictEqual(lightbox, false, 'atrás cierra el visor…');
  assert.strictEqual(card, true, '…y deja la ficha abierta');
}

console.log('backstack: 6/6 OK');

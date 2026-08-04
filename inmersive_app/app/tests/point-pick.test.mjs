// Modo «tocar puntos en el mapa» del editor de recorridos (issue #8).
// El mapa no arranca headless, así que aquí se prueba lo que sí es comprobable:
// que el resaltado ya no falle en silencio, que el modo se aísle y que entrar y
// salir sea simétrico. El aspecto y el hover se prueban con el dedo.
//
// Correr:  node inmersive_app/app/tests/point-pick.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const admin = readFileSync(join(PUB, 'js', 'admin.js'), 'utf8');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');
const css = readFileSync(join(PUB, 'css', 'style.css'), 'utf8');

const fn = (src, name) => {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} no encontrado`);
  return src.slice(i, i + 2000);
};

// 1. EL BUG: setPtHl ya no puede terminar sin pintar y sin avisar.
//    isStyleLoaded() devuelve false mientras hay cambios de estilo pendientes, y
//    applyWaypointFilter toca setPaintProperty a cada rato: caer en esa ventana
//    significaba que tocar un punto no hacía nada visible.
{
  const body = fn(admin, 'setPtHl');
  assert.ok(/once\('idle'/.test(body), 'setPtHl debe reintentar cuando el mapa quede quieto');
  assert.ok(/_ptHlWant/.test(body), 'debe recordar qué pintar para poder reintentarlo');
}

// 2. El halo debe quedar por ENCIMA de las capas admin que se añaden después.
assert.ok(/moveLayer\('admin-pt-hl-c'\)/.test(fn(admin, 'ensurePtHl')),
  'el halo amarillo debe subirse al tope');

// 3. Aislamiento: entrar marca el modo, salir lo quita. Sin simetría, el admin
//    se queda sin FAB y sin manera de volver a entrar.
{
  const start = fn(admin, 'startPointPick');
  const end = fn(admin, 'endPointPick');
  assert.ok(/classList\.add\('picking-points'\)/.test(start));
  assert.ok(/classList\.remove\('picking-points'\)/.test(end));
  assert.ok(/pickDim\(true\)/.test(start) && /pickDim\(false\)/.test(end));
  assert.ok(/hideEditBar\(\)/.test(start), 'la barra de edición no debe seguir accesible');
  assert.ok(/clearPtHl\(\)/.test(end) && /clearHighlight\(\)/.test(end),
    'al salir se limpian tanto el halo como la traza');
}

// 4. La traza del recorrido que se edita se dibuja al entrar.
assert.ok(/highlightSegments\(_routeDraft\.segments/.test(fn(admin, 'startPointPick')),
  'debe mostrarse la traza del recorrido en edición');

// 5. Al salir, la opacidad la repone quien manda sobre ella, no un número fijo:
//    depende del recorrido activo, así que un valor a mano dejaría el mapa
//    mintiendo hasta el siguiente render.
{
  const body = fn(admin, 'pickDim');
  assert.ok(/CTX\.applyWaypointFilter/.test(body), 'restaurar debe delegar en applyWaypointFilter');
  assert.ok(!/'circle-opacity', 1\)/.test(body), 'no debe reponer una opacidad fija');
  assert.ok(/applyWaypointFilter,/.test(app), 'app.js debe pasarla en el contexto de admin');
}

// 6. El HUD dice QUÉ punto se tocó, no sólo cuántos van — en táctil no hay hover
//    y es la única forma de saber qué es un punto antes de decidir.
assert.ok(/wpTitle\(pid\)/.test(fn(admin, 'startPointPick')),
  'el HUD debe nombrar el punto');

// 7. El CSS del modo oculta el cromo de edición pero no rompe el HUD.
const hide = /body\.picking-points #admin-fab,[\s\S]*?display: none !important; \}/.exec(css);
assert.ok(hide, 'falta la regla de aislamiento');
for (const id of ['#admin-fab', '#edit-bar', '#legend', '#base-compare', '#search-btn']) {
  assert.ok(hide[0].includes(id), `${id} debe ocultarse en modo selección`);
}
assert.ok(!hide[0].includes('#admin-ptsel-hud'), 'el HUD del modo NO puede ocultarse');

console.log('point-pick: 7/7 OK');

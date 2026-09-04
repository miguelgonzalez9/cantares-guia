// Tiempo de recorrido: modelo recalibrado, dos números, y la precedencia
// medido > modelo.
//
// El Recorrido del Agua mide 1.518 m con 12 paradas con guión y la app decía
// ~30 min — que es lo que tarda SÓLO la bajada a la cascada. El modelo anterior
// era Naismith de camino llano (4 km/h, 600 m/h de subida), sin penalización de
// bajada y sin contar que un recorrido con audioguía se hace parándose.
//
// Se ejecutan las funciones REALES extraídas de app.js, no una réplica.
//
// Correr:  node inmersive_app/app/tests/walk-time.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');

const a = app.indexOf('const WALK_KMH');
const b = app.indexOf('// Paradas de la audioguia');
assert.ok(a >= 0 && b > a, 'no encuentro el bloque del modelo de tiempo');
const src = app.slice(a, b);

const build = new Function('state', `${src}\nreturn { walkMinutes, walkText, routeDuration, fmtMin };`);
const state = { routeStats: {} };
const { walkMinutes, walkText, routeDuration } = build(state);

// --- el caso real que abrió el asunto: Recorrido del Agua ---
const AGUA_M = 1518, AGUA_GAIN = 130, AGUA_LOSS = 130, AGUA_STOPS = 12;

const caminando = walkMinutes(AGUA_M, AGUA_GAIN, AGUA_LOSS, 0);
const guiado = walkMinutes(AGUA_M, AGUA_GAIN, AGUA_LOSS, AGUA_STOPS);

// El ancla de cordura la dio el dueño: sólo la bajada a la cascada son 30 min.
// El recorrido ENTERO no puede salir por debajo de eso.
assert.ok(caminando > 30, `caminarlo entero (${caminando} min) tiene que superar los 30 min de la sola bajada`);
// El viejo modelo (4 km/h, 600 m/h, sin bajada ni paradas) daba ~36 min para lo
// mismo. La corrección tiene que ser grande, no cosmética.
const viejo = Math.round((AGUA_M / 4000 + AGUA_GAIN / 600) * 60);
assert.ok(caminando > viejo * 1.7, `caminando (${caminando}) corrige de verdad al viejo (${viejo})`);
assert.ok(guiado > viejo * 2.5, `con audioguía (${guiado}) frente al viejo (${viejo})`);

// Las 12 paradas de la audioguía pesan, y son la otra mitad del error.
assert.strictEqual(guiado - caminando, AGUA_STOPS * 3, 'cada parada con guión suma su tiempo');
assert.ok(guiado > 90, `con audioguía (${guiado} min) tiene que dar más de hora y media`);

// --- la bajada cuenta: dos recorridos iguales salvo el desnivel de bajada ---
assert.ok(walkMinutes(1000, 0, 300, 0) > walkMinutes(1000, 0, 0, 0),
  'bajar 300 m cuesta tiempo (Langmuir), no es gratis como antes');
assert.ok(walkMinutes(1000, 300, 0, 0) > walkMinutes(1000, 0, 300, 0),
  'pero subir sigue costando más que bajar');

// --- dos números cuando hay paradas, uno cuando no ---
const conParadas = walkText(AGUA_M, AGUA_GAIN, AGUA_LOSS, AGUA_STOPS);
assert.ok(conParadas.includes('🚶') && conParadas.includes('🎧'),
  'con paradas se enseñan los dos: caminando y con audioguía');
const sinParadas = walkText(AGUA_M, AGUA_GAIN, AGUA_LOSS, 0);
assert.ok(!sinParadas.includes('🎧'), 'sin guiones no se inventa un segundo número');
assert.strictEqual(walkText(0, 0, 0, 0), '⏱️ —', 'sin trazado no se muestra un tiempo falso');

// --- precedencia: manual > medido > modelo ---
const ruta = { id: 'agua' };
assert.strictEqual(routeDuration(ruta, AGUA_M, AGUA_GAIN, AGUA_LOSS, AGUA_STOPS).src, 'modelo',
  'sin dato medido, el modelo');

state.routeStats.agua = { route_id: 'agua', n_walks: 2, median_min: 95 };
assert.strictEqual(routeDuration(ruta, AGUA_M, AGUA_GAIN, AGUA_LOSS, AGUA_STOPS).src, 'modelo',
  'con 2 caminatas la mediana es anécdota: se sigue con el modelo');

state.routeStats.agua = { route_id: 'agua', n_walks: 7, median_min: 95 };
const medido = routeDuration(ruta, AGUA_M, AGUA_GAIN, AGUA_LOSS, AGUA_STOPS);
assert.strictEqual(medido.src, 'medido', 'con 3 o más, gana lo que midieron los visitantes');
assert.ok(medido.text.includes('1 h 35'), `la mediana se muestra tal cual: ${medido.text}`);

const manual = routeDuration({ id: 'agua', duration_min: 110 }, AGUA_M, AGUA_GAIN, AGUA_LOSS, AGUA_STOPS);
assert.strictEqual(manual.src, 'manual', 'lo que midió el dueño gana sobre todo');
assert.ok(manual.text.includes('1 h 50'), `${manual.text}`);

// Un 0 o un negativo no es "medido": es el campo vacío mal guardado.
assert.strictEqual(routeDuration({ id: 'x', duration_min: 0 }, 1000, 0, 0, 0).src, 'modelo');

console.log(`OK — walk-time (Agua: 🚶 ${caminando} min · 🎧 ${guiado} min; antes decía ${viejo} min)`);

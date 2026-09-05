// Los tres fallos de la audioguía encontrados caminando el recorrido de Agua
// (issue #40). Se ejecutan las funciones REALES extraídas de app.js, no copias.
// Correr:  node inmersive_app/app/tests/audioguide.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const grab = (re, what) => {
  const m = re.exec(app);
  assert.ok(m, `no se encontró ${what} en app.js`);
  return m[0];
};

// ---------- 1. el guión se trocea en frases, y no se corta a media palabra ----------
// El fallo: 141 caracteres y silencio a mitad de oración, porque el pause/resume
// de los 9 s mataba la locución. Cada trozo tiene que caber holgado bajo ese tope.
const srcChunk = grab(/const SPEAK_CHUNK = \d+;[\s\S]*?\nfunction chunkText\(text, max = SPEAK_CHUNK\) \{[\s\S]*?\n\}/, 'chunkText');
const { chunkText, SPEAK_CHUNK } = new Function(`${srcChunk}\nreturn { chunkText, SPEAK_CHUNK };`)();

// El guión real del primer punto de Agua, alargado como los de verdad.
const AGUA = 'En este primer punto observamos el nacimiento que provee de agua a la casa '
  + 'y a la cabaña. Incluso durante los periodos de verano más intenso, el caudal se ha '
  + 'mantenido gracias al bosque que lo rodea. La reforestación de esta ladera empezó en '
  + '1998 con especies nativas traídas del vivero. Hoy el agua que bebemos nace aquí.';
const trozos = chunkText(AGUA);
assert.ok(trozos.length >= 2, 'un guión largo tiene que trocearse');
for (const p of trozos) assert.ok(p.length <= SPEAK_CHUNK, `trozo de ${p.length} caracteres, tope ${SPEAK_CHUNK}`);
// Nada se pierde por el camino: éste es el bug: el texto se quedaba a medias.
const norm = (s) => s.replace(/\s+/g, ' ').trim();
assert.strictEqual(norm(trozos.join(' ')), norm(AGUA), 'el troceado perdió o duplicó texto');
// Y no parte palabras: cada trozo empieza y acaba en frontera de palabra.
for (const p of trozos) assert.ok(AGUA.includes(p), `trozo cortado a mitad de palabra: «${p}»`);
// Un texto corto no se toca (el aviso de prueba de la audioguía).
assert.deepStrictEqual(chunkText('Prueba de sonido.'), ['Prueba de sonido.']);
assert.deepStrictEqual(chunkText(''), []);
// Una frase sin puntuación más larga que el tope también se parte, por espacios.
const larga = 'palabra '.repeat(60).trim();
for (const p of chunkText(larga)) assert.ok(p.length <= SPEAK_CHUNK, 'frase sin puntos sin trocear');

// ---------- 2. la cerca crece con el error del GPS ----------
const srcRadius = grab(/const ARRIVE_ACC_MAX = \d+;[\s\S]*?\nfunction arriveRadius\(accuracy, base\) \{[\s\S]*?\n\}/, 'arriveRadius');
const { arriveRadius, ARRIVE_ACC_PAD, ARRIVE_ACC_MAX } = new Function('CONFIG',
  `${srcRadius}\nreturn { arriveRadius, ARRIVE_ACC_PAD, ARRIVE_ACC_MAX };`)({ proximityMeters: 15 });

assert.strictEqual(arriveRadius(null), 15, 'sin precisión reportada, el radio base');
assert.strictEqual(arriveRadius(0), 15, 'un fijo perfecto no ensancha nada');
// El caso de campo: de pie EN el punto, el teléfono dice ±30 m bajo dosel.
// Antes se descartaba el fijo (tope de 30) y no sonaba nunca; ahora la cerca lo cubre.
assert.ok(arriveRadius(30) >= 40, `con ±30 m la cerca se queda en ${arriveRadius(30)} m`);
assert.ok(ARRIVE_ACC_MAX > 30, 'el rechazo duro tiene que ser MAYOR que el error normal bajo dosel');
// Pero acotada: un fijo de ±500 m no puede disparar desde el otro lado de la reserva.
assert.strictEqual(arriveRadius(500), 15 + ARRIVE_ACC_PAD, 'la precisión tiene que ir acotada');
assert.ok(ARRIVE_ACC_PAD <= 50, 'la cerca no puede ensancharse sin límite');

// ---------- 3. sólo se arma el punto que toca ----------
const srcArmed = grab(/function armedStop\(\) \{[\s\S]*?\n\}/, 'armedStop');
const mkArmed = (state, path) => new Function('state', 'buildRoutePath', 'routePointsInOrder', 'waypointVisible',
  `${srcArmed}\nreturn armedStop;`)(state,
    () => ({ path }),
    () => state._pts,
    (w) => w.properties.visible !== false);

const wp = (id, extra = {}) => ({ properties: { id, ...extra }, geometry: { coordinates: [0, 0] } });
const PTS = [wp('p1'), wp('p2'), wp('p3')];
const PATH = [[0, 0], [1, 1]];

// EL BUG: yendo hacia el inicio se pasa por p3 y sonaba. Ahora no se arma nada.
let st = { guiding: 'agua', atTrailhead: false, navDone: {}, _pts: PTS };
assert.strictEqual(mkArmed(st, PATH)(), null, 'antes de llegar al inicio no puede sonar NADA');

// Ya en el inicio: se arma el primero, y sólo el primero.
st = { guiding: 'agua', atTrailhead: true, navDone: {}, _pts: PTS };
assert.strictEqual(mkArmed(st, PATH)().properties.id, 'p1');
// Visitado p1 → pasa a p2. Un punto de más adelante nunca se adelanta a su turno.
st.navDone.p1 = true;
assert.strictEqual(mkArmed(st, PATH)().properties.id, 'p2');
// La × de la tarjeta salta un punto al que no se llega: no hay atasco posible.
st.navDone.p2 = true; st.navDone.p3 = true;
assert.strictEqual(mkArmed(st, PATH)(), null, 'con todo visitado no queda nada armado');
// Un punto oculto (filtro de capas) se salta, no bloquea la cola.
st = { guiding: 'agua', atTrailhead: true, navDone: {}, _pts: [wp('p1', { visible: false }), wp('p2')] };
assert.strictEqual(mkArmed(st, PATH)().properties.id, 'p2');
// Sin recorrido en curso, nada.
assert.strictEqual(mkArmed({ guiding: null, navDone: {}, _pts: PTS }, PATH)(), null);
// Un recorrido SIN trazado no tiene inicio que alcanzar: se arma desde el primer fijo,
// o la audioguía se quedaría muda para siempre en ese recorrido.
st = { guiding: 'agua', atTrailhead: false, navDone: {}, _pts: PTS };
assert.strictEqual(mkArmed(st, [])().properties.id, 'p1');

// ---------- 4. no queda rastro del ping que cortaba la voz ----------
assert.ok(!/startResumePing\s*\(/.test(app.replace(/^\s*\/\/.*$/gm, '')),
  'el pause/resume periódico sigue vivo: es lo que cortaba el guión a los 9 s');

console.log('audioguide: OK');

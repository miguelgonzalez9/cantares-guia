// El guion de un punto es contenido del RECORRIDO GUIADO, no contenido publico.
// Antes: los recorridos estaban bloqueados, pero tocar un punto del recorrido
// pintaba un boton «🔊 Escuchar» que no comprobaba nada — el mismo contenido,
// regalado por otra puerta. Y el bloqueo era solo de CUENTA: quien se dio de
// alta en la reserva seguia oyendo la guia entera desde su casa.
//
// Esta prueba fija las dos cosas: que el guard vive en el UNICO embudo
// (`routeScript`) y que el predicado es cuenta Y dentro de la reserva.
//
// Correr:  node inmersive_app/app/tests/guide-gate.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Se normalizan los finales de linea: git los convierte a CRLF al hacer
// checkout en Windows, y entonces las regex de abajo que llevan `\n` pegado a un
// token dejan de casar — el test falla sin que nadie haya tocado el codigo.
const app = readFileSync(join(PUB, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

// --- forma: el guard esta DENTRO de routeScript, no en los botones ---
const rs = /function routeScript\(routeId, pointId\) \{([\s\S]*?)\n\}/.exec(app);
assert.ok(rs, 'routeScript debe existir');
assert.ok(/if \(!state\.guiding && !canGuide\(\)\) return null;/.test(rs[1]),
  'routeScript tiene que cerrar el guion a quien no puede guiar');

// Todo guion que llega a la pantalla pasa por routeScript: si aparece otra via
// (leer route.scripts a pelo fuera de routeScript), este conteo lo caza.
const codigo = app.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const directos = (codigo.match(/\.scripts\s*\[/g) || []).length;
assert.strictEqual(directos, 1, 'solo routeScript puede leer route.scripts directamente');

// --- forma: empezar el recorrido usa el MISMO predicado, no hasAccount ---
assert.ok(/if \(!canGuide\(\)\) \{ toast\(t\('guiding_on_site'\)\); return; \}/.test(app),
  'el boton de empezar recorrido usa canGuide');
assert.ok(!/hasAccount\(\) \? '' : ' locked'/.test(app),
  'el candado del boton ya no puede mirar solo la cuenta');

// --- forma: el geocerco se cachea con la ultima posicion, sin pedir fijo nuevo ---
assert.ok(/import \{ initAuthGate, doLogout, inReserve \} from '\.\/auth-ui\.js';/.test(app));
assert.ok(/refreshOutsideReserve\(\);\n\s*checkProximity\(\);/.test(app),
  'el geocerco se recalcula en onPosition');
assert.ok(!/getCurrentPosition\(onPosition, onGeoError, \{ enableHighAccuracy: true, timeout: 12000, maximumAge: 0 \}\)[\s\S]{0,200}refreshOutsideReserve/.test(app),
  'refreshOutsideReserve no puede pedir un fijo propio');

// --- logica: la tabla de verdad del permiso ---
// Copia literal del predicado de app.js (mismo motivo que en game-geofence:
// app.js toca `document` al importarse). La asercion de forma de arriba es la
// que caza que la copia se desincronice.
const canGuide = (cuenta, fuera) => cuenta && !fuera;
const verGuion = (guiando, cuenta, fuera) => guiando || canGuide(cuenta, fuera);

assert.ok(!verGuion(false, false, false), 'sin cuenta, dentro: NO');
assert.ok(!verGuion(false, false, true), 'sin cuenta, fuera: NO');
assert.ok(!verGuion(false, true, true), 'con cuenta pero FUERA: NO (esto es lo nuevo)');
assert.ok(verGuion(false, true, false), 'con cuenta y dentro: SI');
// Un recorrido ya empezado no se corta: salirse dos metros del buffer a mitad
// de camino no puede callar la audioguia de quien ya esta caminando.
assert.ok(verGuion(true, true, true), 'guiando, aunque el GPS lo saque un momento: SI');

// --- falla ABIERTO sin posicion: el flag arranca en false ---
assert.ok(/let _outsideReserve = false, _geoCheckedAt = null;/.test(app),
  'sin fijo no se bloquea a nadie: el gate de cuenta ya exige alta en la reserva');
assert.ok(/if \(!p\) return;/.test(/function refreshOutsideReserve\(\) \{([\s\S]*?)\n\}/.exec(app)[1]),
  'sin posicion, refreshOutsideReserve no cambia nada');

// --- el guion es {es,en}: elegir idioma antes de PINTARLO, no solo de leerlo ---
// La tarjeta de llegada hacia `escapeHtml(sc)` sobre el objeto y pintaba
// «[object Object]» en modo LEER -- el fallback al que degrada todo lo demas.
assert.ok(!/escapeHtml\(sc\)/.test(app), 'no se puede pintar el objeto guion tal cual');
assert.ok(/const scText = \(scriptLine\(sc\) \|\| \{\}\)\.text \|\| '';/.test(app),
  'la tarjeta elige idioma con el mismo helper que la voz');
const sl = /function scriptLine\(s\) \{([\s\S]*?)\n\}/.exec(app);
assert.ok(sl, 'scriptLine debe existir');
assert.ok(/function speakScript\(s\) \{\n  const l = scriptLine\(s\);/.test(app),
  'la voz y la tarjeta comparten la eleccion de idioma');

// logica: copia literal de scriptLine
const scriptLine = (s, LANG) => {
  if (!s) return null;
  const useEn = LANG === 'en' && !!s.en;
  const text = useEn ? s.en : (s.es || s.en);
  return text ? { text, lang: useEn ? 'en-US' : (s.es ? 'es-CO' : 'en-US') } : null;
};
assert.deepStrictEqual(scriptLine({ es: 'hola', en: 'hi' }, 'es'), { text: 'hola', lang: 'es-CO' });
assert.deepStrictEqual(scriptLine({ es: 'hola', en: 'hi' }, 'en'), { text: 'hi', lang: 'en-US' });
// Sin ingles NO se anuncia en-US sobre texto espanol: se leeria con fonetica inglesa.
assert.deepStrictEqual(scriptLine({ es: 'hola', en: '' }, 'en'), { text: 'hola', lang: 'es-CO' });
assert.strictEqual(scriptLine({ es: '', en: '' }, 'es'), null);
assert.strictEqual(scriptLine(null, 'es'), null);

console.log('guide-gate: 22/22 OK');

// Descripciones de terceros: idioma y ATRIBUCIÓN.
//
// Las 191 descripciones de aves traídas de Wikipedia (data_prep/36_) crean dos
// problemas que no existían antes:
//
//   1. Nacen SÓLO en inglés. `L()` caía únicamente inglés→español, así que en la
//      ficha en español —el idioma principal de la reserva— salía un HUECO donde
//      sí hay texto. Ahora cae en los dos sentidos, y se avisa de en qué idioma
//      está lo que se muestra: si no, una ficha española que de pronto sale en
//      inglés parece un fallo en vez de una ausencia.
//   2. Wikipedia es CC BY-SA, licencia que **exige** citar la fuente y
//      enlazarla. Publicar el texto sin crédito visible la incumple. Por eso el
//      crédito se comprueba aquí y no se deja a criterio de nadie.
//
// Se ejecutan las funciones REALES extraídas de app.js, no copias.
// Correr:  node inmersive_app/app/tests/desc-credit.test.mjs
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

// --- se sacan del fuente y se ejecutan de verdad ---
const srcL = grab(/const L = \(obj, field\) => \(LANG === 'en'[\s\S]*?\);/, 'L()');
const srcNote = grab(/function descLangNote\(s\) \{[\s\S]*?\n\}/, 'descLangNote');
const srcCredit = grab(/function descCredit\(s\) \{[\s\S]*?\n\}/, 'descCredit');

const make = (lang) => {
  const ctx = { LANG: lang, t: (k) => k, escapeHtml: (x) => String(x) };
  const fn = new Function('LANG', 't', 'escapeHtml', 'URL',
    `${srcL}\n${srcNote}\n${srcCredit}\nreturn { L, descLangNote, descCredit };`);
  return fn(ctx.LANG, ctx.t, ctx.escapeHtml, URL);
};
const ES = make('es');
const EN = make('en');

const soloEn = { description: '', description_en: 'Mostly black with white spots.' };
const soloEs = { description: 'Casi todo negro con motas blancas.', description_en: '' };
const ambos = { description: 'Español.', description_en: 'English.' };

// --- 1. L() cae en LOS DOS sentidos ---
// Éste es el bug: antes, en español, esto devolvía '' y media ficha salía vacía.
assert.strictEqual(ES.L(soloEn, 'description'), 'Mostly black with white spots.');
assert.strictEqual(EN.L(soloEs, 'description'), 'Casi todo negro con motas blancas.');
// Y cuando el propio idioma existe, gana él: la caída no puede pisar lo bueno.
assert.strictEqual(ES.L(ambos, 'description'), 'Español.');
assert.strictEqual(EN.L(ambos, 'description'), 'English.');
// Sin nada, sigue sin haber nada (la ficha decide entonces enseñar `notes`).
assert.ok(!ES.L({ description: '', description_en: '' }, 'description'));

// --- 2. se avisa de que el texto está en el otro idioma ---
assert.match(ES.descLangNote(soloEn), /desc_in_en/);
assert.match(EN.descLangNote(soloEs), /desc_in_es/);
// Cuando el texto SÍ está en el idioma de la pantalla, no se avisa de nada.
assert.strictEqual(ES.descLangNote(ambos), '');
assert.strictEqual(EN.descLangNote(ambos), '');
assert.strictEqual(ES.descLangNote(soloEs), '');
assert.strictEqual(ES.descLangNote({ description: '', description_en: '' }), '');

// --- 3. la atribución, que es lo que exige la licencia ---
const wiki = {
  description_en: 'x',
  description_url: 'https://en.wikipedia.org/wiki/Sharp-shinned_hawk',
  description_license: 'CC BY-SA 4.0',
};
const cred = ES.descCredit(wiki);
assert.match(cred, /en\.wikipedia\.org/, 'se nombra la fuente');
assert.match(cred, /href="https:\/\/en\.wikipedia\.org\/wiki\/Sharp-shinned_hawk"/, 'y se ENLAZA: CC BY-SA lo exige');
assert.match(cred, /CC BY-SA 4\.0/, 'y se dice bajo qué licencia');
assert.match(cred, /rel="noopener noreferrer"/, 'enlace externo, sin ceder la ventana');
// Un texto propio no lleva crédito de nadie.
assert.strictEqual(ES.descCredit({ description: 'x' }), '');
assert.strictEqual(ES.descCredit({ description_url: '' }), '');
// Una url rota no puede tumbar la ficha entera.
assert.strictEqual(ES.descCredit({ description_url: 'no-es-una-url' }), '');

// --- 4. la ficha llama a las dos, y sólo cuando hay descripción ---
assert.ok(/paraHtml\(L\(s, 'description'\), 'wp-desc'\) \+ descLangNote\(s\) \+ descCredit\(s\)/.test(app),
  'la ficha de especie tiene que pintar aviso y crédito junto al texto');

// --- 5. las tres cadenas nuevas, en los dos idiomas ---
for (const k of ['desc_source', 'desc_in_en', 'desc_in_es']) {
  assert.strictEqual((app.match(new RegExp(k + ':', 'g')) || []).length, 2, `${k} en ES y EN`);
}

// --- 6. la audioguía NO pasa por L() ---
// `scriptLine` elige su propio idioma y se niega a leer español con voz inglesa;
// si algún día se apoyara en L(), la caída de idioma rompería esa garantía.
const sl = grab(/function scriptLine\(s\) \{[\s\S]*?\n\}/, 'scriptLine');
assert.ok(!/\bL\(/.test(sl), 'scriptLine no puede depender de L(): la voz es otra decisión');

console.log('OK — desc-credit (cae a los dos idiomas, avisa cuál es, y cita la fuente como exige CC BY-SA)');

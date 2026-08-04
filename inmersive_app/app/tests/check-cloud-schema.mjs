// ¿Hay algún campo que la app ESCRIBE y que no existe como columna en Supabase?
//
// Es el fallo que este repo repite: como todo error de nube se atrapa y se
// encola, una migración olvidada NO se ve. La app dice que guardó, la cola se
// llena y el dato no persiste nunca. Ya pasó con `notes` (migración 18) y costó
// una especie creada en campo.
//
// Necesita RED (consulta el esquema vivo), así que no es un test: es una
// comprobación de despliegue. Correr antes de publicar y después de cada
// migración:   node inmersive_app/app/tests/check-cloud-schema.mjs
//
// Sale con código 1 si falta alguna columna, para poder encadenarlo.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const src = (f) => readFileSync(join(PUB, f), 'utf8');

const cloud = src('js/cloud.js');
const url = /url:\s*'([^']+)'/.exec(cloud)[1];
const key = /eyJ[A-Za-z0-9._-]+/.exec(cloud)[0];

// Tablas que la app escribe → de dónde salen las filas.
const TABLES = ['media', 'species', 'waypoints', 'routes', 'trails', 'walks', 'point_types', 'content'];
const SOURCES = ['js/game.js', 'js/admin.js', 'js/app.js', 'js/recorder.js', 'js/cloud.js'];

/** Campos escritos a `table`: literales pasados a saveRow('<table>', {…}) más las
 *  funciones que construyen la fila (mediaRow, cloudWaypointToFeature…). Se
 *  ignoran las líneas de comentario: en este repo van en español y `así:` se
 *  parece demasiado a un nombre de campo. */
// Constructores de fila: no todas las escrituras son un literal en el sitio de
// la llamada. `saveRow('media', mediaRow(m, {...}))` esconde la mitad de los
// campos dentro de la función, y son justo los que se olvidan al migrar.
const BUILDERS = { media: ['mediaRow'] };

function writtenFields(table) {
  const out = new Set();
  const strip = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const collect = (blob) => { for (const g of strip(blob).matchAll(/(\w+):/g)) out.add(g[1]); };
  for (const f of SOURCES) {
    let code;
    try { code = src(f); } catch { continue; }
    const re = new RegExp(`saveRow\\('${table}',\\s*\\{([\\s\\S]*?)\\}\\s*[,)]`, 'g');
    for (const m of code.matchAll(re)) collect(m[1]);
    for (const fn of BUILDERS[table] || []) {
      const b = new RegExp(`function ${fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
      for (const m of code.matchAll(b)) collect(m[1]);
    }
  }
  return out;
}

const IGNORE = new Set(['patch', 'client_id']);   // client_id existe pero no lo lista un select vacío

let bad = 0;
for (const table of TABLES) {
  const written = [...writtenFields(table)].filter((f) => !IGNORE.has(f));
  if (!written.length) continue;
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: { apikey: key } });
  const rows = await res.json();
  if (!Array.isArray(rows)) { console.log(`⚠ ${table}: ${JSON.stringify(rows).slice(0, 90)}`); bad++; continue; }
  if (!rows.length) { console.log(`… ${table}: vacía, no se puede leer el esquema por REST — revisa a mano`); continue; }
  const cols = new Set(Object.keys(rows[0]));
  const missing = written.filter((f) => !cols.has(f));
  if (missing.length) { console.log(`✗ ${table}: SIN COLUMNA → ${missing.join(', ')}`); bad++; }
  else console.log(`✓ ${table}: ${written.length} campos escritos, todos existen`);
}

if (bad) {
  console.log('\nFalta correr una migración. Hasta entonces esas escrituras se');
  console.log('encolan en el outbox y NO persisten — sin error visible.');
  process.exit(1);
}
console.log('\nEsquema al día.');

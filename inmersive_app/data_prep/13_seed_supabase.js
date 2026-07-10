// 13_seed_supabase.js — genera app/public/data/13_seed_supabase.sql con los
// datos actuales (species.json, waypoints.geojson, trails.geojson) como INSERTs
// idempotentes, para cargar el proyecto Supabase con lo que ya existe.
// Correr:  node data_prep/13_seed_supabase.js
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, '..', 'app', 'public', 'data');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));

const q = (v) => (v === null || v === undefined || v === '') ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
const arr = (a) => {
  const xs = (Array.isArray(a) ? a : String(a || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  return xs.length ? `array[${xs.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')}]::text[]` : `'{}'::text[]`;
};
const num = (n) => (n === null || n === undefined || Number.isNaN(+n)) ? 'null' : (+n);
const bool = (b) => (b === true || b === 'true') ? 'true' : 'false';

let out = ['-- Seed autogenerado por data_prep/13_seed_supabase.js — corre DESPUÉS de schema.sql', ''];

// ---- species ----
const species = rd('species.json').species || [];
out.push('-- species (' + species.length + ')');
species.forEach((s) => {
  out.push(`insert into public.species (id,common_name,common_name_en,scientific_name,family,"group",flagship,status,photo) values (` +
    `${q(s.id)},${q(s.common_name)},${q(s.common_name_en)},${q(s.scientific_name)},${q(s.family)},${q(s.group)},${bool(s.flagship)},${q(s.status)},${q(s.photo)}) ` +
    `on conflict (id) do nothing;`);
});
out.push('');

// ---- waypoints ----
const wp = rd('waypoints.geojson').features || [];
out.push('-- waypoints (' + wp.length + ')');
wp.forEach((f) => {
  const p = f.properties, c = f.geometry.coordinates;
  out.push(`insert into public.waypoints (id,title,title_en,description,description_en,tipo,routes,species_ids,lng,lat,photo) values (` +
    `${q(p.id)},${q(p.title)},${q(p.title_en)},${q(p.description)},${q(p.description_en)},${q(p.tipo)},${arr(p.routes)},${arr(p.species_ids)},${num(c[0])},${num(c[1])},${q(p.photo)}) ` +
    `on conflict (id) do nothing;`);
});
out.push('');

// ---- trails ----
const tr = rd('trails.geojson').features || [];
out.push('-- trails (' + tr.length + ')');
const seen = {};
tr.forEach((f, i) => {
  const p = f.properties;
  let id = p.id || `trail_${i}`;
  seen[id] = (seen[id] || 0) + 1;
  if (seen[id] > 1) id = `${id}_${seen[id]}`;              // ids únicos (hay duplicados/nulos)
  const geom = JSON.stringify(f.geometry.coordinates).replace(/'/g, "''");
  out.push(`insert into public.trails (id,name,routes,geometry) values (` +
    `${q(id)},${q(p.name)},${arr(p.routes)},'${geom}'::jsonb) on conflict (id) do nothing;`);
});

// ---- routes ----
const routes = rd('routes.json').routes || [];
out.push('-- routes (' + routes.length + ')');
routes.forEach((r, i) => {
  out.push(`insert into public.routes (id,name,name_en,emoji,color,summary,summary_en,start_id,end_id,segments,sort) values (` +
    `${q(r.id)},${q(r.name)},${q(r.name_en)},${q(r.emoji)},${q(r.color)},${q(r.summary)},${q(r.summary_en)},${q(r.start_id)},${q(r.end_id)},'{}'::text[],${i}) ` +
    `on conflict (id) do nothing;`);
});
out.push('');

const dst = path.join(D, '13_seed_supabase.sql');
fs.writeFileSync(dst, out.join('\n') + '\n', 'utf8');
console.log('escrito', dst, '—', species.length, 'species,', wp.length, 'waypoints,', tr.length, 'trails,', routes.length, 'routes');

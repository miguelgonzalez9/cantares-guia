-- Cantares — migración 20: guiones de audioguía por punto en cada recorrido.
-- Un guión pertenece a la pareja (recorrido, punto): el mismo punto puede tener
-- distinto guión en distintos recorridos, o ninguno. Se guarda como JSONB en la
-- fila del recorrido, con forma { "<point_id>": { "es": "...", "en": "..." } }.
-- La app lo lee al llegar al punto (proximidad) durante un recorrido y lo lee en
-- voz alta con el TTS del navegador (offline). Correr una vez en el SQL Editor.

alter table public.routes
  add column if not exists scripts jsonb not null default '{}'::jsonb;

-- Lectura pública + escritura solo admin ya las cubre la política existente de
-- `routes` (misma tabla). No se necesitan grants nuevos.

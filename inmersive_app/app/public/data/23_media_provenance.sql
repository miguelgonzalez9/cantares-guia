-- Cantares — migración 23: procedencia y ubicación en `media`.
-- Pega TODO esto en el SQL Editor de Supabase y córrelo UNA vez.
--
-- POR QUÉ. Hoy el inventario de fotos sólo va en un sentido: el archivo local se
-- promueve a la app y nada vuelve. Tres cosas lo impiden, y todas son de esquema:
--
--   1. Una foto del juego se guarda en `sightings.photo`, una columna sin ninguna
--      relación con `media`. NUNCA se crea una fila de media, así que la foto de
--      un visitante no puede llegar al inventario — aunque la política RLS de
--      `17_media_table.sql` ya permite justo esa contribución.
--   2. `media` no tiene GPS, ni caminata, ni fecha de captura. «La foto que tomé
--      en este punto, durante este recorrido» no se puede ni representar.
--   3. Sin una identidad de contenido, sincronizar en los dos sentidos duplica:
--      la misma foto que sube por la app y ya existe en el archivo local se
--      convierte en dos filas. `content_hash` es lo que lo impide.
--
-- Idempotente: se puede pegar dos veces sin romper nada.

-- ---------------------------------------------------------------- columnas
alter table public.media
  -- Dónde y cuándo se tomó. Permite derivar el punto por cercanía (mismo criterio
  -- que el catálogo local: radio estricto) sin que el visitante elija nada.
  add column if not exists lat          double precision,
  add column if not exists lng          double precision,
  add column if not exists taken_at     timestamptz,

  -- La caminata en la que se tomó, si fue dentro de la app. Sin `on delete
  -- cascade` a propósito: borrar una caminata no debe borrar las fotos; sólo
  -- pierden el vínculo. El trabajo de campo no se descarta nunca.
  add column if not exists walk_id      text references public.walks(id) on delete set null,

  -- De dónde salió la fila. Es lo que hace auditable el inventario y lo que
  -- permite un rollback exacto desde los scripts locales.
  --   curated        → empacada en el repo por 10_process_photos.py
  --   local-archive  → promovida desde el archivo familiar (23_catalog_to_media)
  --   admin-upload   → subida por el admin desde la app
  --   visitor-upload → subida por un visitante con cuenta
  --   game-capture   → foto de un avistamiento del juego
  add column if not exists origin       text not null default 'admin-upload',

  -- Identidad del CONTENIDO (sha256 del archivo original), no de la fila. Es la
  -- clave con la que local y nube se reconocen: sin ella, sincronizar en los dos
  -- sentidos duplica cada foto en cada pasada.
  add column if not exists content_hash text,

  -- Lo que el clasificador propuso, separado de lo que un humano confirmó.
  -- `subject_id` es la verdad; `species_hint` es una sugerencia por revisar.
  -- Mezclarlos es cómo una conjetura del modelo termina publicada como dato.
  add column if not exists species_hint    text,
  add column if not exists hint_confidence real,
  add column if not exists reviewed        boolean not null default false;

-- Restringir `origin` a los valores conocidos. Sin esto, un typo en un script
-- crea una procedencia fantasma que el rollback nunca encuentra.
alter table public.media drop constraint if exists media_origin_chk;
alter table public.media add constraint media_origin_chk
  check (origin in ('curated', 'local-archive', 'admin-upload', 'visitor-upload', 'game-capture'));

-- ---------------------------------------------------------------- índices
-- La deduplicación consulta por hash en cada sincronización.
create index if not exists media_hash_idx   on public.media (content_hash);
create index if not exists media_origin_idx on public.media (origin);
-- La bandeja del admin filtra por «sin clasificar» y por quién contribuyó.
create index if not exists media_contrib_idx on public.media (contributor)
  where contributor is not null;
-- Ver las fotos de una caminata.
create index if not exists media_walk_idx on public.media (walk_id)
  where walk_id is not null;

-- ---------------------------------------------------------------- políticas
-- Hasta ahora `media_update` era sólo admin, así que un visitante podía SUBIR
-- una foto pero no clasificarla ni corregirla — su propia foto quedaba fuera de
-- su alcance. Se le da control sobre lo suyo MIENTRAS siga sin clasificar; una
-- vez el admin la clasifica y entra al inventario público, deja de ser editable
-- por el visitante (si no, podría reapuntar una foto ya publicada).
drop policy if exists media_update_own on public.media;
create policy media_update_own on public.media for update
  using  ( auth.uid() = contributor and status = 'unclassified' )
  with check ( auth.uid() = contributor and status = 'unclassified' );

-- Y borrar lo suyo mientras siga sin clasificar (arrepentirse de una subida).
drop policy if exists media_delete_own on public.media;
create policy media_delete_own on public.media for delete
  using ( auth.uid() = contributor and status = 'unclassified' );

-- ---------------------------------------------------------------- datos existentes
-- Las filas que ya estaban tenían `source` ('curated' | 'admin' | 'visitor').
-- Se traduce a `origin` una sola vez para no dejar todo el histórico marcado con
-- el valor por defecto, que sería una procedencia falsa.
update public.media
   set origin = case
         when source = 'curated' then 'curated'
         when source = 'visitor' then 'visitor-upload'
         else 'admin-upload'
       end
 where origin = 'admin-upload' and source is not null;

-- Comprobación (debería devolver las filas por procedencia):
--   select origin, status, count(*) from public.media group by 1, 2 order by 1;

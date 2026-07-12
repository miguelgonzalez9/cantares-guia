-- Cantares — migración: tabla de medios (fotos + videos) en tiempo de ejecución.
-- Es el espejo en la nube de app/public/data/media.json: unifica las fotos
-- curadas (build-time, versionadas) con las que suben el admin y los visitantes.
-- Habilita: galerías por punto/especie, elegir portada, videos, y la bandeja
-- de clasificación manual de fotos aún sin clasificar.
-- Pega TODO esto en el SQL Editor de Supabase y córrelo UNA vez.

create table if not exists public.media (
  id           text primary key,                 -- id local del teléfono (cola offline idempotente)
  kind         text not null default 'photo',    -- 'photo' | 'video'
  subject_type text,                              -- 'species' | 'waypoint' | null (sin clasificar)
  subject_id   text,                              -- id en species/waypoints; null si sin clasificar
  url          text not null,                     -- URL web (Supabase Storage, bucket 'media')
  thumb        text,                              -- miniatura opcional
  poster       text,                              -- fotograma de portada del video (opcional)
  is_primary   boolean not null default false,   -- portada de esa especie/punto (una por sujeto)
  sort         int not null default 0,            -- orden en la galería
  focal_x      real default 0.5,                  -- punto focal de recorte (0..1) → object-position
  focal_y      real default 0.5,
  layout       text,                              -- reservado: plantilla del compositor (sesión futura)
  caption      text, caption_en text,
  credit       text, license text,
  source       text default 'admin',              -- 'admin' | 'visitor' | 'curated'
  status       text not null default 'classified',-- 'classified' | 'unclassified'
  contributor  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

alter table public.media enable row level security;

-- Lectura pública (galerías se ven sin cuenta).
drop policy if exists media_read on public.media;
create policy media_read on public.media for select using (true);

-- Insertar: el admin todo; un visitante autenticado puede CONTRIBUIR una foto,
-- que entra como 'unclassified' hasta que el admin la clasifique.
drop policy if exists media_insert on public.media;
create policy media_insert on public.media for insert
  with check ( public.is_admin() or (auth.uid() = contributor and status = 'unclassified') );

-- Editar / borrar (clasificar, portada, orden, encuadre): sólo admin.
drop policy if exists media_update on public.media;
create policy media_update on public.media for update using ( public.is_admin() );
drop policy if exists media_delete on public.media;
create policy media_delete on public.media for delete using ( public.is_admin() );

grant select on public.media to anon;
grant select, insert, update, delete on public.media to authenticated;

-- Índices para las consultas de galería y de la bandeja de clasificación.
create index if not exists media_subject_idx on public.media (subject_type, subject_id);
create index if not exists media_status_idx  on public.media (status);

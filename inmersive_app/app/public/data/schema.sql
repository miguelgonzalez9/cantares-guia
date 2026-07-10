-- Cantares — esquema Supabase (Postgres). Pega TODO esto en el SQL Editor de
-- Supabase (una sola vez). Crea las tablas, la seguridad por filas (RLS), el
-- disparador que crea el perfil al registrarse, y el bucket de imágenes.
-- Después corre el seed (13_seed_supabase.sql) para cargar los datos actuales.
-- Ver docs/BACKEND_SUPABASE.md para el paso a paso.

-- ========================= TABLAS =========================
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  role       text not null default 'visitor' check (role in ('visitor','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.waypoints (
  id             text primary key,
  title          text,
  title_en       text,
  description    text,
  description_en text,
  tipo           text,
  routes         text[] default '{}',
  species_ids    text[] default '{}',
  lng            double precision,
  lat            double precision,
  photo          text,
  updated_at     timestamptz not null default now()
);

create table if not exists public.species (
  id             text primary key,
  common_name    text,
  common_name_en text,
  scientific_name text,
  family         text,
  "group"        text,
  flagship       boolean default false,
  status         text,
  photo          text,
  updated_at     timestamptz not null default now()
);

create table if not exists public.trails (
  id         text primary key,
  name       text,
  routes     text[] default '{}',
  geometry   jsonb,               -- LineString: [[lng,lat], ...]
  updated_at timestamptz not null default now()
);

-- Inventario global: cada avistamiento del juego. Se llena entre todos.
create table if not exists public.sightings (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete set null,
  species_id text,
  common     text,
  sci        text,
  "group"    text,
  lat        double precision,
  lng        double precision,
  taken_at   timestamptz,
  photo      text,
  points     int default 0,
  created_at timestamptz not null default now()
);

-- ================== FUNCIÓN: ¿es admin? ==================
-- SECURITY DEFINER evita recursión de RLS al consultar profiles.
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ========= DISPARADOR: crear perfil al registrarse =========
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, role)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'username',''), split_part(new.email,'@',1)),
          'visitor')
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ===================== RLS (seguridad) =====================
alter table public.profiles  enable row level security;
alter table public.waypoints enable row level security;
alter table public.species   enable row level security;
alter table public.trails    enable row level security;
alter table public.sightings enable row level security;

-- profiles: cada quien ve/edita el suyo; admin ve todos.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or public.is_admin() or auth.role() = 'authenticated');
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid() and role = 'visitor');  -- no auto-ascenso a admin

-- Contenido (waypoints/species/trails): lectura pública, escritura sólo admin.
do $$ declare t text; begin
  foreach t in array array['waypoints','species','trails'] loop
    execute format('drop policy if exists %I_read on public.%I;', t, t);
    execute format('create policy %I_read on public.%I for select using (true);', t, t);
    execute format('drop policy if exists %I_write on public.%I;', t, t);
    execute format('create policy %I_write on public.%I for all using (public.is_admin()) with check (public.is_admin());', t, t);
  end loop;
end $$;

-- sightings: lectura pública (inventario global); insertar sólo autenticado y
-- como uno mismo; editar/borrar el propio (o admin).
drop policy if exists sightings_read on public.sightings;
create policy sightings_read on public.sightings for select using (true);
drop policy if exists sightings_insert on public.sightings;
create policy sightings_insert on public.sightings for insert with check (auth.uid() = user_id);
drop policy if exists sightings_modify on public.sightings;
create policy sightings_modify on public.sightings for update using (auth.uid() = user_id or public.is_admin());
drop policy if exists sightings_delete on public.sightings;
create policy sightings_delete on public.sightings for delete using (auth.uid() = user_id or public.is_admin());

-- ============ PRIVILEGIOS del Data API ============
-- Necesarios porque en la creación del proyecto dejamos "Automatically expose new
-- tables" DESACTIVADO (recomendado). Estos GRANT hacen visibles las tablas al API;
-- la seguridad real la siguen dando las políticas RLS de arriba (filtran las filas).
grant usage on schema public to anon, authenticated;
grant select on public.waypoints, public.species, public.trails, public.sightings to anon, authenticated;
grant select on public.profiles to authenticated;
grant insert, update, delete on public.waypoints, public.species, public.trails, public.sightings to authenticated;
grant update on public.profiles to authenticated;

-- ===================== STORAGE (imágenes) =====================
insert into storage.buckets (id, name, public) values ('media','media', true)
  on conflict (id) do nothing;
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects for select using (bucket_id = 'media');
drop policy if exists media_upload on storage.objects;
create policy media_upload on storage.objects for insert
  with check (bucket_id = 'media' and auth.role() = 'authenticated');
drop policy if exists media_modify on storage.objects;
create policy media_modify on storage.objects for update using (bucket_id = 'media' and (owner = auth.uid() or public.is_admin()));
drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects for delete using (bucket_id = 'media' and (owner = auth.uid() or public.is_admin()));

-- ===================== HACERTE ADMIN =====================
-- 1) Regístrate en la app como visitante con TU usuario (p.ej. "miguel").
-- 2) Vuelve aquí y corre (cambia el usuario):
--        update public.profiles set role = 'admin' where username = 'miguel';
-- Repite para tus papás si quieres que también editen.

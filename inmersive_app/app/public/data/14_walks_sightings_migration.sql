-- Cantares — migración: caminatas en la nube + avistamientos idempotentes.
-- Pega TODO esto en el SQL Editor de Supabase y córrelo UNA vez.

-- 1) Caminatas del visitante (privadas: cada quien ve las suyas; admin ve todas).
--    id = id local del teléfono (texto) → subir por la cola offline es idempotente.
create table if not exists public.walks (
  id          text primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  route_id    text,
  route_name  text,
  started_at  timestamptz,
  ended_at    timestamptz,
  duration_ms bigint,
  distance_m  int,
  points      jsonb default '[]',   -- [[lng,lat,t], ...] muestreado (≤400 puntos)
  photos      jsonb default '[]',   -- [{lng,lat,name}, ...] del treasure hunt
  created_at  timestamptz not null default now()
);
alter table public.walks enable row level security;
drop policy if exists walks_read   on public.walks;
create policy walks_read   on public.walks for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists walks_insert on public.walks;
create policy walks_insert on public.walks for insert with check (auth.uid() = user_id);
drop policy if exists walks_update on public.walks;
create policy walks_update on public.walks for update using (auth.uid() = user_id or public.is_admin());
drop policy if exists walks_delete on public.walks;
create policy walks_delete on public.walks for delete using (auth.uid() = user_id or public.is_admin());
grant select, insert, update, delete on public.walks to authenticated;

-- 2) Avistamientos: columna client_id (id local del teléfono, único) para que
--    la cola offline pueda reintentar la subida sin crear duplicados.
alter table public.sightings add column if not exists client_id text unique;

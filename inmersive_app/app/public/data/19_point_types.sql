-- Cantares — migración: tabla de TIPOS de punto (sincroniza entre dispositivos).
-- Los tipos base (mirador, agua, árbol, etc.) viven en el código (TYPE_META). Esta
-- tabla guarda los tipos que crea o edita el admin, para que el color/emoji/nombre
-- se compartan entre teléfonos (antes vivían solo en el localStorage de un aparato).
-- La app funde: tipos base del código + tipos de esta tabla (la nube manda por id).
-- Pega TODO esto en el SQL Editor de Supabase y córrelo UNA vez.

create table if not exists public.point_types (
  id         text primary key,      -- slug del tipo (ej: 'cascada'); lo genera la app
  emoji      text,
  color      text,
  es         text,                  -- nombre en español
  en         text,                  -- nombre en inglés
  sort       int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.point_types enable row level security;

-- Lectura pública (la leyenda y el mapa se ven sin cuenta).
drop policy if exists point_types_read on public.point_types;
create policy point_types_read on public.point_types for select using (true);

-- Crear / editar / borrar tipos: sólo admin.
drop policy if exists point_types_write on public.point_types;
create policy point_types_write on public.point_types for all
  using ( public.is_admin() ) with check ( public.is_admin() );

grant select on public.point_types to anon;
grant select, insert, update, delete on public.point_types to authenticated;

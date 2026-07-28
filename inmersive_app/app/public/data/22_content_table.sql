-- Cantares — migración: contenido editable de las páginas (Historia e Info).
-- Guarda documentos JSON completos (uno por página) para que el admin pueda
-- editar los textos desde la app, sin tocar código ni volver a desplegar.
-- La app funde: el JSON empacado en data/historia.json / data/comercial.json
-- (build-time) + la fila de esta tabla ENCIMA (la nube manda). Si la migración
-- no se ha corrido, la app sigue mostrando el JSON empacado y los cambios
-- esperan en la cola offline.
-- Pega TODO esto en el SQL Editor de Supabase y córrelo UNA vez.

create table if not exists public.content (
  id         text primary key,          -- 'historia' | 'comercial'
  doc        jsonb not null,            -- documento completo de esa página
  updated_at timestamptz not null default now()
);

alter table public.content enable row level security;

-- Lectura pública (las pestañas Historia e Info se ven sin cuenta).
drop policy if exists content_read on public.content;
create policy content_read on public.content for select using (true);

-- Escribir: sólo admin.
drop policy if exists content_write on public.content;
create policy content_write on public.content for all
  using ( public.is_admin() ) with check ( public.is_admin() );

grant select on public.content to anon;
grant select, insert, update, delete on public.content to authenticated;

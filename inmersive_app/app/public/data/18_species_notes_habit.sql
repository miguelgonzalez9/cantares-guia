-- Cantares — migración: columnas faltantes en la tabla `species`.
-- El editor de especies guarda 'notes' (descripción) y el SIC usa 'habit'
-- (arbol/flor/planta) para dividir la flora. Sin estas columnas, al añadir/editar
-- una especie con notas la nube rechazaba el upsert y el cambio se perdía.
-- Pega TODO esto en el SQL Editor de Supabase y córrelo UNA vez.

alter table public.species add column if not exists notes text;
alter table public.species add column if not exists habit text;   -- arbol | flor | planta (deriva la categoría)

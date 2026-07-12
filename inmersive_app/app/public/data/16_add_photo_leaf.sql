-- Cantares — foto de la hoja para los árboles (segunda foto por punto).
-- Pega esto en el SQL Editor de Supabase y córrelo una vez.
alter table public.waypoints add column if not exists photo_leaf text;

-- Cantares — migración: descripción técnica + estado UICN en la tabla `species`.
-- La ficha de especie ahora muestra una descripción larga (multi-párrafo) y un
-- badge de conservación (UICN). Sin estas columnas, guardar/editar una especie
-- con descripción desde la app hace fallar el upsert y el cambio se encola en el
-- outbox sin subir. Pega TODO esto en el SQL Editor de Supabase y córrelo UNA vez.
--
-- Fuentes de `description`:
--   censo_2021  = ficha botánica del censo 2021 (revisada, autoritativa).
--   llm_draft   = borrador generado por IA para especies bandera (SIN revisar).
--   admin       = escrita/corregida por el administrador en la app (revisada).

alter table public.species add column if not exists description text;
alter table public.species add column if not exists description_en text;
alter table public.species add column if not exists description_source text;   -- censo_2021 | llm_draft | admin
alter table public.species add column if not exists description_reviewed boolean default false;
alter table public.species add column if not exists iucn text;                 -- EN | VU | CR | NT | LC | DD | NE

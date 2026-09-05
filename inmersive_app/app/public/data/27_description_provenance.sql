-- Cantares — migración 27: de dónde salió la descripción de una especie.
-- Pega TODO esto en el SQL Editor de Supabase y córrelo UNA vez.
--
-- POR QUÉ. `21_species_description.sql` dejó `description_source` con tres
-- valores posibles (censo_2021 | llm_draft | admin) y nada más. Eso bastaba
-- mientras el texto era propio o de un informe con dueño conocido, pero deja de
-- bastar en cuanto entra texto de terceros:
--
--   1. `data_prep/36_bird_descriptions.py` trae la sección «Description» de
--      Wikipedia en inglés para las aves vistas en la reserva. Wikipedia es
--      CC BY-SA: **exige atribución y enlace**. Sin una columna donde guardar de
--      qué artículo salió y bajo qué licencia, publicarlo sería incumplir la
--      licencia — y además nadie podría comprobar el dato después.
--   2. El texto de `censo_2021` viene del informe de Duque & Galeano, que TIENE
--      derechos, y hoy tampoco lo dice en ninguna parte. Mismo agujero.
--
-- Sin estas columnas el upsert de una especie con procedencia falla entero y la
-- edición se encola en el outbox sin subir nunca: el fallo es SILENCIOSO.
--
-- Idempotente: se puede pegar dos veces sin romper nada.

alter table public.species
  -- El artículo/documento concreto. Es lo que se enseña como atribución en la
  -- ficha y lo que permite volver a la fuente para verificar.
  add column if not exists description_url     text,

  -- La licencia bajo la que se puede publicar ese texto. Se guarda explícita en
  -- vez de deducirla de `description_source`: la misma fuente puede cambiar de
  -- licencia con el tiempo, y lo que importa es bajo cuál se tomó ESTE texto.
  --   CC BY-SA 4.0  → Wikipedia
  --   (null)        → texto propio o del administrador
  add column if not exists description_license text;

-- `description_source` gana un valor más. No se añade un CHECK: la columna nació
-- sin él y ponerlo ahora fallaría contra cualquier fila histórica con un valor
-- que no esté en la lista, que es exactamente el tipo de migración que se queda a
-- medias sin que nadie se entere.
--   censo_2021  = ficha botánica del censo 2021 (Duque & Galeano, con derechos).
--   llm_draft   = borrador generado por IA, SIN revisar.
--   wikipedia   = sección «Description» del artículo inglés (CC BY-SA 4.0).
--   admin       = escrita o corregida en la app (revisada).
comment on column public.species.description_source is
  'censo_2021 | llm_draft | wikipedia | admin';

-- Comprobación (debería devolver el reparto por fuente):
--   select description_source, description_license, count(*)
--     from public.species group by 1, 2 order by 1;

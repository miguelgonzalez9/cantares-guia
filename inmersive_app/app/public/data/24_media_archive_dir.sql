-- 24_media_archive_dir.sql — de qué carpeta del archivo vino una foto.
--
-- La clasificación local del archivo ES LA CARPETA (`fotos/aves/…`): eso es lo
-- que decidió el clasificador y lo que ordenaron los papás a mano. Hasta ahora
-- esa información se usaba para repartir la muestra y se TIRABA al subir, así que
-- en la bandeja todas las fotos llegaban iguales y había que abrir cada una para
-- saber si era un ave o un paisaje.
--
-- Guardarla sirve para tres cosas:
--   1. verla en la tarjeta y clasificar mucho más rápido,
--   2. filtrar la bandeja por carpeta de origen,
--   3. equilibrar entre tandas (saber de qué carpeta ya se trajo mucho), que hasta
--      ahora era imposible y estaba anotado como límite conocido.
--
-- Idempotente: se puede pegar dos veces.
alter table public.media add column if not exists archive_dir text;

comment on column public.media.archive_dir is
  'Carpeta del archivo local de la que vino (p. ej. "aves", "plantas/orquideas"). Sólo para origin = local-archive.';

-- La bandeja filtra por esto; con miles de filas un índice parcial lo hace gratis.
create index if not exists media_archive_dir_idx
  on public.media (archive_dir) where archive_dir is not null;

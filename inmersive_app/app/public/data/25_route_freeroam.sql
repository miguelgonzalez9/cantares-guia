-- 25_route_freeroam.sql — trazos libres de un recorrido (dentro de la zona de
-- recorrido libre), como TRAMO del recorrido y no como sendero de la red.
--
-- El problema: alrededor de la casa no hay sendero, hay pasto. Para hacer pasar
-- un recorrido por ahí se fueron dibujando senderos de verdad: hoy la zona de
-- recorrido libre (99 x 129 m) se traga 11 de los 19 tramos del Recorrido de
-- Árboles, 6 de Aves y 3 de Agua. Esos senderos existen sólo por no haber tenido
-- otra forma de trazar, ensucian la red y se van a borrar.
--
-- La alternativa NO es un sendero oculto ni una geometría suelta emparejada por
-- cercanía, sino un tramo más de la lista del recorrido:
--
--   segments        [ 'sendero_7', 'free:l1', 'sendero_12' ]
--   freeroam_paths  { "l1": [[lng,lat], ...] }
--
-- Así el orden es EXPLÍCITO (se arrastra y reordena con los demás tramos, se
-- duplica para la vuelta) en vez de deducido, el trazo pertenece al recorrido que
-- lo dibujó y no aparece en la lista de senderos de nadie más.
--
-- En la app (app.js): `orderedPathFromSegments` resuelve `free:*` contra este
-- campo y devuelve, en paralelo al trazado, qué coordenadas vienen de un trazo
-- dibujado; `freeRoamPath` respeta esos tramos en vez de enderezarlos. Sin esa
-- máscara el enderezado colapsaría el trazo a una recta — borrando justo lo que
-- se acaba de dibujar.
--
-- Idempotente: se puede pegar dos veces.
alter table public.routes
  add column if not exists freeroam_paths jsonb not null default '{}'::jsonb;

comment on column public.routes.freeroam_paths is
  'Trazos libres del recorrido: { "<clave>": [[lng,lat], ...] }. Se referencian desde segments como "free:<clave>". No son senderos: no están en trails y no se reutilizan entre recorridos.';

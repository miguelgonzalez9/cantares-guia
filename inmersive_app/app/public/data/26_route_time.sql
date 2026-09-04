-- 26_route_time.sql — tiempo de recorrido: el que mides tú, el que miden los
-- visitantes, y sólo en último lugar el que calcula el modelo.
--
-- El Recorrido del Agua mide 1.518 m y la app decía ~30 min, que es lo que tarda
-- SÓLO la bajada a la cascada. El modelo anterior era Naismith de camino llano
-- (4 km/h, 600 m/h de subida), sin penalización de bajada y sin contar que un
-- recorrido con audioguía se hace PARÁNDOSE en cada punto — 12 en el del Agua.
--
-- Dos cosas aquí:
--
-- 1. `duration_min`: el número que mides caminando. Gana sobre todo lo demás.
--    Ningún modelo le va a ganar a un cronómetro.
--
-- 2. `route_time_stats`: la mediana de lo que tardan los visitantes de verdad.
--    Los datos YA se recogen — `walks` guarda route_id, duration_ms, distance_m
--    y la traza desde la migración 14 — pero no había forma de leerlos en
--    agregado, porque `walks` es privada por RLS (cada quien ve las suyas).
--
--    La vista es SECURITY DEFINER y expone SÓLO agregados: nunca una caminata
--    concreta, nunca un user_id. Y filtra a las caminatas COMPLETAS: una fila
--    con route_id = 'agua' y 20 m recorridos no es haber hecho el recorrido, es
--    haber arrancado el cronómetro. Se exige estar dentro del ±30 % de la
--    longitud del recorrido y un mínimo de 3 caminatas: con una o dos, la
--    mediana es la anécdota de quien se paró a almorzar.
--
--    Hoy `walks` tiene 2 filas, de 6 segundos. La vista nace vacía a propósito y
--    la app se queda con el modelo hasta que haya caminatas reales.
--
-- Idempotente: se puede pegar dos veces.

alter table public.routes add column if not exists duration_min int;

comment on column public.routes.duration_min is
  'Duración medida a mano, en minutos. Si está puesta, gana sobre la mediana observada y sobre el modelo.';

-- Longitud de cada recorrido en metros, sumando la geometría de sus tramos.
-- Los tramos `free:*` (trazos libres, migración 25) no están en `trails`; no
-- entran en este cálculo, así que la longitud sale algo corta para los
-- recorridos que los usen. Es suficiente para lo único que hace: decidir si una
-- caminata se parece o no al recorrido.
create or replace view public.route_lengths as
with pts as (
  select t.id, ord, (c->>0)::float8 as lng, (c->>1)::float8 as lat
  from public.trails t, lateral jsonb_array_elements(t.geometry) with ordinality as e(c, ord)
), seg as (
  select id, sqrt(power((lng - lag(lng) over w) * 111320 * cos(radians(lat)), 2)
                + power((lat - lag(lat) over w) * 110540, 2)) as d
  from pts window w as (partition by id order by ord)
), tl as (
  select id, coalesce(sum(d), 0) as len_m from seg group by id
)
select r.id as route_id, coalesce(sum(tl.len_m), 0) as len_m
from public.routes r
left join lateral unnest(r.segments) s(tid) on true
left join tl on tl.id = s.tid
group by r.id;

create or replace view public.route_time_stats
with (security_invoker = false) as
select w.route_id,
       count(*)::int as n_walks,
       percentile_cont(0.5) within group (order by w.duration_ms) / 60000.0 as median_min,
       percentile_cont(0.5) within group (order by w.distance_m) as median_dist_m
from public.walks w
join public.route_lengths rl on rl.route_id = w.route_id
where w.route_id is not null
  and w.duration_ms > 0
  and rl.len_m > 0
  and w.distance_m between rl.len_m * 0.7 and rl.len_m * 1.3   -- caminata COMPLETA
group by w.route_id
having count(*) >= 3;                                          -- 1 o 2 es anécdota

comment on view public.route_time_stats is
  'Mediana de duración real por recorrido, sólo sobre caminatas completas (±30% de la longitud) y con al menos 3. Agregados públicos; las filas de walks siguen siendo privadas.';

grant select on public.route_lengths  to anon, authenticated;
grant select on public.route_time_stats to anon, authenticated;

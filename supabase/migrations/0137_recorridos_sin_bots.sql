-- ============================================================================
--  Viven — Recorridos sin bots (0137)
--
--  El problema, medido el 25 ago 2026: de ~7.000 sesiones en 30 días, el 75% es
--  tráfico automático de una sola página. Eso no distorsiona un poco los paneles
--  de recorridos: los DEFINE. "Flujo de visitas" mostraba casi todo terminando en
--  (salida) y "Páginas de entrada" daba 80-90% de rebote — no porque la web
--  ahuyente gente, sino porque un bot que pide una página y se va ES, para esas
--  consultas, un rebote perfecto.
--
--  Desde la 0136 sabemos qué sesiones tuvieron una persona detrás (scroll, puntero
--  o toque en session_activity). Estas dos funciones aceptan ahora p_solo_personas:
--    · true  → solo sesiones con actividad humana, y la ventana se recorta al
--              24/08 en adelante, porque antes de esa fecha no hay con qué separar.
--              Mostrar "28 días" filtrando lo que solo existe hace uno sería
--              inventar una caída.
--    · false → todo el tráfico, como venía (para comparar contra herramientas
--              externas que sí cuentan bots).
--
--  Idempotente. El default es false para que nada que ya llame a estas funciones
--  cambie de significado sin pedirlo.
-- ============================================================================

-- Las versiones de un solo parámetro se van: si quedaran, PostgREST tendría dos
-- funciones con el mismo nombre y elegiría según los argumentos que le manden —
-- una llamada vieja seguiría contando bots en silencio. Mejor una sola firma.
drop function if exists public.rpc_path_flows(int);
drop function if exists public.rpc_entry_pages(int);

-- desde cuándo hay medición de personas (misma constante que el dashboard)
create or replace function public.humanos_desde()
returns timestamptz language sql immutable as $$ select timestamptz '2026-08-24 00:00:00+00' $$;

-- ---------------------------------------------------------------------------
-- 🗺️ Flujo de visitas
-- ---------------------------------------------------------------------------
create or replace function public.rpc_path_flows(p_days int default 28, p_solo_personas boolean default false)
returns table(step1 text, step2 text, step3 text, sessions bigint)
language sql security definer set search_path = public as $$
  with pv as (
    select p.session_id, p.path, p.created_at
    from pageviews p
    where p.created_at >= case when p_solo_personas
                               then greatest(now() - (p_days || ' days')::interval, public.humanos_desde())
                               else now() - (p_days || ' days')::interval end
      and p.session_id is not null
      and (not p_solo_personas
           or exists (select 1 from session_activity a where a.session_id = p.session_id))
  ),
  dedup as (
    select session_id, path, created_at
    from (
      select session_id, path, created_at,
             lag(path) over (partition by session_id order by created_at) as prev_path
      from pv
    ) t
    where prev_path is null or path is distinct from prev_path
  ),
  sess as (
    select session_id, (array_agg(path order by created_at))[1:3] as steps
    from dedup group by session_id
  )
  select s.steps[1],
         coalesce(s.steps[2], '(salida)'),
         case when s.steps[2] is null then '(salida)' else coalesce(s.steps[3], '(salida)') end,
         count(*)::bigint
  from sess s
  where s.steps[1] is not null
  group by 1, 2, 3
  order by 4 desc
  limit 60;
$$;

-- ---------------------------------------------------------------------------
-- 🚪 Páginas de entrada (landing · rebote · profundidad)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_entry_pages(p_days int default 28, p_solo_personas boolean default false)
returns table(landing text, sessions bigint, bounces bigint, avg_pages numeric)
language sql security definer set search_path = public as $$
  with pv as (
    select p.session_id, p.path, p.created_at
    from pageviews p
    where p.created_at >= case when p_solo_personas
                               then greatest(now() - (p_days || ' days')::interval, public.humanos_desde())
                               else now() - (p_days || ' days')::interval end
      and p.session_id is not null
      and (not p_solo_personas
           or exists (select 1 from session_activity a where a.session_id = p.session_id))
  ),
  sess as (
    select session_id, (array_agg(path order by created_at))[1] as landing, count(*) as pages
    from pv group by session_id
  )
  select sess.landing,
         count(*)::bigint,
         count(*) filter (where sess.pages = 1)::bigint,
         round(avg(sess.pages)::numeric, 2)
  from sess
  group by sess.landing
  order by 2 desc
  limit 30;
$$;

-- Permisos: solo el dashboard. Las firmas viejas (sin el segundo parámetro)
-- siguen existiendo por el default, así que no hay que tocar a quien ya llama.
revoke execute on function public.rpc_path_flows(int, boolean),
                          public.rpc_entry_pages(int, boolean) from public, anon;
grant  execute on function public.rpc_path_flows(int, boolean),
                          public.rpc_entry_pages(int, boolean) to authenticated;

-- ============================================================================
--  Viven — flujo de recorridos (Sankey 3 columnas) sobre pageviews
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
--
--  rpc_path_flows(p_days): por sesión toma los primeros 3 paths ORDENADOS
--  por created_at, deduplicando consecutivos idénticos (una recarga no es
--  una transición). '(salida)' marca que la sesión terminó ahí.
--  Devuelve el top 60 de combinaciones (step1, step2, step3) por sesiones —
--  el dashboard arma el diagrama en el panel 🧭 Recorridos (🗺️ Flujo de visitas).
--
--  Performance: se filtra por fecha ANTES de agregar (usa el índice por
--  created_at de pageviews); el dedupe es un lag() por sesión sobre ese rango.
-- ============================================================================

create or replace function public.rpc_path_flows(p_days int default 28)
returns table(step1 text, step2 text, step3 text, sessions bigint)
language sql security definer set search_path = public as $$
  with pv as (
    -- solo el rango pedido, con sesión identificable
    select session_id, path, created_at
    from pageviews
    where created_at >= now() - (p_days || ' days')::interval
      and session_id is not null
  ),
  dedup as (
    -- fuera los consecutivos idénticos (recargas / re-render de la misma path)
    select session_id, path, created_at
    from (
      select session_id, path, created_at,
             lag(path) over (partition by session_id order by created_at) as prev_path
      from pv
    ) t
    where prev_path is null or path is distinct from prev_path
  ),
  sess as (
    -- primeros 3 pasos reales de cada sesión, en orden
    select session_id,
           (array_agg(path order by created_at))[1:3] as steps
    from dedup
    group by session_id
  )
  select s.steps[1]                                as step1,
         coalesce(s.steps[2], '(salida)')          as step2,
         case
           when s.steps[2] is null then '(salida)'  -- rebotó: no hay 3er paso real
           else coalesce(s.steps[3], '(salida)')
         end                                       as step3,
         count(*)::bigint                          as sessions
  from sess s
  where s.steps[1] is not null
  group by 1, 2, 3
  order by sessions desc
  limit 60;
$$;

-- ---------------------------------------------------------------------------
-- Permisos: SOLO el dashboard (authenticated) — nunca anon/public
-- ---------------------------------------------------------------------------
revoke execute on function public.rpc_path_flows(int) from public, anon;
grant execute on function public.rpc_path_flows(int) to authenticated;

-- Contar el período anterior en la base, no en el navegador.
--
-- El dashboard traía las 6.349 filas de pageviews del período previo —con su path, su
-- duración, todo— para calcular DOS números: cuántas visitas y cuántas sesiones. Eso es el
-- 39% de todo lo que baja la pantalla de analítica, que tarda 7,3 segundos.
--
-- Las sesiones de Claude (session_id 'claude-…') se excluyen acá con el mismo criterio que
-- usaba el navegador, para que el número no cambie de significado al mudarlo.

create or replace function stats_periodo(desde timestamptz, hasta timestamptz)
returns table (visitas bigint, sesiones bigint)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::bigint,
         count(distinct session_id)::bigint
    from pageviews
   where created_at >= desde
     and created_at <= hasta
     and coalesce(session_id, '') not like 'claude-%';
$$;

grant execute on function stats_periodo(timestamptz, timestamptz) to authenticated;

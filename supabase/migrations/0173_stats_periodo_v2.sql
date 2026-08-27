-- stats_periodo, completa: los cuatro datos que el dashboard sacaba de las 6.349 filas.
--
-- La v1 devolvía solo visitas y sesiones, y con eso se rompían dos cosas que también salían
-- de esas filas: la MEDIANA de duración del período anterior (la flecha ▲▼ del tiempo en
-- página) y la SERIE DIARIA de sesiones (la línea punteada del gráfico). Traerse 6.349
-- filas para calcular cuatro cosas sigue siendo desproporcionado; calcular las cuatro acá
-- no lo es.
--
-- La mediana con percentile_cont es la misma que hacía el navegador ordenando el array.

-- Cambia el tipo de retorno, así que primero se tira la v1.
drop function if exists stats_periodo(timestamptz, timestamptz);

create or replace function stats_periodo(desde timestamptz, hasta timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select created_at, session_id, duration
      from pageviews
     where created_at >= desde and created_at <= hasta
       and coalesce(session_id, '') not like 'claude-%'
  )
  select jsonb_build_object(
    'visitas',  (select count(*) from base),
    'sesiones', (select count(distinct session_id) from base),
    'dur_mediana', coalesce(
      (select percentile_cont(0.5) within group (order by duration)
         from base where duration > 0), 0),
    'por_dia', coalesce((
      select jsonb_object_agg(d, s)
        from (select to_char(created_at, 'YYYY-MM-DD') d, count(distinct session_id) s
                from base group by 1) x), '{}'::jsonb)
  );
$$;

grant execute on function stats_periodo(timestamptz, timestamptz) to authenticated;

-- ============================================================================
--  Viven — visitantes por mes / trimestre / año (0140)
--
--  La tabla de "Conversión real" mostraba Período · Leads · Clientes · Conversión.
--  Le faltaba el escalón de arriba: cuánta gente llegó al sitio. Sin eso no se
--  puede ver si un mes con menos leads fue un mes con menos tráfico o con peor
--  conversión — que es justo la pregunta de "¿mejoramos mes a mes?".
--
--  Devuelve las dos cifras separadas, como la 0139:
--    · sesiones → todo el tráfico (bots incluidos). Es lo único que existe para
--      los meses anteriores al 24/08, y sirve para comparar un mes contra otro
--      porque el sesgo es parejo.
--    · personas → visitas humanas confirmadas. Solo desde el 24/08; en los meses
--      viejos da 0 y el dashboard lo muestra como "—", nunca como un cero.
--
--  El dashboard NO divide leads por sesiones-con-bots sin decirlo: la columna de
--  conversión de tráfico se etiqueta según cuál de las dos se usó.
-- ============================================================================

create or replace function public.rpc_visitas_por_periodo(p_modo text default 'mes')
returns table (clave text, sesiones bigint, personas bigint)
language sql stable security definer set search_path = public as $$
  with pv as (
    select pageviews.session_id, pageviews.created_at,
           -- hora de Zúrich, no UTC: el dashboard arma su clave con la fecha local,
           -- y una visita del 31 a las 23:40 tiene que caer en el mismo mes en los dos
           case p_modo
             when 'anio' then to_char(pageviews.created_at at time zone 'Europe/Zurich', 'YYYY')
             when 'trim' then to_char(pageviews.created_at at time zone 'Europe/Zurich', 'YYYY') || '-Q' ||
                               to_char(ceil(extract(month from pageviews.created_at at time zone 'Europe/Zurich') / 3.0), 'FM9')
             else to_char(pageviews.created_at at time zone 'Europe/Zurich', 'YYYY-MM')
           end as clave
    from pageviews
    where pageviews.session_id is not null
  )
  select pv.clave,
         count(distinct pv.session_id) as sesiones,
         count(distinct pv.session_id) filter (
           where pv.created_at >= public.humanos_desde()
             and exists (select 1 from session_activity a where a.session_id = pv.session_id)
         ) as personas
  from pv group by pv.clave order by pv.clave desc;
$$;

revoke all on function public.rpc_visitas_por_periodo(text) from public, anon;
grant execute on function public.rpc_visitas_por_periodo(text) to authenticated;

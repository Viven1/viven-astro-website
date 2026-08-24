-- ============================================================================
--  0125: qué está mirando la gente, agregado en la base
--
--  Sebastián, 14 ago 2026: "agregá más sugerencias, onda: mucha gente está
--  viendo employer branding, hagamos un lead magnet, o más blogs... tenemos que
--  cubrir todo, no solo el CRM".
--
--  Para eso hace falta saber QUÉ tema tiene demanda. Son 7.640 pageviews en 28
--  días: traerlos al navegador y contarlos ahí no sirve — PostgREST corta en
--  1000 filas y la cuenta sale mal EN SILENCIO (me pasó armando este mismo
--  análisis: creí tener el mes entero y tenía el 13%). Se agrupa en Postgres.
--
--  El tema sale del path, que es como está armado el sitio: /services/…,
--  /blog/…, /resources/… en tres idiomas. Si mañana cambia la estructura de
--  URLs, esta clasificación hay que revisarla — es la única parte frágil.
--
--  Correr una vez en el SQL Editor. Idempotente.
-- ============================================================================

create or replace function public.rpc_demanda_28d()
returns table (tema text, personas bigint, vistas bigint, leads bigint)
language sql
stable
security definer
set search_path = public
as $$
  with clas as (
    select
      pv.session_id,
      case
        when lower(pv.path) ~ 'employer|arbeitgeber|talento|talent'          then 'employer branding'
        when lower(pv.path) ~ 'product-video|produktvideo|video-de-producto'  then 'product video'
        when lower(pv.path) ~ 'brand-video|markenfilm|video-de-marca'         then 'brand video'
        when lower(pv.path) ~ 'how-to|erklaer|erklär|explicativo|explainer|tutorial' then 'how-to / explainer'
        when lower(pv.path) ~ 'social'                                        then 'social media'
        when lower(pv.path) ~ 'corporate|unternehmens'                        then 'corporate'
        when lower(pv.path) ~ 'calculator|rechner|calculadora'                then 'calculadora'
        when lower(pv.path) ~ '/resources/|/recursos/|/ressourcen/'           then 'recursos'
        when lower(pv.path) ~ '/blog/'                                        then 'blog'
        when lower(pv.path) ~ '/projects/|/proyectos/|/projekte/'             then 'portfolio'
        else null
      end as tema
    from public.pageviews pv
    where pv.created_at >= now() - interval '28 days'
  ),
  agg as (
    select tema, count(distinct session_id) as personas, count(*) as vistas
    from clas where tema is not null group by tema
  ),
  -- leads del mismo período por sesión, para saber si un tema con mucha visita
  -- convierte o no: 300 personas mirando algo que nunca deja un lead es una
  -- oportunidad; 30 que dejan 5 leads es otra cosa distinta
  leads_tema as (
    select c.tema, count(distinct l.id) as leads
    from clas c
    join public.leads l on l.session_id = c.session_id
      and l.created_at >= now() - interval '28 days'
    where c.tema is not null
    group by c.tema
  )
  select a.tema, a.personas, a.vistas, coalesce(lt.leads, 0) as leads
  from agg a left join leads_tema lt on lt.tema = a.tema
  order by a.personas desc;
$$;

revoke all on function public.rpc_demanda_28d() from public;
grant execute on function public.rpc_demanda_28d() to authenticated, service_role;

-- Verificación (no cambia nada):
--   select * from public.rpc_demanda_28d();

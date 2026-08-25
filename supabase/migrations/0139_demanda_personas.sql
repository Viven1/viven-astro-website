-- ============================================================================
--  Viven — Demanda por tema: "personas" que eran sesiones (0139)
--
--  La 0125 devolvía una columna llamada `personas` que en realidad contaba
--  sesiones distintas de pageviews. Con el 75% del tráfico automático, eso le
--  decía a la IA de "Oportunidades de la web" cosas como "300 personas miraron
--  employer branding" cuando la mayoría eran bots — y la IA escribía ideas para
--  una demanda que no existe.
--
--  Ahora devuelve las dos cifras, separadas y con el nombre que les corresponde:
--    · personas      → sesiones con actividad humana confirmada (desde el 24/08)
--    · sesiones_28d  → todo el tráfico de 28 días, bots incluidos (sirve para el
--                      RANKING relativo entre temas, que con menos días todavía
--                      no se sostiene)
--  Quien la consuma decide cuál usa, pero ya no puede confundirlas.
-- ============================================================================

drop function if exists public.rpc_demanda_28d();

create or replace function public.rpc_demanda_28d()
returns table (tema text, personas bigint, sesiones_28d bigint, vistas bigint, leads bigint)
language sql stable security definer set search_path = public as $$
  with clas as (
    select
      pv.session_id, pv.created_at,
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
    select c.tema,
           count(distinct c.session_id) filter (
             where c.created_at >= public.humanos_desde()
               and exists (select 1 from session_activity a where a.session_id = c.session_id)
           ) as personas,
           count(distinct c.session_id) as sesiones_28d,
           count(*) as vistas
    from clas c where c.tema is not null group by c.tema
  ),
  leads_tema as (
    select c.tema, count(distinct l.id) as leads
    from clas c
    join public.leads l on l.session_id = c.session_id
      and l.created_at >= now() - interval '28 days'
    where c.tema is not null
    group by c.tema
  )
  select a.tema, a.personas, a.sesiones_28d, a.vistas, coalesce(lt.leads, 0)
  from agg a left join leads_tema lt on lt.tema = a.tema
  order by a.sesiones_28d desc;
$$;

revoke all on function public.rpc_demanda_28d() from public, anon;
grant execute on function public.rpc_demanda_28d() to authenticated, service_role;

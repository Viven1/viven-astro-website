-- El proyecto necesita nombre: el deal de Sonova no tenía título y el portal del
-- cliente mostraba el encabezado vacío. El nombre natural es el de la propuesta que
-- firmó ("Sonova - New Sound Demo 2026"); si no hubo propuesta, el de la oferta; y si
-- no hay ninguna, la empresa. Nunca queda en blanco.
create or replace function public.proyecto_nombre(p_deal uuid, p_lead bigint, p_titulo text)
returns text language sql stable as $$
  select coalesce(
    nullif(trim(p_titulo), ''),
    (select nullif(trim(pr.title),'') from public.proposals pr
      where pr.status='accepted' and (pr.deal_id = p_deal or pr.lead_id::text = p_lead::text)
      order by pr.accepted_at desc nulls last limit 1),
    (select nullif(trim(o.title),'') from public.offers o
      where o.status='won' and o.lead_id::text = p_lead::text and not coalesce(o.archived,false)
      order by o.updated_at desc limit 1),
    (select nullif(trim(l.company),'') from public.leads l where l.id = p_lead),
    (select nullif(trim(l.name),'') from public.leads l where l.id = p_lead),
    'Proyecto'
  );
$$;

update public.projects p
   set title = public.proyecto_nombre(p.deal_id, p.lead_id, p.title)
 where coalesce(trim(p.title),'') = '';

select id, title from public.projects;

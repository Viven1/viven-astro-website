-- ============================================================================
--  PROYECTOS — el proyecto nace cuando ganamos el deal (Sebastián, 25 ago 2026)
--
--  "que cree el proyecto cuando lo ganamos y ahí metemos todo lo importante", con
--  cinco estados: Desarrollo → Pre-producción → Rodaje → Post → Entregado,
--  heredando cliente, monto y posiciones de la propuesta aceptada, y ligado a las
--  facturas de bexio para ver el saldo sin facturar.
--
--  NO se crea una tabla nueva. Un proyecto es 1:1 con un deal ganado, y `deals` ya
--  tiene desde la 0052 el campo de etapa de PRODUCCIÓN (production_status), el token
--  del portal del cliente y el link del entregable — o sea que media pantalla ya
--  existía sin datos: los 197 deals lo tenían en NULL, así que el portal del cliente
--  nunca se encendió una sola vez. Poner el proyecto en otra tabla habría significado
--  mantener dos verdades sincronizadas para nada.
--
--  Las etapas viejas del portal (pre_production | filming | editing | client_review |
--  delivered) se mapean a las cinco de Sebastián. Como estaban todas en NULL no hay
--  nada que migrar, pero el mapeo queda por si aparece un link viejo.
-- ============================================================================

alter table public.deals add column if not exists project_started_at timestamptz;
alter table public.deals add column if not exists shoot_start date;
alter table public.deals add column if not exists shoot_end date;
alter table public.deals add column if not exists delivery_due date;
alter table public.deals add column if not exists project_amount numeric;
alter table public.deals add column if not exists project_items jsonb;
alter table public.deals add column if not exists project_notes text;

comment on column public.deals.production_status is
  'Etapa de PRODUCCIÓN (post-venta), separada de stage (que es la etapa de VENTA): desarrollo | preproduccion | rodaje | post | entregado. La lee también el portal del cliente.';
comment on column public.deals.project_amount is
  'Monto del proyecto heredado de la propuesta aceptada (accepted_total) o de la oferta ganada. Se puede editar a mano después.';
comment on column public.deals.project_items is
  'Posiciones heredadas del paquete aceptado. Copia, no referencia: si mañana se edita la propuesta, el proyecto no cambia solo.';

-- mapeo de las etapas viejas del portal a las cinco nuevas
update public.deals set production_status = case production_status
    when 'pre_production' then 'preproduccion'
    when 'filming'        then 'rodaje'
    when 'editing'        then 'post'
    when 'client_review'  then 'post'
    when 'delivered'      then 'entregado'
    else production_status end
 where production_status in ('pre_production','filming','editing','client_review','delivered');

-- ---------------------------------------------------------------------------
--  El proyecto nace solo al ganar
--
--  Se dispara cuando el deal ENTRA en 'ganado' y todavía no tiene proyecto. Hereda
--  el monto y las posiciones del paquete que el cliente aceptó; si no hay propuesta
--  aceptada, de la oferta ganada; si no hay ninguna, del deal_value. Nunca pisa un
--  proyecto que ya existe: volver a marcar ganado un deal no reinicia su producción.
-- ---------------------------------------------------------------------------
create or replace function public.deal_ganado_crea_proyecto()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric;
  v_items jsonb;
begin
  if new.stage is distinct from 'ganado' then return new; end if;
  if coalesce(old.stage,'') = 'ganado' then return new; end if;
  if new.production_status is not null then return new; end if;

  -- 1) la propuesta que el cliente aceptó: el monto real y el paquete elegido
  select p.accepted_total,
         (select t from jsonb_array_elements(coalesce(p.content->'tiers','[]'::jsonb)) t
           where t->>'name' = p.accepted_tier limit 1)
    into v_total, v_items
    from public.proposals p
   where p.status = 'accepted'
     and (p.deal_id = new.id or p.lead_id::text = new.lead_id::text)
   order by p.accepted_at desc nulls last
   limit 1;

  -- 2) si no hubo propuesta, la oferta ganada
  if v_total is null then
    select o.items into v_items
      from public.offers o
     where o.status = 'won' and o.lead_id::text = new.lead_id::text
       and not coalesce(o.archived,false)
     order by o.updated_at desc limit 1;
  end if;

  new.production_status   := 'desarrollo';
  new.project_started_at  := coalesce(new.won_at, now());
  new.project_amount      := coalesce(v_total, new.deal_value);
  new.project_items       := coalesce(v_items->'items', v_items);
  return new;
end;
$$;

drop trigger if exists trg_deal_ganado_crea_proyecto on public.deals;
create trigger trg_deal_ganado_crea_proyecto
  before update on public.deals
  for each row execute function public.deal_ganado_crea_proyecto();

-- ---------------------------------------------------------------------------
--  Backfill: SOLO los ganados que siguen vivos.
--  Los 172 archivados son la cartera histórica importada de bexio — proyectos que
--  terminaron hace años. Marcarlos "en desarrollo" sería inventar trabajo que no
--  existe. Ver [un borrado a propósito no se repone]: un hueco deliberado no es un hueco.
-- ---------------------------------------------------------------------------
update public.deals d
   set production_status  = 'desarrollo',
       project_started_at = coalesce(d.won_at, now()),
       project_amount     = coalesce(
         (select p.accepted_total from public.proposals p
           where p.status='accepted' and (p.deal_id = d.id or p.lead_id::text = d.lead_id::text)
           order by p.accepted_at desc nulls last limit 1),
         d.deal_value),
       project_items = (
         select (select t->'items' from jsonb_array_elements(coalesce(p.content->'tiers','[]'::jsonb)) t
                  where t->>'name' = p.accepted_tier limit 1)
           from public.proposals p
          where p.status='accepted' and (p.deal_id = d.id or p.lead_id::text = d.lead_id::text)
          order by p.accepted_at desc nulls last limit 1)
 where d.stage = 'ganado' and not coalesce(d.archived,false) and d.production_status is null;

create index if not exists deals_produccion_idx on public.deals (production_status)
  where production_status is not null;

-- ============================================================================
-- 0022 (v2): DEALS como entidad propia (modelo HubSpot)
-- La PERSONA (leads) ya no "es" el deal: un contacto puede tener VARIOS deals
-- (proyectos), cada uno con su etapa en el pipeline. leads.status queda como
-- ESPEJO del deal más reciente. Backfill: 1 deal por persona existente.
-- v2: leads.id es BIGINT (no uuid) — la v1 fallaba con "operator does not exist:
--     uuid = bigint". Esta versión es autocurativa: si la tabla quedó creada
--     VACÍA por la corrida fallida, la recrea con los tipos correctos.
-- ============================================================================

-- autocuración: si deals existe pero está VACÍA (corrida v1 fallida), recrearla.
-- OJO: la referencia a public.deals va en EXECUTE (SQL dinámico) — si la tabla no
-- existe, una referencia directa falla al PLANIFICAR aunque el IF dé falso.
do $$
declare has_rows boolean;
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'deals') then
    execute 'select exists(select 1 from public.deals limit 1)' into has_rows;
    if not has_rows then
      execute 'drop table public.deals cascade';
    end if;
  end if;
end $$;

create table if not exists public.deals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  lead_id       bigint not null,               -- leads.id es bigint
  title         text,                          -- nombre del proyecto (ej. "Employer branding 2026")
  stage         text not null default 'nuevo', -- nuevo|contactado|videocall|propuesta|ganado|perdido
  deal_value    numeric,                       -- estimado manual (fallback si no hay ofertas)
  lost_reason   text,
  archived      boolean not null default false,
  last_stage_at timestamptz,
  contacted_at  timestamptz,
  videocall_at  timestamptz,
  proposal_at   timestamptz,
  won_at        timestamptz,
  lost_at       timestamptz
);
create index if not exists deals_lead_idx on public.deals (lead_id);
alter table public.deals enable row level security;
drop policy if exists deals_auth_all on public.deals;
create policy deals_auth_all on public.deals for all to authenticated using (true) with check (true);

-- ofertas / propuestas / follow-ups pertenecen a UN deal (además de la persona)
alter table public.offers         add column if not exists deal_id uuid;
alter table public.proposals      add column if not exists deal_id uuid;
alter table public.lead_followups add column if not exists deal_id uuid;

-- fix de 0021: bookings.lead_id era uuid pero leads.id es bigint (los inserts
-- fallaban en silencio) + el dashboard necesita LEER bookings (Necesita atención)
alter table public.bookings drop column if exists lead_id;
alter table public.bookings add column if not exists lead_id bigint;
drop policy if exists bookings_auth_read on public.bookings;
create policy bookings_auth_read on public.bookings for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- BACKFILL (idempotente): 1 deal por lead que aún no tenga ninguno
-- ---------------------------------------------------------------------------
insert into public.deals (lead_id, title, stage, deal_value, lost_reason, created_at,
                          last_stage_at, contacted_at, videocall_at, proposal_at, won_at, lost_at)
select l.id,
       coalesce(nullif(l.name, ''), l.email),
       case
         when lower(coalesce(l.status,'')) in ('won','ganado','cerrado')          then 'ganado'
         when lower(coalesce(l.status,'')) in ('lost','perdido')                  then 'perdido'
         when lower(coalesce(l.status,'')) in ('proposal','propuesta','qualified') then 'propuesta'
         when lower(coalesce(l.status,'')) in ('videocall','video call booked','call','agendada','booked') then 'videocall'
         when lower(coalesce(l.status,'')) in ('contacted','contactado')          then 'contactado'
         else 'nuevo'
       end,
       l.deal_value, l.lost_reason, l.created_at,
       l.last_stage_at, l.contacted_at, l.videocall_at, l.proposal_at, l.won_at, l.lost_at
from public.leads l
where not exists (select 1 from public.deals d where d.lead_id = l.id);

-- ligar lo existente a ese deal inicial (comparación por texto: tipos mixtos)
update public.offers o set deal_id = d.id
  from public.deals d
 where o.deal_id is null and o.lead_id is not null and d.lead_id::text = o.lead_id::text;

update public.proposals p set deal_id = d.id
  from public.deals d
 where p.deal_id is null and p.lead_id is not null and d.lead_id::text = p.lead_id::text;

update public.lead_followups f set deal_id = d.id
  from public.deals d
 where f.deal_id is null and f.lead_id is not null and d.lead_id::text = f.lead_id::text;

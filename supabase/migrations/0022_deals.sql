-- ============================================================================
-- 0022: DEALS como entidad propia (modelo HubSpot)
-- La PERSONA (leads) ya no "es" el deal: un contacto puede tener VARIOS deals
-- (proyectos), cada uno con su etapa en el pipeline. leads.status queda como
-- ESPEJO del deal más reciente (compatibilidad con follow-ups, listas y KPIs).
-- Backfill: 1 deal por persona existente, heredando etapa, hitos y valor.
-- ============================================================================

create table if not exists public.deals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  lead_id       uuid not null,
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

-- ligar lo existente a ese deal inicial (solo lo que no tenga deal todavía)
update public.offers o set deal_id = d.id
  from public.deals d
 where o.deal_id is null and o.lead_id is not null and d.lead_id = o.lead_id::uuid;

update public.proposals p set deal_id = d.id
  from public.deals d
 where p.deal_id is null and p.lead_id is not null and d.lead_id = p.lead_id::uuid;

update public.lead_followups f set deal_id = d.id
  from public.deals d
 where f.deal_id is null and f.lead_id is not null and d.lead_id = f.lead_id;

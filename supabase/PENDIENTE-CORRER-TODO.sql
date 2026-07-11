-- ============================================================================
--  Viven — en qué página convirtió el lead (form de la página del servicio,
--  no solo /contact). Clave para saber qué servicio/página genera leads.
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

alter table public.leads add column if not exists form_path text;
-- ============================================================================
--  Viven — valor estimado del deal en el contacto (cuando todavía no hay oferta).
--  El board de Deals y el forecast usan este valor hasta que exista una oferta.
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

alter table public.leads add column if not exists deal_value numeric;
-- ============================================================================
--  Viven — términos especiales en ofertas + templates reutilizables
--  (los terms de propuestas van dentro de content JSON, no necesitan columna)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

alter table public.offers    add column if not exists terms       text;
alter table public.offers    add column if not exists is_template boolean not null default false;
alter table public.proposals add column if not exists is_template boolean not null default false;
-- ============================================================================
--  Viven — follow-ups automáticos al CLIENTE (secuencia aprobable/editable)
--  + archivar propuestas. Correr una vez en el SQL Editor. Idempotente.
-- ============================================================================

-- cada fila = un email de follow-up programado para un lead
create table if not exists public.lead_followups (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  lead_id    text not null,
  position   int  not null default 1,        -- nº en la secuencia (1, 2, 3…)
  subject    text not null,
  body       text not null,
  send_at    timestamptz not null,           -- cuándo se manda (editable)
  status     text not null default 'draft',  -- draft | approved | sent | canceled
  sent_at    timestamptz,
  sender_key text default 'sofia'            -- de quién sale (reply-to)
);
alter table public.lead_followups enable row level security;
drop policy if exists lead_followups_all_auth on public.lead_followups;
create policy lead_followups_all_auth on public.lead_followups for all to authenticated using (true) with check (true);
create index if not exists lead_followups_lead_idx on public.lead_followups (lead_id);
create index if not exists lead_followups_due_idx on public.lead_followups (send_at) where status = 'approved';

-- archivar propuestas (las ofertas ya tienen archived)
alter table public.proposals add column if not exists archived boolean not null default false;
-- ============================================================================
--  Viven — schedules de los crons (task-remind cada 5 min, followup-send cada 30)
--  Correr una vez en el SQL Editor. Usa pg_cron + pg_net (mismo patrón que 0001).
--  Para cambiar un horario: select cron.unschedule('viven-task-remind'); y re-crear.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- limpiar si ya existían (idempotente)
do $$ begin
  perform cron.unschedule('viven-task-remind');
exception when others then null; end $$;
do $$ begin
  perform cron.unschedule('viven-followup-send');
exception when others then null; end $$;

-- ⏰ recordatorios de tasks vencidas (push + email) — cada 5 minutos
select cron.schedule('viven-task-remind', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/task-remind',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

-- 📬 follow-ups aprobados al cliente — cada 30 minutos
select cron.schedule('viven-followup-send', '*/30 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/followup-send',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);
-- 0021: dirección legal del cliente en ofertas + enrich de contactos con IA + booking propio
-- Correr en Supabase → SQL Editor.

-- 1) Oferta PDF legal: dirección completa del cliente
alter table public.offers add column if not exists client_company  text;
alter table public.offers add column if not exists client_contact  text;
alter table public.offers add column if not exists client_address  text;
alter table public.offers add column if not exists client_zip_city text;
alter table public.offers add column if not exists client_phone    text;
alter table public.offers add column if not exists client_email    text;

-- 2) Enrich contacts con IA (resultado cacheado en el lead)
alter table public.leads add column if not exists enrichment  jsonb;
alter table public.leads add column if not exists enriched_at timestamptz;

-- 3) Booking propio (reemplazo del meeting link de HubSpot)
create table if not exists public.bookings (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null,
  email       text not null,
  phone       text,
  message     text,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  duration_m  int not null default 15,
  lang        text default 'en',
  lead_id     uuid,
  gcal_event  text,          -- id del evento creado en Google Calendar
  meet_url    text,          -- link de Google Meet
  status      text not null default 'confirmed'   -- confirmed | canceled
);
alter table public.bookings enable row level security;
-- solo el service role escribe/lee (las edge functions); nada para anon
drop policy if exists bookings_no_anon on public.bookings;
-- ============================================================================
-- 0022 (v2): DEALS como entidad propia (modelo HubSpot)
-- La PERSONA (leads) ya no "es" el deal: un contacto puede tener VARIOS deals
-- (proyectos), cada uno con su etapa en el pipeline. leads.status queda como
-- ESPEJO del deal más reciente. Backfill: 1 deal por persona existente.
-- v2: leads.id es BIGINT (no uuid) — la v1 fallaba con "operator does not exist:
--     uuid = bigint". Esta versión es autocurativa: si la tabla quedó creada
--     VACÍA por la corrida fallida, la recrea con los tipos correctos.
-- ============================================================================

-- autocuración: si deals existe pero está VACÍA (corrida v1 fallida), recrearla
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'deals')
     and not exists (select 1 from public.deals limit 1) then
    execute 'drop table public.deals cascade';
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
-- 0023: dirección legal en la ficha de EMPRESA (fuente para ofertas y propuestas)
alter table public.companies add column if not exists address  text;
alter table public.companies add column if not exists zip_city text;

-- limpieza: borrar el lead de diagnóstico del test del formulario
delete from public.leads where email = 'diagtest@example.invalid';

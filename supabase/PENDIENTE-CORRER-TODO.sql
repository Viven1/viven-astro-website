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

-- limpieza: borrar el lead de diagnóstico del test del formulario
delete from public.leads where email = 'diagtest@example.invalid';

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

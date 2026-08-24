-- ============================================================
-- ATRIBUCIÓN DE TRÁFICO — pegar en Supabase → SQL Editor → Run
-- Agrega columnas de origen del visitante a pageviews y prepara
-- leads para atribución de Google Ads (GCLID).
-- Seguro de ejecutar: solo AGREGA columnas, no toca datos.
-- ============================================================

alter table public.pageviews
  add column if not exists referrer     text,     -- dominio de origen, ej. "google.com"
  add column if not exists channel      text,     -- paid_search | paid_social | organic | ai | social | referral | email | direct
  add column if not exists utm_source   text,
  add column if not exists utm_medium   text,
  add column if not exists utm_campaign text,
  add column if not exists utm_term     text,
  add column if not exists utm_content  text,
  add column if not exists gclid        text,     -- Google Ads Click ID
  add column if not exists fbclid       text,     -- Meta/Facebook Click ID
  add column if not exists lang         text,     -- idioma del navegador, ej. "de-CH"
  add column if not exists is_entry     boolean default false;  -- primera página de la sesión (landing)

-- leads: listos para atribución cuando conectemos el formulario
alter table public.leads
  add column if not exists session_id   text,
  add column if not exists channel      text,
  add column if not exists gclid        text,
  add column if not exists utm_source   text,
  add column if not exists utm_campaign text,
  add column if not exists landing_path text,
  add column if not exists lang         text
              check (lang in ('en', 'de', 'es') or lang is null);
              -- idioma en que la persona LEYÓ el sitio (selector EN/DE/ES)
              -- → para newsletters y email automations en su idioma

-- índices para los reportes que vas a querer ver
create index if not exists pageviews_channel_idx on public.pageviews (channel);
create index if not exists pageviews_entry_idx   on public.pageviews (is_entry) where is_entry;
create index if not exists pageviews_gclid_idx   on public.pageviews (gclid)    where gclid is not null;

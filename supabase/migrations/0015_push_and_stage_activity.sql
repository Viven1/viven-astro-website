-- ============================================================================
--  Viven — notificaciones push (Web Push) + actividad de cambio de etapa.
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

-- suscripciones push por dispositivo (cada celular/compu que activa las push)
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_email text,               -- de quién es el dispositivo (sebastian@/sofia@)
  endpoint   text unique not null,
  p256dh     text not null,
  auth       text not null
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_subs_all_auth on public.push_subscriptions;
create policy push_subs_all_auth on public.push_subscriptions for all to authenticated using (true) with check (true);

-- cada cambio de etapa cuenta como actividad (los hitos contacted_at/won_at solo
-- se sellan la primera vez para no romper el funnel; esto se actualiza SIEMPRE)
alter table public.leads add column if not exists last_stage_at timestamptz;

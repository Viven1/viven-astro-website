-- 0108: (A) objetivo mensual de ventas — tabla business_goals (una sola fila, id=1)
--       para el panel "🎯 Ritmo del mes" del tab Hoy (metas vs realidad), y
--       (B) cron del digest diario de la mañana (edge function daily-digest).
--
-- Patrón de settings de una fila: igual que booking_settings (0024) — id=1 con
-- check, seed con on conflict do nothing, RLS all para authenticated (el objetivo
-- de ventas es visible/editable por todo el equipo, como el pipeline; NO es
-- superadmin-only como cashflow).

create table if not exists public.business_goals (
  id             int primary key default 1 check (id = 1),
  monthly_target numeric not null default 0,   -- objetivo de cierre mensual en CHF
  updated_at     timestamptz default now()
);
insert into public.business_goals (id) values (1) on conflict (id) do nothing;
alter table public.business_goals enable row level security;
drop policy if exists business_goals_auth_all on public.business_goals;
create policy business_goals_auth_all on public.business_goals
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- (B) cron del digest diario: L-V 07:00 UTC = 09:00 CH en verano (CEST).
-- En invierno (CET) cae 08:00 local — mismo trade-off que TODOS los crons del
-- repo (0081: horarios fijos en UTC, sin manejo de DST). Si molesta en
-- invierno, ajustar a '0 8 * * 1-5'.
-- Mismo patrón EXACTO de headers que 0081: el CRON_SECRET nunca en texto plano,
-- se resuelve al correr vía Supabase Vault (nombre 'cron_secret').
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('daily-digest-9am'); exception when others then null; end $$;
select cron.schedule('daily-digest-9am', '0 7 * * 1-5', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

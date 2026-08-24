-- 0112: 🧪 Motor de CRO semanal.
-- cro_ideas: 1 fila por semana (week_start = lunes) con las ideas generadas por
-- la función cro-ideas (Anthropic sobre el snapshot REAL de funnels/UX/entradas/
-- A-B/canales) + el snapshot usado, para auditar de dónde salió cada idea.
-- El dashboard (Analytics → 🧪 CRO) lee y marca ideas como hechas/descartadas
-- (status dentro del jsonb ideas[i] — sin tabla extra).
--
-- Correr una vez en el SQL Editor de Supabase. Idempotente.

create table if not exists public.cro_ideas (
  id            bigint generated always as identity primary key,
  week_start    date not null,               -- lunes de la semana (UTC)
  ideas         jsonb not null default '[]', -- [{title,hypothesis,evidence,where,type,effort,impact,how,status?}]
  data_snapshot jsonb,                       -- lo que vio la IA al generar (funnels, ux, entradas, ab, canales)
  created_at    timestamptz not null default now()
);
create unique index if not exists cro_ideas_week_uq on public.cro_ideas (week_start);

alter table public.cro_ideas enable row level security;
-- el dashboard lee y actualiza (marcar hecha/descartada); INSERTA solo la función
-- con service role (bypassa RLS) — el sitio público jamás toca esta tabla.
drop policy if exists cro_ideas_select_auth on public.cro_ideas;
create policy cro_ideas_select_auth on public.cro_ideas
  for select to authenticated using (true);
drop policy if exists cro_ideas_update_auth on public.cro_ideas;
create policy cro_ideas_update_auth on public.cro_ideas
  for update to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Cron semanal: lunes 05:00 UTC (≈ 07:00 CH en verano / 06:00 en invierno —
-- mismo trade-off que TODOS los crons del repo: horario fijo UTC, sin DST).
-- Mismo patrón EXACTO de headers que 0081/0108: el CRON_SECRET nunca en texto
-- plano, se resuelve al correr vía Supabase Vault (nombre 'cron_secret').
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('cro-ideas-weekly'); exception when others then null; end $$;
select cron.schedule('cro-ideas-weekly', '0 5 * * 1', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/cro-ideas',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

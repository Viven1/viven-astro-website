-- 0117: 🩺 Salud del sitemap (función site-health-check), pedido 2026-07-27
-- ("controlá una vez por semana que esté todo bien indexado para evitar
-- problemas a futuro" — tras el audit del 2026-07-26 que encontró 27+15 URLs
-- 404 reales en Search Console sin que nadie lo hubiera notado).
--
-- Google NO expone por API qué está indexado o no (Coverage es solo UI) — lo
-- único que SÍ podemos controlar 100% nosotros, sin depender de Google, es
-- que nuestro PROPIO sitemap nunca apunte a una URL rota. Esa fue la causa
-- raíz de la mayoría de los problemas del audit. site_health_runs guarda una
-- foto semanal de ese chequeo: cuántas URLs del sitemap dan 200 directo,
-- cuántas redirigen (síntoma de sitemap desactualizado — no debería pasar) y
-- cuántas están rotas (404/5xx).
--
-- RLS: solo SELECT para authenticated (mismo patrón 0115/0116) — el insert lo
-- hace la función con el service role.
--
-- Correr una vez en el SQL Editor de Supabase. Idempotente.

create table if not exists public.site_health_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  total int not null default 0,
  ok int not null default 0,
  redirect_count int not null default 0,
  broken_count int not null default 0,
  broken jsonb not null default '[]'::jsonb,      -- [{url, status}]
  redirects jsonb not null default '[]'::jsonb    -- [{url, status, location}]
);
create index if not exists site_health_runs_created_idx on public.site_health_runs (created_at desc);
alter table public.site_health_runs enable row level security;
do $$ begin
  create policy site_health_runs_read on public.site_health_runs
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;
grant select on public.site_health_runs to authenticated;
-- sin policy de escritura a propósito: solo escribe site-health-check con service role

-- ---------------------------------------------------------------------------
-- Cron semanal: lunes 09:30 UTC — 2h20 después de viven-sitemap-submit (SQL
-- 0081, diario 07:10 UTC, la re-envía a Google) y bien después del snapshot
-- de gsc-snapshot de los lunes (SQL 0116, 07:15 UTC): que el sitemap ya haya
-- sido reenviado antes de auditarlo no importa para este chequeo (audita
-- nuestras propias URLs, no a Google), pero mantiene el orden lógico de la
-- mañana de los lunes. Mismo patrón EXACTO de headers que 0113/0115/0116: el
-- CRON_SECRET nunca en texto plano, se resuelve al correr vía Supabase Vault
-- (nombre 'cron_secret').
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('viven-site-health'); exception when others then null; end $$;
select cron.schedule('viven-site-health', '30 9 * * 1', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/site-health-check',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

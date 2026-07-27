-- 0116: 📈 SEO pack del sub-tab Contenido → Search Console (pedido 2026-07-27).
--
-- (1) seo_actions: cola de acciones por página del panel nuevo "📈 Top páginas".
--     "🤖 Mejorar (Claude)" inserta status='requested' → Claude la revisa cada
--     sesión, la trabaja y la pasa a 'done' (mismo patrón que ux_resolutions
--     0115 y las ideas CRO aprobadas). "✓ Hecha" inserta directo status='done'.
--
-- (2) gsc_page_history: tracking a LARGO PLAZO por página — un snapshot semanal
--     (clicks/impresiones/posición/CTR de los últimos 7 días de GSC) para poder
--     graficar la evolución de posición más allá de los 16 meses de ventana que
--     da la API. Lo escribe la función gsc-stats con {snapshot:true} usando el
--     service role (bypassa RLS); el dashboard solo LEE.
--
-- (3) Cron lunes 07:15 UTC que dispara ese snapshot. Mismo patrón EXACTO de
--     vault que 0113/0115: el CRON_SECRET nunca en texto plano, se resuelve al
--     correr vía Supabase Vault (nombre 'cron_secret').
--
-- Correr una vez en el SQL Editor de Supabase. Idempotente.

-- ---------------------------------------------------------------------------
-- (1) cola de acciones SEO por página
-- ---------------------------------------------------------------------------
create table if not exists public.seo_actions (
  id uuid primary key default gen_random_uuid(),
  page text not null,                          -- URL completa como la da GSC
  action_type text not null default 'improve', -- 'improve' (🤖 Claude) | 'manual' (✓ Hecha a mano)
  note text,                                   -- contexto para Claude (métricas del momento)
  status text not null default 'requested',    -- 'requested' → Claude la trabaja → 'done'
  created_by text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists seo_actions_page_idx on public.seo_actions (page, created_at desc);
alter table public.seo_actions enable row level security;
do $$ begin
  create policy seo_actions_auth on public.seo_actions
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
grant select, insert, update, delete on public.seo_actions to authenticated;

-- ---------------------------------------------------------------------------
-- (2) historia semanal por página (snapshot de gsc-stats {snapshot:true})
-- ---------------------------------------------------------------------------
create table if not exists public.gsc_page_history (
  page text not null,
  date date not null,
  clicks int not null default 0,
  impressions int not null default 0,
  position numeric,
  ctr numeric,
  created_at timestamptz not null default now(),
  primary key (page, date)
);
alter table public.gsc_page_history enable row level security;
do $$ begin
  create policy gsc_page_history_read on public.gsc_page_history
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;
grant select on public.gsc_page_history to authenticated;
-- sin policy de escritura a propósito: solo escribe gsc-stats con service role

-- ---------------------------------------------------------------------------
-- (3) cron semanal del snapshot: lunes 07:15 UTC (después del research de
--     keywords de las 05:00 y del cron de reactivación de las 06:30)
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('viven-gsc-snapshot'); exception when others then null; end $$;
select cron.schedule('viven-gsc-snapshot', '15 7 * * 1', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/gsc-stats',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"snapshot":true}'::jsonb
  );
$$);

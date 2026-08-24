-- 0133 — Los datos de Bing al lado de los de Google
--
-- Hasta ahora el dashboard solo mostraba Google Search Console y Bing era una
-- herramienta aparte a la que nadie entra. Bing tiene datos reales de viven.ch
-- desde mayo 2025, así que van a la misma pantalla: un buscador puede estar
-- subiendo mientras el otro no se mueve, y eso solo se ve comparando.
--
-- POR DÍA, igual que gsc_daily: Bing manda la fecha en cada fila. La primera
-- versión de esto guardaba el total del período como si fuera de hoy — 469 días
-- de Bing contra 41 de Google — y eso hacía ver a Bing diez veces mejor de lo
-- que es. Comparar períodos distintos es peor que no comparar.
--
-- La clave de la API va como secret de la function (BING_API_KEY).

drop table if exists public.bing_daily;

create table public.bing_daily (
  id          bigserial primary key,
  date        date not null,
  query       text not null,
  clicks      integer not null default 0,
  impressions integer not null default 0,
  position    numeric,
  updated_at  timestamptz not null default now(),
  unique (date, query)
);

create index if not exists bing_daily_date_idx on public.bing_daily (date desc);
create index if not exists bing_daily_impr_idx on public.bing_daily (impressions desc);

alter table public.bing_daily enable row level security;

drop policy if exists "bing_daily solo miembros" on public.bing_daily;
create policy "bing_daily solo miembros" on public.bing_daily
  for select using (exists (
    select 1 from public.user_roles r
    where lower(r.email) = lower(coalesce(current_setting('request.jwt.claims', true)::json->>'email',''))
  ));

drop policy if exists backup_ro_read on public.bing_daily;
create policy backup_ro_read on public.bing_daily for select to viven_backup_ro using (true);
select cron.schedule('viven-bing-stats', '25 6 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/bing-stats',
    headers := jsonb_build_object('Content-Type','application/json','Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

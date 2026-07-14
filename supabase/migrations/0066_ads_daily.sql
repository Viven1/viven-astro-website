-- 0066: historia diaria de Google Ads (rediseño del tab 🎯).
-- Hoy cada vista del tab re-consulta la API de Google en vivo y no queda ningún
-- registro — sin esto no hay forma de dibujar una tendencia de gasto/leads.
-- Esta tabla la llena ads-conversions-sync (cron diario 06:50, SQL 0035, SIN TOCAR
-- el cron: solo se le agrega código nuevo a la función que ya corre) vía GAQL
-- segmentado por día (segments.date) sobre el mismo recurso `campaign` que ya usa
-- gads-stats. Lectura desde el navegador para la sparkline del tab; escritura
-- siempre por service role (la función edge no pasa por RLS).

create table if not exists public.ads_daily (
  id bigint generated always as identity primary key,
  date date not null,
  campaign_id text not null,
  campaign_name text,
  spend numeric not null default 0,
  clicks int not null default 0,
  impressions int not null default 0,
  conversions numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (date, campaign_id)
);
create index if not exists ads_daily_date_idx on public.ads_daily (date desc);

alter table public.ads_daily enable row level security;
do $$ begin
  create policy "ads_daily_select" on public.ads_daily for select to authenticated using (true);
exception when duplicate_object then null; end $$;

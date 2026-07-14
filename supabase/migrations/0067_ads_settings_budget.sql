-- 0067: presupuesto mensual + estado del sync de conversiones offline, para el
-- rediseño del tab 🎯 (pacing de gasto + botón "Sync ahora" con estado visible
-- en vez del cron invisible de hoy). Aditivo sobre ads_settings (SQL 0037).

alter table public.ads_settings add column if not exists monthly_budget numeric;
alter table public.ads_settings add column if not exists last_sync_at timestamptz;
alter table public.ads_settings add column if not exists last_sync_leads int;
alter table public.ads_settings add column if not exists last_sync_won int;
alter table public.ads_settings add column if not exists last_sync_error text;

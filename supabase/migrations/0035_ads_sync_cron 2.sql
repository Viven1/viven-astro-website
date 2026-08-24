-- 0035: cron diario de ads-conversions-sync — Google Ads 100% automático.
-- Cada mañana (06:50 UTC ≈ 08:50 Zúrich) la función vuelca todas las conversiones
-- offline (leads con gclid + ganados con valor) al Google Sheet que Google Ads
-- importa en su schedule diario. Requiere GOOGLE_REFRESH_TOKEN con scope
-- spreadsheets y el secret ADS_SHEET_ID ya seteados.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('viven-ads-sync');
exception when others then null; end $$;

select cron.schedule('viven-ads-sync', '50 6 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/ads-conversions-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

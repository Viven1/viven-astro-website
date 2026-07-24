-- Sincronización diaria de Bexio → cashflow_entries (modelo Tresio: la
-- proyección se calcula con facturación real). 05:40 UTC, antes de la
-- alerta de cashflow de las 06:17 para que ya use datos frescos.
do $$ begin perform cron.unschedule('viven-bexio-sync'); exception when others then null; end $$;
select cron.schedule('viven-bexio-sync', '40 5 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/bexio-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

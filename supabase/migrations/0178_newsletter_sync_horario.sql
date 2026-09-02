-- 2 sep 2026: el webhook resend-events nunca fue llamado (0 invocaciones en los
-- logs con 44 envíos y 15 aperturas de por medio). Las aperturas/clicks de las
-- ediciones mensuales se traen de Resend cada hora, sin depender del webhook.
select cron.unschedule('viven-newsletter-sync') where exists (select 1 from cron.job where jobname = 'viven-newsletter-sync');
select cron.schedule('viven-newsletter-sync', '23 * * * *', $$
  select net.http_post(url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/newsletter-send', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := '{"sincronizar":true}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

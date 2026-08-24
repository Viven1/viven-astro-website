-- 0081: agrega Authorization: Bearer CRON_SECRET a los cron.job que llaman
-- funciones internas ahora protegidas (auditoría de seguridad 2026-07-14 —
-- ~13 funciones eran invocables por cualquiera sin login vía sbCallFunction,
-- expuesto públicamente en public/assets/site.js). Reprograma cada job
-- IDÉNTICO (mismo schedule, misma url) — solo se agrega el header.
--
-- El secret NUNCA queda en texto plano ni en este archivo (repo público) ni
-- en cron.job.command: cada job lo resuelve en el momento de correr, vía una
-- subquery a Supabase Vault (supabase_vault, ya habilitado) contra el nombre
-- 'cron_secret' — mismo valor que el secret de Edge Functions CRON_SECRET,
-- guardado con `select vault.create_secret('<valor>', 'cron_secret', ...)`.
--
-- NO se toca viven-keyword-research (ai-keywords): decisión deliberada y ya
-- documentada en el propio código — la corrida semanal pelada, sin usuario,
-- es igual de válida porque no lee/escribe nada scoped a una persona.
-- Tampoco se toca viven-ab-autostop: es un UPDATE directo en Postgres, no
-- llama ninguna función HTTP.

do $$ begin perform cron.unschedule('viven-ads-sync'); exception when others then null; end $$;
select cron.schedule('viven-ads-sync', '50 6 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/ads-conversions-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

do $$ begin perform cron.unschedule('viven-cashflow-alert'); exception when others then null; end $$;
select cron.schedule('viven-cashflow-alert', '17 6 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/cashflow-alert',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

do $$ begin perform cron.unschedule('viven-content-engine'); exception when others then null; end $$;
select cron.schedule('viven-content-engine', '30 5 * * 1,3,5', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/content-engine',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

do $$ begin perform cron.unschedule('viven-gmail-sync'); exception when others then null; end $$;
select cron.schedule('viven-gmail-sync', '*/5 * * * *', $$
  select net.http_post(url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/gmail-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb);
$$);

do $$ begin perform cron.unschedule('viven-license-remind'); exception when others then null; end $$;
select cron.schedule('viven-license-remind', '30 6 * * *', $$
  select net.http_post(url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/license-remind',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb);
$$);

do $$ begin perform cron.unschedule('viven-sitemap-submit'); exception when others then null; end $$;
select cron.schedule('viven-sitemap-submit', '10 7 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/gsc-sitemap-submit',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

do $$ begin perform cron.unschedule('viven-stale-remind'); exception when others then null; end $$;
select cron.schedule('viven-stale-remind', '0 7 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/stale-remind',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

do $$ begin perform cron.unschedule('viven-task-remind'); exception when others then null; end $$;
select cron.schedule('viven-task-remind', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/task-remind',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

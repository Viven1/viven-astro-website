-- Los crons que llamaban a su función SIN el cron_secret.
--
-- La auditoría del 14 jul 2026 cerró varias functions con `CRON_SECRET`, pero los crons
-- que las llaman nunca se actualizaron: siguen mandando solo Content-Type. La función
-- contesta 403 y pg_cron registra "succeeded" igual, porque lo que succeeded es el
-- net.http_post, no la respuesta. Un motor muerto que informa que está vivo.
--
-- Medido el 27 ago 2026: gmail-sync y automations-run devuelven 403 llamados así. El
-- último email de info@ que entró al CRM es del 25 ago.
-- (Sebastián: "Hoy no muestra info emails".)
--
-- El patrón correcto ya lo usan los 18 crons que sí andan: el secreto sale del vault.

do $$
declare
  j record;
  fn text;
begin
  for j in
    select jobid, jobname, schedule, command
      from cron.job
     where command ilike '%functions/v1/%'
       and command not ilike '%cron_secret%'
  loop
    fn := substring(j.command from 'functions/v1/([a-z0-9-]+)');
    if fn is null then
      raise notice 'sin function reconocible, se deja como está: %', j.jobname;
      continue;
    end if;

    perform cron.unschedule(j.jobname);
    perform cron.schedule(j.jobname, j.schedule, format($f$
      select net.http_post(
        url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/%s',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
          'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $f$, fn));
    raise notice 'reparado: % → %', j.jobname, fn;
  end loop;
end $$;

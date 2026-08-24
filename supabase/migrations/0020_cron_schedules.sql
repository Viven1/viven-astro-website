-- ============================================================================
--  Viven — schedules de los crons (task-remind cada 5 min, followup-send cada 30)
--  Correr una vez en el SQL Editor. Usa pg_cron + pg_net (mismo patrón que 0001).
--  Para cambiar un horario: select cron.unschedule('viven-task-remind'); y re-crear.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- limpiar si ya existían (idempotente)
do $$ begin
  perform cron.unschedule('viven-task-remind');
exception when others then null; end $$;
do $$ begin
  perform cron.unschedule('viven-followup-send');
exception when others then null; end $$;

-- ⏰ recordatorios de tasks vencidas (push + email) — cada 5 minutos
select cron.schedule('viven-task-remind', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/task-remind',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

-- 📬 follow-ups aprobados al cliente — cada 30 minutos
select cron.schedule('viven-followup-send', '*/30 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/followup-send',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

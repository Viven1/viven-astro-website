-- ============================================================================
--  0026: cron del recordatorio de contactos fríos (stale-remind)
--  1×/día a las ~09:00 de Zúrich (07:00 UTC en verano / 08:00 en invierno).
--  Personas con >5 semanas sin actividad → push al team + task en el contacto.
--  Mismo patrón pg_cron + pg_net que 0020. Correr una vez en el SQL Editor.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('viven-stale-remind');
exception when others then null; end $$;

select cron.schedule('viven-stale-remind', '0 7 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/stale-remind',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

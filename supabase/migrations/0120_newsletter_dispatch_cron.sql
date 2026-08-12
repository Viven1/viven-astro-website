-- ============================================================================
--  0120: ENCIENDE EL DESPACHADOR DEL NEWSLETTER (viven-newsletter-dispatch)
--
--  Hasta ahora el dashboard tenía el selector "Programar fecha y hora", guardaba
--  newsletters.scheduled_at… y no pasaba nada nunca: el cron no existía. La
--  edge function newsletter-dispatch ya estaba escrita y desplegada, sin nadie
--  que la llamara. Pedido de Sebastián (12 ago 2026): encenderla.
--
--  ── HORARIO LABORAL SUIZO ───────────────────────────────────────────────────
--  Nada sale fuera de: lunes a viernes, 09:00–12:00 y 13:30–17:00 hora de Zúrich.
--  EL CORTE DEL MEDIODÍA ES A PROPÓSITO (confirmado por Sebastián): no se
--  unifica en un bloque 09:00–17:00.
--
--  La regla exacta NO está en este cron, está en la edge function
--  (supabase/functions/newsletter-dispatch/index.ts → enHorarioLaboral). Motivo:
--  pg_cron solo entiende UTC, y Zúrich cambia de hora dos veces al año (CET/CEST).
--  Un cron '0 7 * * 1-5' es horario laboral en verano y las 08:00 en invierno.
--  La función lo calcula con Intl en Europe/Zurich, así que el cambio de hora sale
--  bien solo. Una sola fuente de verdad, y del lado que sabe de husos horarios.
--
--  Este cron corre cada 15 minutos dentro de una ventana UTC AMPLIA A PROPÓSITO
--  (05–16 h, lun–vie), que es un superconjunto holgado del horario suizo en
--  cualquiera de las dos estaciones (verano necesita 07–14 h UTC, invierno
--  08–15 h). Solo sirve para no golpear la función de madrugada; quien decide si
--  se manda o no es la función. Fuera de horario contesta {skipped:true} y no
--  manda nada.
--
--  Además la función tiene una GUARDA DE VENCIMIENTO: no despacha nada que esté
--  programado hace más de 48 h. Sin eso, el minuto en que corras esta migración
--  cualquier borrador viejo con scheduled_at en el pasado saldría de golpe a toda
--  la base. Las vencidas quedan reportadas en el log para reprogramarlas a mano.
--
--  AUTORIZACIÓN: mismo patrón que el resto de los crons (ver 0081). El secret
--  nunca queda en texto plano acá ni en cron.job.command — se resuelve en el
--  momento de correr contra Vault, nombre 'cron_secret', el mismo valor que el
--  secret CRON_SECRET de Edge Functions.
--
--  Nota sobre la 0060 (pausa de emails salientes): esto NO reactiva ninguno de
--  los crons pausados ahí. Es un job nuevo e independiente, y sobre todo no
--  "manda por mandar": solo despacha campañas que Sebastián escribió, revisó y
--  programó a mano desde el dashboard. La edición mensual sigue necesitando
--  aprobación humana con sesión del dashboard — ningún cron la puede disparar.
--
--  Idempotente: se puede correr varias veces.
--
--  ── CORRIDA REAL: 12 ago 2026, 21:06 UTC (23:06 Zurich), desde el SQL Editor.
--  Verificado ahi mismo: cron.job tiene viven-newsletter-dispatch activo con
--  '*/15 5-16 * * 1-5'; vault tiene 'cron_secret'; y en las 3 horas previas los
--  demas crons que usan el MISMO header dieron 80 respuestas 200 y cero 401 — o
--  sea que el secret del Vault coincide con el CRON_SECRET de las funciones, que
--  era lo unico que podia fallar en silencio.
--  No se llego a ver una corrida propia del job porque se agendo despues de que
--  cerrara la ventana diaria (21:06 UTC > 16). Primera corrida: 05:00 UTC del dia
--  siguiente; primera ventana real de envio: 09:00 Zurich.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('viven-newsletter-dispatch');
exception when others then null; end $$;

-- también saca el nombre viejo sugerido (sin prefijo) por si alguna vez se corrió
do $$ begin
  perform cron.unschedule('newsletter-dispatch');
exception when others then null; end $$;

select cron.schedule('viven-newsletter-dispatch', '*/15 5-16 * * 1-5', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/newsletter-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

-- Verificación (opcional, no cambia nada):
--   select jobname, schedule, active from cron.job where jobname = 'viven-newsletter-dispatch';
--   select status, return_message, start_time from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'viven-newsletter-dispatch')
--     order by start_time desc limit 5;

-- 0079: cron diario del alerta de Cash Flow (edge function cashflow-alert).
--
-- Corre 1×/día a las 06:17 UTC (~08:17 Zúrich) — horario libre: no choca con
-- viven-license-remind (06:30), viven-ads-sync (06:50), viven-sitemap-submit
-- (07:10) ni viven-review-request/stale-remind (07:00/08:00 aprox).
--
-- Este job es un ALERTA INTERNO DE OPS (liquidez de Viven AG → Sebastián), no
-- toca leads/clientes ni pasa por el Outbox de aprobación. Es un job NUEVO e
-- independiente — NO reactiva ni toca los crons de email a CLIENTES que están
-- pausados desde la SQL 0060 (viven-automations, viven-nurture,
-- viven-followup-send, viven-review-request).

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('viven-cashflow-alert');
exception when others then null; end $$;

select cron.schedule('viven-cashflow-alert', '17 6 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/cashflow-alert',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

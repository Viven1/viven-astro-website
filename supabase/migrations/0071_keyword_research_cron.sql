-- 0071: cron SEMANAL del research de keywords (ai-keywords), en vez de que la
-- parte cara (búsqueda web + Claude, ~6 búsquedas) solo corra cuando alguien
-- aprieta "✨ Buscar oportunidades" a mano. Corre los lunes 05:00 UTC (~07:00
-- Zúrich) y llena/actualiza public.keyword_opportunities (SQL 0070) — el botón
-- manual del dashboard se mantiene igual para una corrida on-demand.
--
-- Job NUEVO e independiente — no toca ninguno de los crons pausados en la
-- SQL 0060 (esos son de emails salientes a clientes; este es un research
-- interno, sin ningún envío a nadie).
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('viven-keyword-research');
exception when others then null; end $$;

select cron.schedule('viven-keyword-research', '0 5 * * 1', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/ai-keywords',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

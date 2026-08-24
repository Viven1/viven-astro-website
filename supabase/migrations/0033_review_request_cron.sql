-- 0033: cron diario del pedido de reseñas Google (review-request).
-- Deals ganados hace ~14 días → email al cliente pidiendo la reseña (motor del
-- ranking local). 1×/día a las ~10:00 CH. Un solo pedido por persona, jamás a
-- emails internos/test. Opcional: supabase secrets set REVIEW_LINK=<link directo GBP>.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('viven-review-request');
exception when others then null; end $$;

select cron.schedule('viven-review-request', '0 8 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/review-request',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

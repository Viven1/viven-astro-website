-- 0031: cron diario del re-submit de sitemaps a Google Search Console.
-- Reemplaza el viejo ping de Google (muerto en 2023): 1×/día a las ~09:15 de
-- Zúrich la función gsc-sitemap-submit re-envía sitemap.xml y video-sitemap.xml
-- vía la API oficial → Google siempre se entera del contenido nuevo, en automático.
-- Requiere el GOOGLE_REFRESH_TOKEN con scope webmasters COMPLETO.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('viven-sitemap-submit');
exception when others then null; end $$;

select cron.schedule('viven-sitemap-submit', '10 7 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/gsc-sitemap-submit',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

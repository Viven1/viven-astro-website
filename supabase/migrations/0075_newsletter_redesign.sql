-- 0075_newsletter_redesign.sql
-- Rediseño del Newsletter: bloques de contenido, programación, tracking de
-- aperturas/clicks por envío e idempotencia real del envío (retomar sin duplicar).
-- Idempotente: se puede correr varias veces sin romper nada.

-- 1) newsletters: bloques ordenados de contenido + programación de envío
alter table public.newsletters add column if not exists blocks jsonb not null default '[]'::jsonb;
alter table public.newsletters add column if not exists scheduled_at timestamptz;   -- null = enviar ahora

-- 2) newsletter_sends: tracking por destinatario (apertura, click, id de Resend)
alter table public.newsletter_sends add column if not exists opened_at  timestamptz;
alter table public.newsletter_sends add column if not exists clicked_at timestamptz;
alter table public.newsletter_sends add column if not exists resend_id  text;

-- 3) idempotencia del envío: un destinatario aparece UNA sola vez por campaña.
--    El índice único es sobre columnas planas (newsletter_id, email) — así el
--    upsert ON CONFLICT (newsletter_id,email) de la edge function lo puede usar
--    (un índice sobre una expresión lower(email) NO sería válido como target de
--    ON CONFLICT). Para que "plano" sea case-insensitive de hecho, primero
--    normalizamos todos los emails a minúsculas (la función siempre inserta en
--    minúsculas de ahora en más) y deduplicamos conservando la fila de menor id.
do $$
begin
  update public.newsletter_sends set email = lower(email) where email <> lower(email);
  delete from public.newsletter_sends a
  using public.newsletter_sends b
  where a.newsletter_id = b.newsletter_id
    and a.email = b.email
    and a.id > b.id;
exception when others then
  raise notice 'normalize/dedupe newsletter_sends omitido: %', sqlerrm;
end $$;

create unique index if not exists newsletter_sends_uniq
  on public.newsletter_sends (newsletter_id, email);

-- índice auxiliar para la atribución influida (recipients que abrieron, por lead)
create index if not exists newsletter_sends_lead_idx
  on public.newsletter_sends (lead_id) where lead_id is not null;

-- 4) SCHEDULING — dispatcher (newsletter-dispatch) que despacha las campañas
--    programadas cuya hora ya pasó. DEJADO A PROPÓSITO SIN ACTIVAR: la política
--    del proyecto es mantener TODOS los crons de email saliente en pausa hasta
--    que el dueño lo active en persona (ver 0060_pause_outbound_email_crons.sql).
--    Para activarlo, descomentar y correr a mano (requiere pg_cron + el secret):
--
-- select cron.schedule(
--   'newsletter-dispatch',
--   '*/15 * * * *',
--   $$ select net.http_post(
--        url:='https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/newsletter-dispatch',
--        headers:=jsonb_build_object('Content-Type','application/json',
--                 'Authorization','Bearer ' || current_setting('app.service_role_key', true)),
--        body:='{}'::jsonb) $$
-- );

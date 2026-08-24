-- 0084: agrega el header Authorization al trigger que dispara lead-notify.
--
-- Contexto (auditoría de seguridad 2026-07-14): lead-notify se guardó exigiendo
-- CRON_SECRET, pero el disparador real NO es un Database Webhook manejado por
-- el Dashboard (Integrations → Webhooks mostraba "No hooks created yet") —
-- es un trigger de Postgres directo (lead_notify_hook → notify_lead()) que
-- llama net.http_post SIN ningún header de auth. Sin este fix, cada INSERT
-- en leads quedaba rechazado con 403 y el email/push instantáneo de nuevo
-- lead dejaba de mandarse en silencio.
--
-- Mismo patrón que 0081: el secret nunca queda en texto plano acá (repo
-- público) — se resuelve en el momento desde Supabase Vault (nombre
-- 'cron_secret', ya creado).

create or replace function public.notify_lead()
returns trigger
language plpgsql
security definer
as $function$
begin
  perform net.http_post(
    url     := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/lead-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := jsonb_build_object('record', to_jsonb(NEW))
  );
  return NEW;
end $function$;

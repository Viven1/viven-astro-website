-- ============================================================================
--  0060: PAUSA TOTAL de emails automáticos a clientes (pedido de Sebastián
--  2026-07-13: "corta todos los emails automatizados hasta que vos y yo lo
--  digamos de vuelta"). Sin bandeja de salida ni modo aprobación, los motores
--  mandaban sin visibilidad. Se re-activan recién cuando exista el Outbox con
--  aprobación por envío.
--
--  SE APAGA (envían emails a CLIENTES):
--    viven-automations     (*/20 min  → automations-run: pasos email de reglas)
--    viven-nurture         (cada hora → nurture: bienvenida + 3d + 7d)
--    viven-followup-send   (*/30 min  → follow-ups programados a leads)
--    viven-review-request  (diario    → pedido de reseña Google 14d post-won)
--  + toggle app_settings.nurture.enabled = false (cinturón y tiradores)
--
--  SIGUE VIVO (interno al equipo / sin email saliente):
--    viven-task-remind, viven-stale-remind (push al equipo), viven-license-remind
--    (recordatorio AL EQUIPO, nunca al cliente), viven-content-engine (borradores
--    de blog + aprobación interna), viven-ads-sync, viven-gmail-sync,
--    viven-sitemap-submit.
--  También siguen: emails transaccionales disparados por el usuario o el cliente
--  (calc-email, brief-email, send-offer manual, confirmación de booking,
--  lead-notify interno) — esos no son "manda por mandar".
--
--  REVERTIR (cuando el Outbox esté aprobado): re-correr los bloques
--  cron.schedule de las migraciones 0041, 0040, 0020 (viven-followup-send)
--  y 0033, y poner app_settings.nurture.enabled = true.
-- ============================================================================

do $$ begin
  perform cron.unschedule('viven-automations');
exception when others then null; end $$;

do $$ begin
  perform cron.unschedule('viven-nurture');
exception when others then null; end $$;

do $$ begin
  perform cron.unschedule('viven-followup-send');
exception when others then null; end $$;

do $$ begin
  perform cron.unschedule('viven-review-request');
exception when others then null; end $$;

update public.app_settings
   set value = jsonb_set(value, '{enabled}', 'false'::jsonb), updated_at = now()
 where key = 'nurture';

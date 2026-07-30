-- Stage nuevo de pipeline "seguimiento_futuro" (Seguimiento futuro): clientes
-- que dijeron que no por ahora pero sí más adelante (ej. en un año). Columnas
-- espejo del patrón ya usado por lost_reason/won_at — ver STAGES en el dashboard.
alter table deals add column if not exists snoozed_at timestamptz;
alter table deals add column if not exists follow_up_target_at timestamptz;
alter table deals add column if not exists follow_up_reason text;
-- idempotencia del cron (deal-followup-later): marca cuándo se generó el
-- borrador para esa fecha objetivo, para no reescribirlo en cada corrida
-- mientras el humano no lo aprueba/descarta ni mueve el deal de etapa.
alter table deals add column if not exists follow_up_drafted_at timestamptz;
create index if not exists deals_follow_up_target_idx on deals (follow_up_target_at) where follow_up_target_at is not null;

-- ---------------------------------------------------------------------------
-- Cron diario 07:00 UTC — barre deals con follow_up_target_at vencido y arma
-- un draft (kind='followup_later') en la bandeja, nunca envía solo. Mismo
-- patrón de headers/Vault que 0113 (reactivation-engine).
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('viven-deal-followup-later'); exception when others then null; end $$;
select cron.schedule('viven-deal-followup-later', '0 7 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/deal-followup-later',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

-- 0113: ♻️ Motor de reactivación por email (función reactivation-engine).
-- Dos vertientes: (a) clientes GANADOS con el último proyecto hace 6+ meses y
-- sin deal abierto → draft personalizado proponiendo retomar; (b) leads
-- PERDIDOS hace 60–90 días → UN único email suave de rescate.
-- Los drafts van a la Bandeja de salida (outbox, kind='reactivation',
-- category='won'|'lost') y esperan aprobación humana — NADA sale solo.
--
-- Idempotencia dura: reactivation_drafted_at se marca al crear el draft y no
-- se resetea nunca en automático — máximo UN intento de reactivación por
-- contacto en su vida (aunque el draft se descarte; si Sebastián quiere
-- reintentar, lo manda a mano desde la ficha o limpia el flag por SQL).
--
-- Correr una vez en el SQL Editor de Supabase. Idempotente.

alter table public.leads add column if not exists reactivation_drafted_at timestamptz;
alter table public.leads add column if not exists reactivation_kind text;   -- 'won' | 'lost'

-- la bandeja consulta pendientes por (status, kind) — el índice parcial de
-- 0063 ya cubre eso; este cubre el chequeo de idempotencia por lead
create index if not exists outbox_reactivation_lead_idx
  on public.outbox (lead_id) where kind = 'reactivation';

-- ---------------------------------------------------------------------------
-- Cron semanal: lunes 06:30 UTC (≈ 08:30 CH en verano / 07:30 en invierno —
-- mismo trade-off que TODOS los crons del repo: horario fijo UTC, sin DST).
-- Solo CREA drafts (nunca envía): el envío real lo hace el pipeline de la
-- bandeja (automations-run sección 3), que ya respeta horario laboral suizo.
-- Mismo patrón EXACTO de headers que 0108/0109/0112: el CRON_SECRET nunca en
-- texto plano, se resuelve al correr vía Supabase Vault (nombre 'cron_secret').
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('viven-reactivation'); exception when others then null; end $$;
select cron.schedule('viven-reactivation', '30 6 * * 1', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/reactivation-engine',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

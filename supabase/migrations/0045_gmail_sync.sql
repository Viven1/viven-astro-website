-- 0045: sync de RESPUESTAS entrantes por Gmail (sebastian@, sofia@, info@viven.ch)
-- hacia email_log, para que el hilo del contacto muestre también lo que el
-- cliente contesta, no solo lo que le mandamos nosotros. Poll cada 5 min
-- (mismo patrón que nurture/automations-run) — nada de Pub/Sub ni push.
-- Requiere autorizar el acceso a las 3 casillas (instrucciones aparte) y
-- setear los secrets GMAIL_REFRESH_TOKEN_{SEBASTIAN,SOFIA,INFO}.

alter table public.email_log add column if not exists direction text not null default 'out';
alter table public.email_log add column if not exists gmail_id text;
create unique index if not exists email_log_gmail_dedupe on public.email_log (source, gmail_id) where gmail_id is not null;

create table if not exists public.gmail_sync_state (
  mailbox text primary key,
  last_synced_at timestamptz not null default now() - interval '1 day'
);
alter table public.gmail_sync_state enable row level security;
do $$ begin
  create policy "gmail_sync_state_auth_all" on public.gmail_sync_state for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin
  perform cron.unschedule('viven-gmail-sync');
exception when others then null; end $$;
select cron.schedule('viven-gmail-sync', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/gmail-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

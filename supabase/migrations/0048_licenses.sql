-- 0048: Licencias/renovaciones — ingreso recurrente de clientes ya ganados
-- (derechos de uso de video, retainers) que hoy no se trackea en ningún lado.
-- Recordatorio automático al equipo (nunca al cliente sin revisar) a -90/-30/0
-- días de la fecha de renovación.

create table if not exists public.licenses (
  id bigint generated always as identity primary key,
  lead_id bigint,
  title text not null,
  amount numeric,
  start_date date,
  renewal_date date not null,
  status text not null default 'active',  -- active | renewed | expired | cancelled
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists licenses_renewal_idx on public.licenses (renewal_date);
create index if not exists licenses_lead_idx on public.licenses (lead_id);
alter table public.licenses enable row level security;
do $$ begin
  create policy "licenses_auth_all" on public.licenses for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin
  perform cron.unschedule('viven-license-remind');
exception when others then null; end $$;
select cron.schedule('viven-license-remind', '30 6 * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/license-remind',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

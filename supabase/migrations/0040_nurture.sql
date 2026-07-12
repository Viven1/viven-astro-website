-- 0040: nurture automático (lifecycle automation estilo Keap).
-- Paso 1: bienvenida ~20-60 min tras el lead (siempre). Pasos 2 (+3d) y 3 (+7d):
-- solo si el lead sigue en etapa 'nuevo' y el toggle 🌱 está ON.
-- nurture_log garantiza máximo 1 email por paso, para siempre.

create table if not exists public.nurture_log (
  id bigint generated always as identity primary key,
  lead_id bigint not null,
  step int not null,
  created_at timestamptz not null default now(),
  unique (lead_id, step)
);
alter table public.nurture_log enable row level security;
do $$ begin
  create policy "nurture_log_r" on public.nurture_log for select to authenticated using (true);
exception when duplicate_object then null; end $$;

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
do $$ begin
  create policy "app_settings_rw" on public.app_settings for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
insert into public.app_settings (key, value) values ('nurture', '{"enabled": true}') on conflict (key) do nothing;

-- SELLADO: los leads que ya existen al correr esta migración NO reciben la
-- secuencia retroactivamente (sería raro recibir "recibimos tu consulta" días
-- después). Se marcan los 3 pasos como ya-enviados; solo los leads NUEVOS
-- a partir de ahora entran al nurture desde cero.
insert into public.nurture_log (lead_id, step)
  select id, s from public.leads cross join (values (1),(2),(3)) as steps(s)
  where created_at < now()
on conflict (lead_id, step) do nothing;

create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin
  perform cron.unschedule('viven-nurture');
exception when others then null; end $$;
select cron.schedule('viven-nurture', '15 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/nurture',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

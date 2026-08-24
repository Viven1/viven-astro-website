-- 0041: AUTOMATIZACIONES (constructor "si esto → hacé aquello" estilo Keap).
-- automations: la regla (trigger + config + pasos del camino A y B con split A/B).
-- automation_runs: cada lead inscripto, en qué paso va y cuándo toca el próximo.
-- El motor (función automations-run, cron cada 20 min) inscribe y ejecuta.

create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  enabled boolean not null default false,
  trigger text not null default 'lead_new',        -- lead_new | stage | inactivity
  trigger_config jsonb not null default '{}',       -- {stage, days, source, lang, channel}
  ab_split int not null default 0,                  -- 0 = solo camino A; 50 = mitad va por B
  steps_a jsonb not null default '[]',              -- [{type:email|wait|task|push|status, ...}]
  steps_b jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.automations enable row level security;
do $$ begin
  create policy "automations_rw" on public.automations for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create table if not exists public.automation_runs (
  id bigint generated always as identity primary key,
  automation_id uuid not null references public.automations(id) on delete cascade,
  lead_id bigint not null,
  variant text not null default 'a',
  step_idx int not null default 0,
  next_at timestamptz not null default now(),
  status text not null default 'active',            -- active | done | stopped
  created_at timestamptz not null default now(),
  unique (automation_id, lead_id)
);
alter table public.automation_runs enable row level security;
do $$ begin
  create policy "automation_runs_r" on public.automation_runs for select to authenticated using (true);
exception when duplicate_object then null; end $$;

create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin
  perform cron.unschedule('viven-automations');
exception when others then null; end $$;
select cron.schedule('viven-automations', '*/20 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/automations-run',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);

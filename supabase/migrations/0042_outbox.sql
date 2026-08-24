-- 0042: BANDEJA DE SALIDA + frenos globales (v2 del motor de automatizaciones).
-- outbox: borradores escritos por IA que esperan aprobación humana antes de salir.
-- leads.last_automated_email_at: throttling global (máx 1 email automático / 5 días).
-- leads.last_reply_at: botón "✉️ Respondió" — conversación viva = robots afuera.

create table if not exists public.outbox (
  id uuid primary key default gen_random_uuid(),
  lead_id bigint not null,
  automation_id uuid,
  run_id bigint,
  sender text not null default 'team',            -- sofia | sebastian | team (editable antes de aprobar)
  subject text not null default '',
  body text not null default '',
  status text not null default 'pending',         -- pending | approved | sent | discarded | failed
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.outbox enable row level security;
do $$ begin
  create policy "outbox_rw" on public.outbox for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

alter table public.leads add column if not exists last_automated_email_at timestamptz;
alter table public.leads add column if not exists last_reply_at timestamptz;

-- ============================================================================
--  Viven — notas y tasks por lead (para trabajar la venta desde el lead)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

create table if not exists public.lead_notes (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  lead_id    text not null,
  author     text,
  body       text not null,
  mention    text                       -- a quién se avisó (email del team)
);
alter table public.lead_notes enable row level security;
drop policy if exists lead_notes_all_auth on public.lead_notes;
create policy lead_notes_all_auth on public.lead_notes for all to authenticated using (true) with check (true);
create index if not exists lead_notes_lead_idx on public.lead_notes (lead_id);

create table if not exists public.lead_tasks (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  lead_id    text not null,
  title      text not null,
  due_date   date,
  assignee   text,                       -- email del team responsable
  done       boolean not null default false,
  done_at    timestamptz,
  reminded   boolean not null default false  -- para el cron de recordatorios
);
alter table public.lead_tasks enable row level security;
drop policy if exists lead_tasks_all_auth on public.lead_tasks;
create policy lead_tasks_all_auth on public.lead_tasks for all to authenticated using (true) with check (true);
create index if not exists lead_tasks_lead_idx on public.lead_tasks (lead_id);
create index if not exists lead_tasks_due_idx on public.lead_tasks (due_date) where done = false;

-- ============================================================================
--  Viven — sistema de follow-up: tabla de briefs + registro de outreach
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

-- El lead completa el brief en /brief → se guarda acá
create table if not exists public.briefs (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  lead_id      text,
  lang         text,
  name         text,
  email        text,
  goal         text,
  distribution text,
  timeline     text,
  budget       text,
  extra        text
);
alter table public.briefs enable row level security;

-- anon (el lead, con la publishable key) puede INSERTAR; solo usuarios logueados LEEN
drop policy if exists briefs_insert_anon on public.briefs;
create policy briefs_insert_anon on public.briefs for insert to anon with check (true);
drop policy if exists briefs_select_auth on public.briefs;
create policy briefs_select_auth on public.briefs for select to authenticated using (true);

-- cuándo se le mandó el último email de outreach al lead
alter table public.leads add column if not exists last_outreach_at timestamptz;

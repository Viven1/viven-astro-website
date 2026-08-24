-- ============================================================================
--  Viven — follow-ups automáticos al CLIENTE (secuencia aprobable/editable)
--  + archivar propuestas. Correr una vez en el SQL Editor. Idempotente.
-- ============================================================================

-- cada fila = un email de follow-up programado para un lead
create table if not exists public.lead_followups (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  lead_id    text not null,
  position   int  not null default 1,        -- nº en la secuencia (1, 2, 3…)
  subject    text not null,
  body       text not null,
  send_at    timestamptz not null,           -- cuándo se manda (editable)
  status     text not null default 'draft',  -- draft | approved | sent | canceled
  sent_at    timestamptz,
  sender_key text default 'sofia'            -- de quién sale (reply-to)
);
alter table public.lead_followups enable row level security;
drop policy if exists lead_followups_all_auth on public.lead_followups;
create policy lead_followups_all_auth on public.lead_followups for all to authenticated using (true) with check (true);
create index if not exists lead_followups_lead_idx on public.lead_followups (lead_id);
create index if not exists lead_followups_due_idx on public.lead_followups (send_at) where status = 'approved';

-- archivar propuestas (las ofertas ya tienen archived)
alter table public.proposals add column if not exists archived boolean not null default false;

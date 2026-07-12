-- 0039: newsletter con segmentación (tab 📰 del dashboard).
-- Campañas + log de envíos + flag de baja en leads. Envío vía Resend
-- (newsletter-send); baja de un click (newsletter-unsub, sin login).

create table if not exists public.newsletters (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  body text not null default '',
  segment_stage text not null default 'all',   -- all | won | open
  segment_lang text not null default 'all',    -- all | en | de | es
  status text not null default 'draft',        -- draft | sent
  sent_at timestamptz,
  sent_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.newsletters enable row level security;
do $$ begin
  create policy "newsletters_rw" on public.newsletters for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create table if not exists public.newsletter_sends (
  id bigint generated always as identity primary key,
  newsletter_id uuid references public.newsletters(id) on delete cascade,
  lead_id bigint,
  email text not null,
  status text not null default 'sent',
  created_at timestamptz not null default now()
);
alter table public.newsletter_sends enable row level security;
do $$ begin
  create policy "newsletter_sends_r" on public.newsletter_sends for select to authenticated using (true);
exception when duplicate_object then null; end $$;

alter table public.leads add column if not exists unsubscribed boolean not null default false;

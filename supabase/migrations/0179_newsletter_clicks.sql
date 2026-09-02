-- 2 sep 2026: qué link tocó cada persona en el newsletter (Sebastián: "mostrá qué
-- botones tocaron"). Una fila por click; el "clickeó/no clickeó" sigue en
-- newsletter_sends.clicked_at.
create table if not exists public.newsletter_clicks (
  id bigserial primary key,
  newsletter_id uuid references public.newsletters(id) on delete cascade,
  issue_id uuid references public.newsletter_issues(id) on delete cascade,
  email text not null,
  lead_id bigint,
  link text not null,
  at timestamptz not null default now(),
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists newsletter_clicks_issue_idx on public.newsletter_clicks (issue_id, at desc);
create index if not exists newsletter_clicks_nl_idx on public.newsletter_clicks (newsletter_id, at desc);
alter table public.newsletter_clicks enable row level security;
-- el dashboard lee (misma regla que newsletter_sends: is_member()); escribe solo el
-- service role desde resend-events. Y el rol del respaldo diario la lee también:
-- nada nuevo queda afuera del backup.
drop policy if exists "newsletter_clicks_r" on public.newsletter_clicks;
create policy "newsletter_clicks_r" on public.newsletter_clicks for select to authenticated using (is_member());
drop policy if exists "backup_ro_read" on public.newsletter_clicks;
create policy "backup_ro_read" on public.newsletter_clicks for select to viven_backup_ro using (true);
grant select on public.newsletter_clicks to viven_backup_ro;

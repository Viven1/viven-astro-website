-- 0030: A/B testing propio.
-- ab_tests: la definición (URL, cambios de la variante B, split, fechas, estado).
-- ab_hits: exposiciones (quién vio qué variante) — tabla aparte para NO tocar pageviews.
-- leads.ab: con qué variantes convirtió el lead ("12:b,15:a").
-- Estados: draft → running → done_a (ganó original) | done_b (ganó variante, se sirve al 100%).

create table if not exists public.ab_tests (
  id          bigint generated always as identity primary key,
  name        text,
  url_path    text not null,               -- p. ej. /en/services/brand-video/
  status      text not null default 'draft',
  split_pct   numeric not null default 50, -- % del tráfico que ve la variante B
  changes     jsonb not null default '[]', -- [{sel, idx, type: text|html|src|attr, name?, from, to}]
  start_at    timestamptz,
  end_at      timestamptz,
  notes       text,
  created_at  timestamptz not null default now()
);
alter table public.ab_tests enable row level security;
drop policy if exists ab_tests_auth_all on public.ab_tests;
create policy ab_tests_auth_all on public.ab_tests for all to authenticated using (true) with check (true);
drop policy if exists ab_tests_anon_read on public.ab_tests;
create policy ab_tests_anon_read on public.ab_tests for select to anon using (status in ('running', 'done_b'));

create table if not exists public.ab_hits (
  id          bigint generated always as identity primary key,
  test_id     bigint not null,
  bucket      text not null,               -- a | b
  session_id  text,
  path        text,
  created_at  timestamptz not null default now()
);
alter table public.ab_hits enable row level security;
drop policy if exists ab_hits_anon_insert on public.ab_hits;
create policy ab_hits_anon_insert on public.ab_hits for insert to anon with check (true);
drop policy if exists ab_hits_auth_read on public.ab_hits;
create policy ab_hits_auth_read on public.ab_hits for select to authenticated using (true);

alter table public.leads add column if not exists ab text;

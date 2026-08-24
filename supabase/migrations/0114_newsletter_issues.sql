-- 0114: 📬 Newsletter mensual automática (newsletter_issues, con aprobación humana).
-- newsletter-builder arma el DRAFT (mejores posts del período por pageviews +
-- 1 proyecto destacado rotando sin repetir, copy IA en EN/DE/ES) → aparece en
-- Contenido → Newsletter del dashboard → recién al APROBAR (click humano, JWT)
-- se envía vía newsletter-send { issue_id }, cada suscriptor EN SU idioma y con
-- su link de baja. NADA se envía solo: el cron solo CREA el draft (no viola la
-- política 0060 de crons de email saliente — acá el envío siempre es un click).
--
-- Cron: primer MARTES del mes, 07:00 UTC. En cron estándar día-del-mes y
-- día-de-semana se OR-ean, así que corremos los días 1-7 y filtramos dow=2 en
-- el SQL. El builder además es idempotente por mes (máx. 1 issue activo).
--
-- Correr una vez en el SQL Editor de Supabase. Idempotente.

create table if not exists public.newsletter_issues (
  id uuid primary key default gen_random_uuid(),
  month text not null,                          -- 'YYYY-MM'
  status text not null default 'draft',         -- draft | sent | discarded
  content jsonb not null default '{}'::jsonb,   -- { en: {subject, html, posts[], ai}, de: …, es: … }
  project_key text,                             -- slug del proyecto destacado (rotación sin repetir)
  meta jsonb not null default '{}'::jsonb,      -- ranking usado, forced_by, etc.
  approved_by text,                             -- email del usuario que aprobó el envío
  sent_at timestamptz,
  sent_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists newsletter_issues_month_idx on public.newsletter_issues (month);
alter table public.newsletter_issues enable row level security;
do $$ begin
  create policy "newsletter_issues_rw" on public.newsletter_issues for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- log de envíos: reusamos newsletter_sends (0039/0075) agregando la referencia
-- al issue. El índice único parcial (issue_id, email) da la MISMA idempotencia
-- que newsletter_sends_uniq le da a las campañas: un envío cortado a la mitad
-- se retoma sin duplicar a nadie (upsert ON CONFLICT (issue_id,email)).
alter table public.newsletter_sends
  add column if not exists issue_id uuid references public.newsletter_issues(id) on delete set null;
create unique index if not exists newsletter_sends_issue_uniq
  on public.newsletter_sends (issue_id, email) where issue_id is not null;

-- ranking server-side: views por path de blog en los últimos N días (el builder
-- no puede bajar todas las pageviews — PostgREST corta en ~1000 filas)
create or replace function public.newsletter_top_blog_paths(days int default 45)
returns table(path text, views bigint)
language sql security definer set search_path = public as $$
  select path, count(*)::bigint as views
  from pageviews
  where created_at >= now() - (days||' days')::interval and path like '%blog%'
  group by path
  order by count(*) desc
  limit 200;
$$;
revoke all on function public.newsletter_top_blog_paths(int) from public, anon;
grant execute on function public.newsletter_top_blog_paths(int) to service_role, authenticated;

-- ---------------------------------------------------------------------------
-- Cron mensual: primer martes 07:00 UTC (≈ 09:00 CH verano / 08:00 invierno).
-- Mismo patrón EXACTO de headers que 0108/0109/0112/0113: el CRON_SECRET nunca
-- en texto plano — se resuelve al correr vía Supabase Vault ('cron_secret').
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('viven-newsletter-builder'); exception when others then null; end $$;
select cron.schedule('viven-newsletter-builder', '0 7 1-7 * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/newsletter-builder',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  )
  where extract(dow from now()) = 2;   -- solo el primer MARTES del mes
$$);

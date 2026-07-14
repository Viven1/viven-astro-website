-- 0069: rediseño del sub-tab Search Console (Analytics → 🔎).
-- Dos tablas chicas y autocontenidas, pensadas para no chocar con un futuro
-- "SEO Keyword Manager" (keyword_opportunities / cron semanal) — esto es solo
-- el snapshot diario que ya usa el tab de Analytics, nada de research/competencia.
--
-- public.gsc_daily: historia diaria de las queries top (por impresiones) de
-- Search Console. Hoy el tab SEO no guarda nada — cada vista son 3 llamadas
-- en vivo a Google y CERO tendencia. La llena gsc-sitemap-submit (cron diario
-- 07:10 UTC, SQL 0031 — NO se toca el cron, solo se le agrega código a la
-- función que ya corre), acotado a las ~50 queries con más impresiones por día
-- para no acumular una tabla infinita. Lectura desde el navegador (RLS abajo);
-- escritura siempre por service role (la función edge no pasa por RLS).
create table if not exists public.gsc_daily (
  id bigint generated always as identity primary key,
  date date not null,
  query text not null,
  clicks int not null default 0,
  impressions int not null default 0,
  position numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (date, query)
);
create index if not exists gsc_daily_date_idx on public.gsc_daily (date desc);
create index if not exists gsc_daily_query_idx on public.gsc_daily (query);

alter table public.gsc_daily enable row level security;
do $$ begin
  create policy "gsc_daily_select" on public.gsc_daily for select to authenticated using (true);
exception when duplicate_object then null; end $$;

-- public.gsc_status: única fila con la "foto" del estado de indexación, para
-- que el tab deje de ser ciego respecto de si el sitemap/IndexNow realmente
-- funcionan. La llena la misma corrida de gsc-sitemap-submit: resultado del
-- resubmit de sitemaps + (best-effort) spot-check con la URL Inspection API
-- de un puñado de páginas clave (los 4 home por idioma).
create table if not exists public.gsc_status (
  id int primary key default 1,
  last_sitemap_at timestamptz,
  last_sitemap_results jsonb,
  last_urlcheck_at timestamptz,
  last_urlcheck_results jsonb,
  updated_at timestamptz not null default now(),
  constraint gsc_status_single_row check (id = 1)
);

alter table public.gsc_status enable row level security;
do $$ begin
  create policy "gsc_status_select" on public.gsc_status for select to authenticated using (true);
exception when duplicate_object then null; end $$;

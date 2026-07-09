-- ============================================================
-- VIVEN.CH — Supabase schema
-- Pegar completo en: Supabase panel → SQL Editor → Run
-- Crea: leads, pageviews, video_stats (+ RLS e índices)
-- ============================================================

-- ---------- 1. LEADS (formulario de contacto) ----------
create table if not exists public.leads (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  name        text not null,
  email       text not null,
  message     text,
  status      text not null default 'new'
              check (status in ('new', 'contacted', 'qualified', 'won', 'lost'))
);

-- ---------- 2. PAGEVIEWS (analítica propia) ----------
create table if not exists public.pageviews (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  path        text not null,
  device      text check (device in ('mobile', 'tablet', 'desktop')),
  session_id  text not null,
  duration    integer check (duration >= 0)   -- segundos en la página
);

-- ---------- 3. VIDEO_STATS (engagement de videos Vimeo) ----------
create table if not exists public.video_stats (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  video_id          text not null,             -- ID de Vimeo, ej. "1057568537"
  watch_percentage  smallint not null check (watch_percentage between 0 and 100),
  session_id        text not null
);

-- ---------- Índices para consultas frecuentes ----------
create index if not exists leads_created_at_idx      on public.leads (created_at desc);
create index if not exists leads_status_idx          on public.leads (status);
create index if not exists pageviews_path_idx        on public.pageviews (path);
create index if not exists pageviews_created_at_idx  on public.pageviews (created_at desc);
create index if not exists pageviews_session_idx     on public.pageviews (session_id);
create index if not exists video_stats_video_idx     on public.video_stats (video_id);
create index if not exists video_stats_created_idx   on public.video_stats (created_at desc);

-- ---------- Seguridad (RLS) ----------
-- El sitio usa la "anon" key públicamente: los visitantes solo pueden
-- INSERTAR datos, nunca leer/modificar/borrar lo de otros.
-- Tú lees todo desde el panel de Supabase (service_role la ignora).

alter table public.leads       enable row level security;
alter table public.pageviews   enable row level security;
alter table public.video_stats enable row level security;

create policy "anon can insert leads"
  on public.leads for insert
  to anon
  with check (true);

create policy "anon can insert pageviews"
  on public.pageviews for insert
  to anon
  with check (true);

create policy "anon can insert video_stats"
  on public.video_stats for insert
  to anon
  with check (true);

-- (Sin policies de SELECT/UPDATE/DELETE para anon = prohibido por defecto)

-- ============================================================================
--  Viven — tracking de reproducciones de video (qué videos abre cada sesión)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
--  El % visto se agrega en una próxima etapa (necesita eventos de progreso del player).
-- ============================================================================

create table if not exists public.video_plays (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  session_id text,
  video_id   text,
  label      text,
  lang       text
);
alter table public.video_plays enable row level security;

-- anon (el sitio, con la publishable key) inserta; solo usuarios logueados leen
drop policy if exists video_plays_insert_anon on public.video_plays;
create policy video_plays_insert_anon on public.video_plays for insert to anon with check (true);
drop policy if exists video_plays_select_auth on public.video_plays;
create policy video_plays_select_auth on public.video_plays for select to authenticated using (true);

create index if not exists video_plays_session_idx on public.video_plays (session_id);
create index if not exists video_plays_video_idx on public.video_plays (video_id);

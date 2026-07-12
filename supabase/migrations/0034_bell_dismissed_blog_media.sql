-- 0034: dos mejoras de la mañana.
-- 1) bell_dismissed: notificaciones descartadas con la ✕ persistidas en la BASE
--    (antes era por dispositivo → reaparecían en el otro; ahora mueren para siempre).
-- 2) blogs: media del motor de contenido (hero image siempre, video cuando aplica)
--    + approve_token para PUBLICAR DESDE EL EMAIL con un click.

create table if not exists public.bell_dismissed (
  user_email  text not null default '',
  key         text not null,
  created_at  timestamptz default now(),
  primary key (user_email, key)
);
alter table public.bell_dismissed enable row level security;
drop policy if exists bd_auth_all on public.bell_dismissed;
create policy bd_auth_all on public.bell_dismissed for all to authenticated using (true) with check (true);

alter table public.blogs add column if not exists hero_image text;
alter table public.blogs add column if not exists video_id text;
alter table public.blogs add column if not exists approve_token text;

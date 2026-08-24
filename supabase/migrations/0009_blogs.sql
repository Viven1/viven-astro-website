-- ============================================================================
--  Viven — blogs generados con IA (lista + versiones por idioma)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
--  group_id enlaza las versiones del mismo artículo en distintos idiomas.
-- ============================================================================

create table if not exists public.blogs (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  group_id      uuid not null default gen_random_uuid(),
  lang          text not null default 'en',
  slug          text,
  topic         text,
  title         text,
  description   text,
  eyebrow       text,
  lead          text,
  body_html     text,
  faq           jsonb,
  status        text not null default 'draft',   -- draft | published
  published_at  timestamptz,
  published_url text
);
alter table public.blogs enable row level security;

drop policy if exists blogs_all_auth on public.blogs;
create policy blogs_all_auth on public.blogs for all to authenticated using (true) with check (true);

create index if not exists blogs_group_idx on public.blogs (group_id);

create or replace function public.touch_blogs_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_blogs_touch on public.blogs;
create trigger trg_blogs_touch before update on public.blogs
  for each row execute function public.touch_blogs_updated_at();

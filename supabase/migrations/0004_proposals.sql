-- ============================================================================
--  Viven — Propuestas tipo Qwilr dentro de viven.ch (con password + accept)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
--
--  SEGURIDAD: el rol anon NO tiene acceso a esta tabla. Todo pasa por las
--  Edge Functions get-proposal / accept-proposal (service role), que validan
--  el password antes de devolver el contenido. Así ni la propuesta ni los
--  precios se pueden leer sin la clave.
-- ============================================================================

create table if not exists public.proposals (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  slug          text not null unique,          -- va en la URL pública
  password      text not null,                 -- clave que se le manda al cliente
  offer_id      bigint,                         -- opcional: oferta de la que salió
  lead_id       text,
  title         text,
  client_name   text,
  client_email  text,
  content       jsonb not null default '{}'::jsonb,  -- intro, overview, scope, tiers[], addon_groups[], sender, vat_rate…
  status        text not null default 'draft',       -- draft | sent | accepted
  views         int not null default 0,
  accepted_at   timestamptz,
  accepted_name text,
  accepted_email text,
  accepted_tier text,
  accepted_addons jsonb,
  accepted_total numeric
);

alter table public.proposals enable row level security;

-- SOLO el dashboard logueado puede ver/crear/editar. El público NUNCA toca la tabla
-- directo: usa las Edge Functions (service role). Por eso no hay policy para anon.
drop policy if exists proposals_all_auth on public.proposals;
create policy proposals_all_auth on public.proposals
  for all to authenticated using (true) with check (true);

create or replace function public.touch_proposals_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_proposals_touch on public.proposals;
create trigger trg_proposals_touch before update on public.proposals
  for each row execute function public.touch_proposals_updated_at();

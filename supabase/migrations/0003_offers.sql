-- ============================================================================
--  Viven — Offer creation tool: tabla de ofertas (Kostenkalkulation)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

create table if not exists public.offers (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  title       text,
  client      text,
  lead_id     text,                       -- opcional: ligar la oferta a un lead
  currency    text not null default 'CHF',
  vat_rate    numeric not null default 8.1,
  status      text not null default 'draft',   -- draft | sent | won | lost
  items       jsonb not null default '[]'::jsonb, -- [{phase,name,qty,unit,price,cost}]
  notes       text
);

alter table public.offers enable row level security;

-- solo usuarios logueados del dashboard pueden ver/crear/editar/borrar ofertas
drop policy if exists offers_all_auth on public.offers;
create policy offers_all_auth on public.offers
  for all to authenticated using (true) with check (true);

-- mantener updated_at al día
create or replace function public.touch_offers_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_offers_touch on public.offers;
create trigger trg_offers_touch before update on public.offers
  for each row execute function public.touch_offers_updated_at();

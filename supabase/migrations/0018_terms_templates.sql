-- ============================================================================
--  Viven — términos especiales en ofertas + templates reutilizables
--  (los terms de propuestas van dentro de content JSON, no necesitan columna)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

alter table public.offers    add column if not exists terms       text;
alter table public.offers    add column if not exists is_template boolean not null default false;
alter table public.proposals add column if not exists is_template boolean not null default false;

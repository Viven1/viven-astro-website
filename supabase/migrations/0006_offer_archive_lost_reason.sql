-- ============================================================================
--  Viven — archivar ofertas + motivo de pérdida de leads
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

alter table public.offers add column if not exists archived boolean not null default false;
alter table public.leads  add column if not exists lost_reason text;

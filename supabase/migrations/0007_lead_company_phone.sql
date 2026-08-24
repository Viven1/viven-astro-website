-- ============================================================================
--  Viven — datos de contacto extra en leads (empresa + teléfono)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

alter table public.leads add column if not exists company text;
alter table public.leads add column if not exists phone   text;

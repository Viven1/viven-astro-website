-- ============================================================================
--  Viven — valor estimado del deal en el contacto (cuando todavía no hay oferta).
--  El board de Deals y el forecast usan este valor hasta que exista una oferta.
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

alter table public.leads add column if not exists deal_value numeric;

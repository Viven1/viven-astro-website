-- ============================================================================
--  Viven — en qué página convirtió el lead (form de la página del servicio,
--  no solo /contact). Clave para saber qué servicio/página genera leads.
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

alter table public.leads add column if not exists form_path text;

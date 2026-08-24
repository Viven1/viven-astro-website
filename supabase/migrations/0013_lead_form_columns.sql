-- ============================================================================
--  Viven — asegurar TODAS las columnas que manda el formulario de contacto.
--  El form quedó roto porque faltaba 'phone' en leads. Esto es idempotente:
--  corré una vez en el SQL Editor de Supabase y agrega solo lo que falte.
--  (El form igual ya es a prueba de fallos, pero así se guardan TODOS los datos.)
-- ============================================================================

alter table public.leads add column if not exists phone         text;
alter table public.leads add column if not exists company       text;
alter table public.leads add column if not exists first_name    text;
alter table public.leads add column if not exists last_name     text;
alter table public.leads add column if not exists session_id    text;
alter table public.leads add column if not exists lang          text;
alter table public.leads add column if not exists channel       text;
alter table public.leads add column if not exists gclid         text;
alter table public.leads add column if not exists utm_source    text;
alter table public.leads add column if not exists utm_campaign  text;
alter table public.leads add column if not exists landing_path  text;

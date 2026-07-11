-- ============================================================================
--  Viven — Funnel: timestamps de hito por etapa (para conversión y tiempos)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
--  El dashboard sella cada columna cuando arrastrás el lead a esa etapa.
-- ============================================================================

alter table public.leads add column if not exists contacted_at timestamptz;
alter table public.leads add column if not exists videocall_at timestamptz;
alter table public.leads add column if not exists proposal_at  timestamptz;
alter table public.leads add column if not exists won_at       timestamptz;
alter table public.leads add column if not exists lost_at      timestamptz;

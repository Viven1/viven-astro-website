-- ============================================================================
--  Viven — Companies (empresas). Modelo HubSpot: los leads (personas) pertenecen
--  a una empresa vía el dominio del email. Esta tabla guarda los datos editables
--  de cada empresa (nombre, industria, web, etc.). Las personas se agrupan por dominio.
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

create table if not exists public.companies (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  domain     text unique,        -- clave: dominio del email (ap-live.co.uk)
  name       text,
  industry   text,
  website    text,
  phone      text,
  owner      text,
  type       text,               -- Cliente / Prospecto / Partner…
  city       text,
  employees  text,               -- rango o número (texto para flexibilidad)
  linkedin   text,
  notes      text                -- descripción / notas internas
);
-- por si la tabla ya existía de una corrida previa: agregar columnas nuevas
alter table public.companies add column if not exists type      text;
alter table public.companies add column if not exists city      text;
alter table public.companies add column if not exists employees text;
alter table public.companies add column if not exists linkedin  text;
alter table public.companies enable row level security;
drop policy if exists companies_all_auth on public.companies;
create policy companies_all_auth on public.companies for all to authenticated using (true) with check (true);

-- rol/cargo de la persona dentro de la empresa (financial, project manager, etc.)
alter table public.leads add column if not exists job_title text;

create or replace function public.touch_companies_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_companies_touch on public.companies;
create trigger trg_companies_touch before update on public.companies
  for each row execute function public.touch_companies_updated_at();

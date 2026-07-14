-- 0064: perfil por usuario del equipo (foto + firma) — reemplaza de a poco los
-- mapas hardcodeados FROMS/SENDERS/TEAM como fuente de verdad. Mientras una
-- persona no tenga fila acá, el código sigue usando el hardcode de siempre
-- (additive/backward-compat, mismo patrón defensivo que el resto del archivo).
--
-- NOTA IMPORTANTE (no lo puede hacer esta migración): para que la foto de
-- perfil funcione hay que crear a mano, una sola vez, en Supabase Dashboard →
-- Storage, un bucket PÚBLICO llamado "team-avatars" (las migraciones SQL no
-- pueden crear buckets de Storage). Sin ese bucket, el dashboard sigue andando
-- normalmente — el upload de foto simplemente fallará con un toast de error y
-- el resto del perfil (nombre/rol/teléfono/firma) se guarda igual.

create table if not exists public.team_profiles (
  email           text primary key,
  name            text,
  role            text,
  phone           text,
  signature_text  text,
  avatar_url      text,
  updated_at      timestamptz not null default now()
);
alter table public.team_profiles enable row level security;
do $$ begin
  create policy "team_profiles_auth_all" on public.team_profiles for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

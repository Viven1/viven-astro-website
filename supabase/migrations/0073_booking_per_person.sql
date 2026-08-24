-- 0073: Booking por persona — MITAD INTERNA (base de datos + dashboard).
-- Deja LISTO el modelo por-persona; la ruta pública /book/[persona] y el selector
-- quedan DIFERIDOS (necesitan OK humano del dueño + un Google Calendar por persona).
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- Correr:  supabase db query --linked -f supabase/migrations/0073_booking_per_person.sql

-- 1) booking_settings: de fila única (id=1) a UNA FILA POR PERSONA (por email).
--    La fila id=1 SIGUE siendo el DEFAULT GLOBAL que leen las edge functions
--    booking-slots / booking-create (ambas hacen .eq("id",1)). No se toca.
alter table public.booking_settings drop constraint if exists booking_settings_id_check;
alter table public.booking_settings add column if not exists email text;

-- El id debe AUTO-asignarse para las filas nuevas por-persona: si quedara el
-- `default 1`, cada insert nuevo chocaría contra la PK de la fila id=1.
do $$
begin
  if not exists (select 1 from pg_class where relkind = 'S' and relname = 'booking_settings_id_seq') then
    create sequence public.booking_settings_id_seq owned by public.booking_settings.id;
  end if;
end $$;
select setval('public.booking_settings_id_seq', greatest(coalesce((select max(id) from public.booking_settings), 1), 1), true);
alter table public.booking_settings alter column id set default nextval('public.booking_settings_id_seq');

-- Una sola fila de settings por email (los emails NULL — solo la fila id=1 default —
-- no chocan porque el índice es parcial). Da integridad; el dashboard hace
-- insert/update explícito por id (no depende de ON CONFLICT sobre índice parcial).
create unique index if not exists booking_settings_email_key
  on public.booking_settings (email) where email is not null;

-- 2) bookings.host_email — texto plano (mismo estilo que lead_tasks.assignee, sin FK).
alter table public.bookings add column if not exists host_email text;

-- 3) team_profiles.book_visible — maneja el FUTURO selector público de /book/
--    (inofensivo hoy: nada lo consume todavía).
alter table public.team_profiles add column if not exists book_visible boolean not null default false;

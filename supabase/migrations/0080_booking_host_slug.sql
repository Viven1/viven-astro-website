-- 0080: slug público por persona para /book/[persona] (MITAD PÚBLICA del booking).
-- El slug = primera palabra del nombre, en minúsculas y sin acentos
-- ("Sofia Treviño" → sofia, "Sebastián Cepeda" → sebastian). Lo consumen la ruta
-- pública /book/[persona] y el selector de /book/. Guardar el slug en la tabla
-- (en vez de recalcularlo siempre) hace la resolución robusta y desacoplada del
-- rebuild del front. Las edge functions igual saben recomputarlo como fallback.
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- Correr:  supabase db query --linked -f supabase/migrations/0080_booking_host_slug.sql

-- 1) columna slug (nullable — solo las personas visibles necesitan uno).
alter table public.team_profiles add column if not exists slug text;

-- 2) backfill: primera palabra del nombre, minúsculas, acentos removidos.
--    translate() cubre acentos ES/DE/FR sin depender de la extensión unaccent.
update public.team_profiles
   set slug = lower(translate(
     split_part(btrim(name), ' ', 1),
     'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
     'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC'))
 where slug is null and coalesce(btrim(name), '') <> '';

-- 3) unicidad (parcial: los NULL no chocan entre sí).
create unique index if not exists team_profiles_slug_key
  on public.team_profiles (slug) where slug is not null;

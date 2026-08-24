-- ============================================================
-- NOMBRE Y APELLIDO SEPARADOS — pegar en Supabase → SQL Editor
-- Para newsletters y automations ("Hola {first_name}").
-- La columna `name` se mantiene (nombre completo) por
-- compatibilidad con los leads existentes y el dashboard.
-- ⚠️ Correr ANTES de pushear el site.js nuevo.
-- ============================================================

alter table public.leads
  add column if not exists first_name text,
  add column if not exists last_name  text;

-- separar nombre/apellido en los leads ya guardados (mejor esfuerzo:
-- primera palabra = nombre, el resto = apellido)
update public.leads
   set first_name = split_part(trim(name), ' ', 1),
       last_name  = nullif(trim(substr(trim(name), length(split_part(trim(name), ' ', 1)) + 2)), '')
 where first_name is null
   and name is not null;

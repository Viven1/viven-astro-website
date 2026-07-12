-- 0047: nombre y apellido por separado en briefs (antes solo había un "name"
-- que ni siquiera se completaba desde el form). Necesarios para poder usar
-- {{first_name}} al armar los emails de seguimiento del brief.

alter table public.briefs add column if not exists first_name text;
alter table public.briefs add column if not exists last_name text;

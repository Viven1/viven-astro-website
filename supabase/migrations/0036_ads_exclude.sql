-- 0036: exclusión de conversiones Google Ads — para spam y tests.
-- El toggle 🎯/🚫 de la ficha usa esta columna; el CSV y ads-conversions-sync
-- ignoran los excluidos (además del filtro automático de emails de prueba).

alter table public.leads add column if not exists ads_exclude boolean not null default false;

-- marcar de una los tests obvios que ya están en la base
update public.leads set ads_exclude = true
 where gclid is not null
   and (email ~* '@viven\.ch$|@entropia|@example\.|test' or status ~* 'spam|descartado');

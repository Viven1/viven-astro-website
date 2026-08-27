-- El idioma de cada técnico.
--
-- El plan de rodaje salía en español para todo el equipo, dando por sentado que el equipo
-- trabaja en español. No es así: **solo Sofia y Sebastián**. El resto trabaja en alemán o
-- inglés, y estaban recibiendo la hoja del día de rodaje en un idioma que no es el suyo.
-- (Sebastián, 27 ago 2026: "no, solo sofia y yo trabajamos en español. el resto en aleman,
--  ingles.")
--
-- Sin default a nivel base: `null` significa "no sabemos", y la function decide qué hacer
-- con eso — poner 'de' por defecto en la columna sería inventar un dato que nadie cargó.

alter table crew add column if not exists idioma text
  check (idioma is null or idioma in ('es', 'de', 'en'));

comment on column crew.idioma is
  'Idioma en el que se le escribe: es | de | en. NULL = no cargado, la app usa alemán (Zúrich) y lo dice.';

-- Los dos que sí trabajan en español, que son los únicos que sabemos con certeza.
update crew set idioma = 'es'
 where idioma is null
   and (lower(email) in ('sofia@viven.ch', 'sebastian@viven.ch')
        or lower(name) in ('sofia treviño', 'sebastian cepeda', 'sebastian'));

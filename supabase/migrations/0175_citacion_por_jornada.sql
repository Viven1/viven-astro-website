-- La citación de cada persona, POR JORNADA.
--
-- `project_contacts.hora` guarda una sola hora. En un rodaje de un día alcanza; en uno de
-- tres, no: cada jornada arranca a una hora distinta, y sobre todo NO TODOS VAN TODOS LOS
-- DÍAS. Con un solo campo, alguien que no trabaja el día 2 aparece igual en el plan de ese
-- día con la citación general — y se entera al recibir el email.
--
-- `horas` es un objeto con la jornada como clave:
--   {"Jornada 1": "08:00", "Jornada 2": "no"}
--     · una hora  → esa persona ese día, a esa hora
--     · "no"      → ese día no viene (distinto de vacío)
--     · sin clave → la citación general de esa jornada
--
-- `hora` se conserva: es la de la Jornada 1 de todo lo cargado hasta hoy, y se sigue
-- leyendo como respaldo. Borrarla ahora perdería las citaciones que ya existen.
-- (Sebastián, 29 ago 2026: "¿y qué pasa si son varios días? ¿cómo lo hacemos ahí?")
alter table public.project_contacts add column if not exists horas jsonb;

comment on column public.project_contacts.horas is
  'Citación por jornada: {"Jornada 1":"08:00","Jornada 2":"no"}. "no" = ese día no viene. Sin clave = la general de esa jornada. El campo `hora` es el valor viejo, de una sola jornada.';

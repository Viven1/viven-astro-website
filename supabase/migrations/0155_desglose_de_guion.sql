-- ============================================================================
--  DESGLOSE DE GUIÓN (como Maestro)
--
--  Sebastián, 26 ago 2026: "plan de rodaje tiene que poder ser creado en base al
--  guion. Y del guion sacamos un desglose con todas las cosas necesarias vía IA".
--
--  El guión se guarda como TEXTO en el proyecto, no como archivo: el desglose lo lee
--  la IA y un PDF en Drive no se puede leer sin credenciales de Drive. El link sigue
--  existiendo aparte (script_url) para abrir el original.
--
--  El desglose es una foto: se guarda tal como salió, con la fecha. Si el guión cambia
--  se vuelve a correr — no se "actualiza solo", porque un desglose que cambia sin que
--  nadie lo pida es peor que uno viejo con fecha a la vista.
-- ============================================================================

alter table public.projects add column if not exists script_text  text;
alter table public.projects add column if not exists breakdown    jsonb;
alter table public.projects add column if not exists breakdown_at timestamptz;

comment on column public.projects.script_text is
  'El guión en texto plano. Es lo que lee la IA para desglosar — un PDF en Drive no se puede leer sin credenciales.';
comment on column public.projects.breakdown is
  'Desglose generado: escenas, necesidades por categoría, shot list y jornadas sugeridas. Foto con fecha (breakdown_at), no se actualiza solo.';

-- ============================================================================
--  0123: la edición mensual también elige destinatarios
--
--  Sebastián, 12 ago 2026: "el newsletter mensual no tiene opción de a quién
--  enviar, solo el de abajo". Cierto: la campaña manual tenía segmento, lista con
--  checks, emails sueltos y conteo — y la edición mensual salía a toda la base
--  elegible, sin nada que tocar.
--
--  Mismas columnas y mismos nombres que en `newsletters` (0054 y 0122), para que
--  el envío pueda usar la MISMA función de selección (elegirDestinatarios en
--  newsletter-send) sin una segunda copia de la lógica. Esa es toda la idea:
--  un solo lugar que decide quién recibe, para los dos caminos.
--
--  Defaults = el comportamiento de hoy (todos, todos los idiomas, sin
--  exclusiones), así que las ediciones ya creadas no cambian de audiencia al
--  correr esto.
--
--  Idempotente.
-- ============================================================================

alter table public.newsletter_issues
  add column if not exists segment_stage  text        not null default 'all',
  add column if not exists segment_lang   text        not null default 'all',
  add column if not exists exclude_ids    bigint[]    not null default '{}',
  add column if not exists exclude_emails text[]      not null default '{}',
  add column if not exists extra_emails   text[]      not null default '{}';

-- Verificación (no cambia nada):
--   select month, status, segment_stage, segment_lang, exclude_ids, exclude_emails, extra_emails
--     from public.newsletter_issues order by created_at desc limit 5;

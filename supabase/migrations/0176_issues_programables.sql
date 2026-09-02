-- Programar la edición mensual automática.
--
-- El redactor manual ya se podía programar (newsletters.scheduled_at + el cron
-- newsletter-dispatch). La edición automática no: solo tenía «Aprobar y enviar», así que
-- preparar hoy algo que sale mañana obligaba a volver mañana y apretar el botón.
-- (Sebastián, 2 sep 2026: "no me deja elegir la fecha de envío, lo quiero programar para
-- mañana no ahora".)
--
-- `approved_by` se sigue llenando al programar: programarla ES aprobarla. Lo que cambia es
-- cuándo sale, no quién lo decidió.
alter table public.newsletter_issues add column if not exists scheduled_at timestamptz;

comment on column public.newsletter_issues.scheduled_at is
  'Cuándo tiene que salir. La despacha newsletter-dispatch en la siguiente ventana de horario laboral suizo. NULL = no programada.';

-- El dispatcher la busca por (status, scheduled_at) cada 15 minutos.
create index if not exists newsletter_issues_programadas
  on public.newsletter_issues (scheduled_at)
  where scheduled_at is not null and status = 'draft';

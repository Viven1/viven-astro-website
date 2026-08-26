-- "Ya di mis notas" no es lo mismo que "aprobado".
--
-- Sebastián, 26 ago 2026: "necesitamos un botón que dice, notas dadas pasar a próxima
-- versión o similar… ya que si dan notas no está aprobado todavía."
--
-- Tenía razón y faltaba el estado del medio. Hasta hoy una versión estaba aprobada o no
-- estaba nada, y el caso normal —el cliente dejó sus notas y espera el corte nuevo— no
-- se distinguía de "todavía no la miró". Son dos cosas muy distintas para quien mira el
-- dashboard: una espera al cliente y la otra nos espera a nosotros.
alter table public.project_versions
  add column if not exists notes_done_at timestamptz,
  add column if not exists notes_done_by text;

comment on column public.project_versions.notes_done_at is
  'El cliente terminó de dejar notas sobre esta versión y espera la siguiente. NO es aprobación.';

-- 2 sep 2026: los 44 envíos de la edición 2026-09 no se registraron en
-- newsletter_sends. Causa: el índice único de (issue_id,email) era PARCIAL
-- (where issue_id is not null) y Postgres exige que el ON CONFLICT repita ese
-- predicado — supabase-js no lo manda → 42P10 en cada tanda, y el código no
-- miraba el error. Un índice completo sirve igual: en un unique de Postgres
-- los NULL no chocan entre sí, así que las filas de campañas (issue_id null)
-- no se pisan.
drop index if exists public.newsletter_sends_issue_uniq;
create unique index if not exists newsletter_sends_issue_uniq
  on public.newsletter_sends (issue_id, email);

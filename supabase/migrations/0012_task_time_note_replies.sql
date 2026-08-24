-- ============================================================================
--  Viven — hora concreta en las tasks + respuestas (thread) en las notas
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
-- ============================================================================

-- hora opcional de la task ('HH:MM'), además de la fecha
alter table public.lead_tasks add column if not exists due_time text;

-- respuestas: una nota puede colgar de otra (mismo thread)
alter table public.lead_notes add column if not exists parent_id bigint references public.lead_notes(id) on delete cascade;
create index if not exists lead_notes_parent_idx on public.lead_notes (parent_id);

-- 0057: respuestas de notas en HILO (estilo chat) — feedback de Sebastián: el primer
-- intento citaba el texto original dentro del body («En respuesta a X («…»)…») y al
-- responder una respuesta el quoteo se anidaba ilegible. parent_id liga cada respuesta
-- a su nota RAÍZ (hilo plano de 1 nivel); el body queda limpio, solo el texto.
-- Aditivo: las notas existentes quedan como raíces (parent_id null).

alter table public.lead_notes add column if not exists parent_id bigint;
create index if not exists lead_notes_parent_idx on public.lead_notes(parent_id);

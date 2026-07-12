-- 0027: brief profundo — columna answers (jsonb) en briefs.
-- Guarda las respuestas nuevas del cuestionario (audiencia, cantidad, formatos,
-- idiomas, en cámara, locación, referencias) sin migraciones futuras.
-- La página /brief/ es resiliente: sin esta columna pliega todo al campo extra.

alter table public.briefs add column if not exists answers jsonb;

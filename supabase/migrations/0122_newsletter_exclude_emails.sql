-- ============================================================================
--  0122: poder destildar por EMAIL, no solo por lead
--
--  Sebastián, 12 ago 2026: "yo tengo que poder elegir a quién con un check".
--  El check por persona ya existía para todo el segmento (exclude_ids, migración
--  0054) — pero había dos filas que quedaban fijas, sin check: las casillas del
--  equipo que se agregan siempre (0121). No tienen lead_id, así que exclude_ids
--  (bigint[]) no las alcanzaba.
--
--  exclude_emails resuelve eso y además generaliza: saca por dirección, sirva o
--  no la fila de un lead. Se aplica a TODOS los destinatarios — los del segmento,
--  los agregados a mano y los del equipo.
--
--  Sigue valiendo la única regla que no admite check: un dado de baja no recibe,
--  ni destildando ni tildando ni tipeándolo a mano.
--
--  Idempotente.
-- ============================================================================

alter table public.newsletters
  add column if not exists exclude_emails text[] not null default '{}';

-- Verificación (no cambia nada):
--   select id, subject, exclude_ids, exclude_emails, extra_emails from public.newsletters order by created_at desc limit 5;

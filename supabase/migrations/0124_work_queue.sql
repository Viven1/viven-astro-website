-- ============================================================================
--  0124: la cola de "aprobado — falta hacerlo"
--
--  Sebastián, 14 ago 2026: "el cro ya aprueba y hace?". No: aprobar una idea de
--  CRO solo escribía status:'approved' adentro del jsonb y mostraba un cartel
--  diciendo que Claude la implementaría. Nada la ejecutaba, nada la recordaba,
--  y si en la sesión siguiente yo no la miraba, ahí se quedaba. Una marca, no
--  una orden. Su respuesta: "hacelo y hace q funcione bien o no sirve para
--  nada".
--
--  Esta tabla es ese lugar. Regla de diseño: lo aprobado tiene que estar en un
--  sitio que alguien TENGA que vaciar, con la espera a la vista. Si algo lleva
--  ocho días esperando, se ve en Hoy desde el teléfono; no depende de que
--  alguien se acuerde.
--
--  Una fila por cosa aprobada, venga de donde venga (`source`):
--    cro    → idea del motor de CRO semanal (ref = <cro_ideas.id>:<índice>)
--    accion → acción propuesta sobre un lead/cliente (ref = lead id)
--    manual → cargada a mano desde el dashboard
--
--  Correr una vez en el SQL Editor. Idempotente.
-- ============================================================================

create table if not exists public.work_queue (
  id           bigint generated always as identity primary key,
  source       text        not null default 'manual',   -- cro | accion | manual
  ref          text,                                    -- de dónde salió, para volver a la ficha
  title        text        not null,
  detail       text,                                    -- qué hay que hacer, en criollo
  url          text,                                    -- adónde ir en el dashboard
  status       text        not null default 'pending',  -- pending | doing | done | cancelled
  approved_by  text,                                    -- quién apretó aprobar
  approved_at  timestamptz not null default now(),
  done_at      timestamptz,
  done_note    text,                                    -- qué se hizo, en una línea
  created_at   timestamptz not null default now()
);

-- Aprobar dos veces lo mismo no crea dos pendientes (el botón es un toggle y
-- el teléfono repite taps): un solo pendiente vivo por origen.
create unique index if not exists work_queue_ref_uq
  on public.work_queue (source, ref) where status in ('pending', 'doing');
create index if not exists work_queue_pend_idx
  on public.work_queue (status, approved_at desc);

alter table public.work_queue enable row level security;
-- El dashboard (usuarios logueados) aprueba, cancela y marca hecho. El sitio
-- público no toca esta tabla nunca. Las funciones internas usan service role.
drop policy if exists work_queue_select_auth on public.work_queue;
create policy work_queue_select_auth on public.work_queue
  for select to authenticated using (true);
drop policy if exists work_queue_insert_auth on public.work_queue;
create policy work_queue_insert_auth on public.work_queue
  for insert to authenticated with check (true);
drop policy if exists work_queue_update_auth on public.work_queue;
create policy work_queue_update_auth on public.work_queue
  for update to authenticated using (true) with check (true);

-- Verificación (no cambia nada):
--   select status, count(*) from public.work_queue group by 1;
--   select id, source, title, approved_at from public.work_queue
--     where status = 'pending' order by approved_at;

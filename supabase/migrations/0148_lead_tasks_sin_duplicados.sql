-- Dos veces la misma tarea abierta para la misma persona: no.
--
-- El 20 ago 2026 el contacto 47 quedó con "⏰ Sin contacto hace 5 semanas — retomar"
-- DOS veces, creadas con 3 segundos de diferencia (07:00:02 y 07:00:05). stale-remind
-- dedupea leyendo las tareas abiertas ANTES del loop, así que dos corridas que se pisan
-- leen las dos "no hay ninguna" y las dos insertan. Cualquier reintento del cron —o del
-- pg_net que lo dispara— vuelve a producirlo.
--
-- Chequear en el código no alcanza contra una carrera: el que tiene que decir que no es
-- la base. Se limpia lo que ya está duplicado y se pone un índice único parcial sobre
-- las tareas ABIERTAS (las cerradas pueden repetirse: la misma tarea el mes que viene es
-- una tarea nueva y legítima).
with dups as (
  select id, row_number() over (partition by lead_id, title order by id) rn
  from public.lead_tasks where done = false
)
delete from public.lead_tasks t using dups d where t.id = d.id and d.rn > 1;

create unique index if not exists lead_tasks_abierta_unica
  on public.lead_tasks (lead_id, title) where done = false;

-- ============================================================================
--  0065: al borrar un lead, sus tasks y notas se borran con él.
--  Reporte de Sebastián: en "Para hoy" (Home) le quedaban tasks de leads que
--  ya había borrado — quedaban huérfanas para siempre (7 tasks + 10 notas
--  huérfanas encontradas en vivo) porque lead_tasks.lead_id / lead_notes.lead_id
--  son texto plano sin foreign key. No se puede armar un FK real con CASCADE
--  porque leads.id es bigint y lead_id acá es text (columnas de tipos
--  distintos) — se resuelve con un trigger AFTER DELETE, mismo patrón que ya
--  se usa en este proyecto (ver comentario "trigger" en otras migraciones).
--
--  1) Limpieza única de lo que ya quedó huérfano.
--  2) Trigger para que de acá en más se borre solo, sea cual sea la pantalla
--     desde donde se borre el lead (ficha, batch-delete, fila de la tabla).
-- ============================================================================

delete from public.lead_tasks t
 where not exists (select 1 from public.leads l where l.id::text = t.lead_id);

delete from public.lead_notes n
 where not exists (select 1 from public.leads l where l.id::text = n.lead_id);

create or replace function public.cascade_delete_lead_activity()
returns trigger
language plpgsql
as $$
begin
  delete from public.lead_tasks where lead_id = old.id::text;
  delete from public.lead_notes where lead_id = old.id::text;
  return old;
end;
$$;

drop trigger if exists trg_cascade_delete_lead_activity on public.leads;
create trigger trg_cascade_delete_lead_activity
  after delete on public.leads
  for each row execute function public.cascade_delete_lead_activity();

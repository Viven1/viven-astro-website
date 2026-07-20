-- 0081: elimina por completo el nurture automático (pedido explícito de
-- Sebastián: "cancela la nurture sequence, borrala por completo").
-- El cron ya estaba deshabilitado (unscheduled desde la SQL 0060) y ambas
-- tablas estaban vacías (0 filas) al momento de este borrado — no se pierde
-- data real, solo infraestructura ya dormida.

-- por si el cron sobreviviera bajo el mismo nombre (defensivo, no debería existir)
do $$
begin
  perform cron.unschedule('viven-nurture');
exception when others then null;
end $$;

delete from public.outbox where kind = 'nurture';
delete from public.app_settings where key = 'nurture';
drop table if exists public.nurture_state;
drop table if exists public.nurture_log;

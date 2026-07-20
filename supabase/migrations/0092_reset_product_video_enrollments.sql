-- 0092: pedido explícito de Sebastián — que los leads ya inscriptos en el
-- workflow de Product Video arranquen de cero (con TODO el contenido ya
-- corregido: saludo formal en alemán, links al portfolio en el idioma
-- correcto), no que sigan arrastrando drafts armados con el contenido
-- viejo. Se descartan los 2 drafts pendientes de Alfred (ya parchados a
-- mano en 0089/091, pero mejor reconstruidos limpios por el motor real) y
-- se reinscribe a ambos leads desde HOY:
--   - created_at = now() → el reloj día+2/+5/+9 arranca de nuevo desde hoy
--   - step_idx = 1 (el primer content_step) con next_at = now() → el motor
--     arma LOS 3 pasos de una sola vez en la próxima corrida (para que
--     Sebastián pueda revisar/aprobar ya), cada uno con su scheduled_at
--     real (hoy+2, hoy+5, hoy+9) — no manda nada antes de esa fecha.
update public.outbox
set status = 'discarded'
where kind = 'content_followup' and lead_id in (49, 58) and status = 'pending';

update public.automation_runs
set step_idx = 1, next_at = now(), created_at = now(), status = 'active'
where automation_id = '95a42115-92ff-47cb-a6c3-eae1996b22b1' and lead_id in (49, 58);

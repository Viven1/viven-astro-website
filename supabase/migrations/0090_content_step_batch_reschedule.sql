-- 0090: con el motor ya actualizado para armar los 3 pasos de una sola vez
-- (con scheduled_at real por paso), el lead 49 (Alfred) quedó a mitad de
-- camino con el viejo comportamiento uno-a-la-vez: le faltaba el paso 3,
-- programado para recién procesarse el 2026-07-24 (fin del wait de 4 días).
-- Pedido explícito: ver los 3 pasos ya mismo para poder revisarlos juntos —
-- se adelanta next_at a ahora para que la próxima corrida arme ese draft
-- (con scheduled_at=2026-07-24, respetando igual la fecha real de envío).
update public.automation_runs
set next_at = now()
where automation_id = '95a42115-92ff-47cb-a6c3-eae1996b22b1' and lead_id = 49 and status = 'active';

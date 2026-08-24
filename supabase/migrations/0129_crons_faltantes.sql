-- 0129: encender los motores que estaban declarados y nunca programados.
--
-- YA APLICADO en la base el 2026-08-14. Este archivo deja el registro en el
-- repo: sin él, la base y el repositorio dicen cosas distintas, que es
-- exactamente la causa del problema que esta migración viene a resolver.
--
-- CÓMO APARECIÓ: la RPC cron_health() de la 0128 mostró 19 trabajos corriendo
-- contra 25 declarados en las migraciones. Cinco no existían en la base. Las
-- migraciones estaban en el repo y las funciones desplegadas, pero no había
-- nadie que las disparara. Un motor apagado se parece mucho a uno andando.
--
-- QUÉ SE ENCIENDE Y QUÉ NO. Los cinco no eran el mismo caso, y programarlos a
-- todos "por prolijidad" habría dejado dos trabajos rotos corriendo para
-- siempre — cambiar un problema invisible por otro:
--
--   ✅ viven-content-followup   → content-followup      (existe, tablas ok)
--   ✅ viven-reactivation       → reactivation-engine   (existe, tablas ok)
--   ✅ viven-review-request     → review-request        (existe, tablas ok)
--   ❌ viven-followup-send      → la función `followup-send` NO EXISTE, verificado
--      contra las 61 desplegadas. La 0020 apunta a un endpoint que nunca se
--      creó; mandar los borradores aprobados lo hace `automations-run`, que sí
--      está programado (cada 20 min) y funciona. Programarlo daría un 404
--      silencioso cada media hora.
--   ❌ viven-nurture            → sus tablas (nurture_log, nurture_state) nunca se
--      crearon: las migraciones 0040 y 0053 jamás corrieron. Ese sistema lo
--      reemplazaron las Automatizaciones. Encenderlo sería un error cada hora.
--
-- NINGUNO LE ESCRIBE A UN CLIENTE POR SU CUENTA (revisado función por función):
-- content-followup y reactivation-engine dejan borradores en la bandeja
-- esperando el ✓, y review-request en modo cron crea una tarea + push internos
-- ("recordarnos a NOSOTROS, jamás al cliente", dice su propio código). El envío
-- directo de review-request es solo el botón manual del dashboard.
--
-- El comando de cada trabajo se DERIVA de uno que ya funciona en lugar de
-- reescribirlo. Así la credencial del cron no se copia a ningún archivo del
-- repositorio, y si algún día cambia en los demás, estos la heredan igual.
--
-- Repetible: si se corre de nuevo, primero da de baja estos tres y los vuelve a
-- crear. No toca ningún otro trabajo programado.

do $$
declare
  molde text;
begin
  select command into molde from cron.job where jobname = 'viven-task-remind';
  if molde is null then
    raise exception 'No encontré viven-task-remind para usar de molde — revisar antes de seguir';
  end if;

  perform cron.unschedule(jobname) from cron.job
   where jobname in ('viven-content-followup', 'viven-reactivation', 'viven-review-request');

  perform cron.schedule('viven-content-followup', '20 * * * *',
    replace(molde, 'v1/task-remind', 'v1/content-followup'));
  perform cron.schedule('viven-reactivation', '30 6 * * 1',
    replace(molde, 'v1/task-remind', 'v1/reactivation-engine'));
  perform cron.schedule('viven-review-request', '0 8 * * *',
    replace(molde, 'v1/task-remind', 'v1/review-request'));
end $$;

-- Comprobar después de correrla:
--   select jobname, schedule, estado from public.cron_health() order by estado;

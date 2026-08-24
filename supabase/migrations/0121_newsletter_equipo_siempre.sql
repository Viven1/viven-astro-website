-- ============================================================================
--  0121: el EQUIPO recibe siempre el newsletter (casillas configurables)
--
--  Sebastián quiere ver con sus propios ojos lo que sale afuera, en cada campaña.
--  Los commits del 11-12 ago sacaron @viven.ch y @entropia del filtro de
--  direcciones falsas, y eso era necesario — pero no alcanzaba. Verificado contra
--  la base real el 12 ago 2026, a través del panel nuevo "Quiénes reciben el
--  newsletter": de 186 destinatarios, CERO son @viven.ch o @entropia. Esas
--  direcciones no existen como leads, así que dejar de filtrarlas no cambiaba
--  nada y a él no le llegaba el newsletter.
--
--  Ahora las casillas del equipo se agregan siempre en elegirDestinatarios()
--  (newsletter-send), sin depender de que alguien esté cargado como lead, y salen
--  marcadas «equipo» en el panel para que el número se explique solo.
--
--  ESTA FILA ES EL INTERRUPTOR. Sin ella el código usa el mismo default, así que
--  la migración no es obligatoria — sirve para poder CAMBIAR las direcciones sin
--  tocar código:
--    · agregar/cambiar casillas → editar el array
--    · apagarlo del todo        → dejarlo en []  (un array vacío es "apagado";
--                                 borrar la fila vuelve al default)
--
--  El default son las dos casillas que estos mismos emails YA usan para salir
--  (info@viven.ch es el From y sofia@viven.ch el Reply-To de newsletter-send),
--  o sea que existen con seguridad y no van a bouncear.
--
--  Idempotente. Si querés otras direcciones, cambiá el array y corré el update
--  comentado abajo.
-- ============================================================================

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value)
values ('newsletter', '{"always_to": ["info@viven.ch", "sofia@viven.ch"]}')
on conflict (key) do nothing;

-- Para CAMBIAR las direcciones más adelante (descomentar y editar):
-- update public.app_settings
--    set value = jsonb_set(value, '{always_to}', '["info@viven.ch","sofia@viven.ch","sebastian@viven.ch"]'::jsonb),
--        updated_at = now()
--  where key = 'newsletter';

-- Verificación (no cambia nada):
--   select value from public.app_settings where key = 'newsletter';

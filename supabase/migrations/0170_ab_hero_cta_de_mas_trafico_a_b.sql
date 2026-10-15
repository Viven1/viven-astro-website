-- 0170: subir el split del test "Hero CTA DE" (SQL 0105) para dejar la
-- mayoría del tráfico en la variante B.
--
-- Cola de trabajo #38 (aprobado por Sebastián 2026-08-24): cortar el test
-- ahora y mover 80-100% del tráfico DE a la variante B, monitoreando
-- leads/semana durante 7 días antes de fijarla como default. Fijarla como
-- default es otro paso (el botón "Declarar ganador B" del dashboard, que
-- pone status en done_b) — a propósito NO se toca acá: todavía falta
-- confirmar el uplift con la semana de datos que pidió Sebastián, y para
-- eso el test tiene que seguir 'running' con algo de tráfico en A como
-- control.
--
-- No hay forma en el dashboard hoy de editar el split_pct de un test que
-- ya está corriendo (el editor de A/B solo lo fija al crear el test) — por
-- eso el cambio va por migración, igual que 0104/0105 crearon estos tests.
--
-- El test ES de la misma migración 0105 no se toca: el ítem #38 solo pedía
-- el de DE.
--
-- Guardado por nombre + url_path + status='running': si el test ya no
-- está corriendo (autostop de 0074, o ya declarado ganador a mano desde
-- el dashboard) este UPDATE no hace nada.
update public.ab_tests
   set split_pct = 90
 where name = 'Hero CTA DE: Preis in 60s vs Projekt starten'
   and url_path = '/de/'
   and status = 'running';

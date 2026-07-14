-- 0074: auto-stop de A/B tests.
-- Hoy un test queda 'running' para siempre si nadie lo cierra a mano — sigue
-- repartiendo tráfico incluso pasado su end_at. Este cron lo congela solo:
-- al pasar end_at, status 'running' → 'stopped'.
--
-- SEGURIDAD DE SERVING: site.js SÓLO sirve variantes para status IN ('running','done_b').
-- Un test 'stopped' vuelve automáticamente a servir la página ORIGINAL (A) — sin
-- tocar site.js. La medición queda congelada con los datos que tenía; el dashboard
-- lo muestra como "⏹ Terminado (auto-stop)" y deja disponibles Declarar-ganador / Mantener-A.
--
-- La columna ab_tests.status es un text SIN check constraint (ver SQL 0030), así que
-- agregar el valor 'stopped' no requiere alterar ninguna restricción.
--
-- Job NUEVO e independiente — no toca los crons de emails salientes pausados en la
-- SQL 0060. No hace ningún envío: es un UPDATE interno.

create extension if not exists pg_cron;

do $$ begin
  perform cron.unschedule('viven-ab-autostop');
exception when others then null; end $$;

-- corre cada 10 minutos: congela los tests vencidos
select cron.schedule('viven-ab-autostop', '*/10 * * * *', $$
  update public.ab_tests
     set status = 'stopped'
   where status = 'running'
     and end_at is not null
     and end_at < now();
$$);

-- pasada inmediata para los que ya estén vencidos al aplicar esta migración
update public.ab_tests
   set status = 'stopped'
 where status = 'running'
   and end_at is not null
   and end_at < now();

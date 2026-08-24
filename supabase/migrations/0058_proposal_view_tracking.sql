-- 0058: señales de venta en propuestas, pedidas por Sebastián.
-- (1) last_view_at: CUÁNDO fue la última vez que el cliente abrió el link publicado
--     (get-proposal ya contaba views, pero un número acumulado no dice si la están
--     mirando AHORA — "vista hace 3 h" = llamalo, "0 vistas en 3 días" = reenviá el link).
-- (2) published_at: cuándo se publicó — el único timestamp que había (updated_at) se
--     pisa con cada guardado, así que "esperando hace N días" era incalculable.
--     Backfill best-effort con updated_at para las ya publicadas/aceptadas.
-- Aditivo, sin tocar datos existentes.

alter table public.proposals add column if not exists last_view_at timestamptz;
alter table public.proposals add column if not exists published_at timestamptz;

update public.proposals set published_at = updated_at
  where published_at is null and status in ('sent', 'accepted');

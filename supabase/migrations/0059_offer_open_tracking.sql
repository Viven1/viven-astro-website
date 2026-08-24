-- 0059: señales de venta en OFERTAS, pedidas por Sebastián (el "vista" de las ofertas).
-- Las ofertas van por email (no tienen link público como las propuestas), así que
-- "la vio" = abrió el email. Resend reporta cada apertura a un webhook nuestro
-- (función resend-events) que estampa last_open_at.
-- (1) last_open_at: última vez que el cliente abrió el email de la oferta.
-- (2) sent_at: cuándo se ENVIÓ de verdad — updated_at se pisa con cada guardado,
--     así que "esperando hace N días" era incalculable. Backfill best-effort.
-- Aditivo, sin tocar datos existentes.

alter table public.offers add column if not exists last_open_at timestamptz;
alter table public.offers add column if not exists sent_at timestamptz;

update public.offers set sent_at = updated_at
  where sent_at is null and status = 'sent';

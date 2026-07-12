-- 0052: portal del cliente — página pública de estado del proyecto (sin
-- pelotear por email) para deals GANADOS. production_status es la etapa de
-- PRODUCCIÓN (post-venta), separada de deals.stage (que es la etapa de VENTA
-- y no debería mezclarse con esto).

alter table public.deals add column if not exists production_status text; -- pre_production | filming | editing | client_review | delivered
alter table public.deals add column if not exists portal_token text unique;
alter table public.deals add column if not exists portal_note text;
alter table public.deals add column if not exists deliverable_url text;

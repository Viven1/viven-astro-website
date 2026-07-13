-- 0054: newsletter — poder ver la lista completa de destinatarios de una
-- campaña y sacar o agregar gente a mano antes de mandar (pedido de
-- Sebastián). exclude_ids saca leads que sí matchean el segmento;
-- extra_emails suma direcciones que no están en el segmento.

alter table public.newsletters add column if not exists exclude_ids bigint[] not null default '{}';
alter table public.newsletters add column if not exists extra_emails text[] not null default '{}';

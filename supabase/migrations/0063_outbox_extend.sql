-- 0063: extiende outbox para que sea la ÚNICA puerta de salida de emails
-- automáticos a clientes (pedido de Sebastián — bandeja de salida sin
-- excepciones). Additive: no rompe las filas/consultas existentes.
--
--   followup_id   — liga el borrador al lead_followups que lo originó
--                   (kind='followup'); null para workflow/nurture.
--   scheduled_at  — "⏰ Más tarde": si tiene fecha futura, el borrador se
--                   oculta de la bandeja hasta esa hora (null = visible ya).

alter table public.outbox add column if not exists followup_id bigint;
alter table public.outbox add column if not exists scheduled_at timestamptz;
create index if not exists outbox_followup_idx on public.outbox (followup_id) where followup_id is not null;
create index if not exists outbox_pending_idx on public.outbox (status, kind) where status = 'pending';

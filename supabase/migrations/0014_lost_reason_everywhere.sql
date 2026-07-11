-- ============================================================================
--  Viven — el motivo de pérdida queda grabado en TODO: contacto (leads.lost_reason
--  ya existe + nota automática), ofertas y propuestas ligadas. Para entender a
--  largo plazo por qué se pierden deals. Idempotente.
-- ============================================================================

alter table public.offers    add column if not exists lost_reason text;
alter table public.proposals add column if not exists lost_reason text;

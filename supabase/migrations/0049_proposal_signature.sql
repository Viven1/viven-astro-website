-- 0049: firma electrónica liviana en propuestas — el nombre tipeado ya
-- funcionaba como "firma" pero faltaba (a) un checkbox explícito de acuerdo
-- con los términos antes de poder aceptar, y (b) guardar la IP para dejar
-- un rastro mínimo de auditoría de quién aceptó, cuándo y desde dónde.

alter table public.proposals add column if not exists signed_ip text;
alter table public.proposals add column if not exists agreed_terms boolean;

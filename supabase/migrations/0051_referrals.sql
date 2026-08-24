-- 0051: tracking de referidos con atribución real — antes el workflow de
-- referral mandaba un código estático (REFERRAL500) sin forma de saber quién
-- lo trajo. Ahora cada cliente ganado tiene su propio referral_code (se genera
-- solo la primera vez que un workflow lo necesita) y linkea con ?ref=<code>;
-- si un lead nuevo llega con ese parámetro, queda guardado en referred_by.

alter table public.leads add column if not exists referral_code text unique;
alter table public.leads add column if not exists referred_by text;
create index if not exists leads_referred_by_idx on public.leads (referred_by);

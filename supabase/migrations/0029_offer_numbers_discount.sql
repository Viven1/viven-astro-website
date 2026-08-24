-- 0029: numeración de ofertas A26xxxx + descuento a nivel oferta.
-- · number: correlativo profesional (A + año + secuencia de 4 dígitos). Las ofertas
--   existentes se numeran por orden de creación; las nuevas se numeran solas (trigger).
-- · discount_pct: descuento % sobre el neto (el editor lo aplica antes del IVA).

alter table public.offers add column if not exists number text;
alter table public.offers add column if not exists discount_pct numeric default 0;

-- backfill: numerar las ofertas reales existentes (templates fuera) por orden de creación
with nums as (
  select id, row_number() over (order by created_at, id) as rn
  from public.offers
  where coalesce(is_template, false) = false and number is null
)
update public.offers o
set number = 'A26' || lpad(nums.rn::text, 4, '0')
from nums where o.id = nums.id;

-- trigger: numerar automáticamente cada oferta nueva (año dinámico: A26…, A27…)
create or replace function public.offer_autonumber()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  yy text := to_char(now(), 'YY');
  seq int;
begin
  if new.number is not null or coalesce(new.is_template, false) then
    return new;
  end if;
  select coalesce(max(nullif(substring(number from 4), '')::int), 0) + 1
    into seq
    from public.offers
   where number like 'A' || yy || '%';
  new.number := 'A' || yy || lpad(seq::text, 4, '0');
  return new;
end;
$$;

drop trigger if exists offers_autonumber on public.offers;
create trigger offers_autonumber
  before insert on public.offers
  for each row execute function public.offer_autonumber();

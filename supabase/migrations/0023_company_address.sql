-- 0023: dirección legal en la ficha de EMPRESA (fuente para ofertas y propuestas)
alter table public.companies add column if not exists address  text;
alter table public.companies add column if not exists zip_city text;

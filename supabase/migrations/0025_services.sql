-- 0025: catálogo de SERVICIOS editable (tab Servicios del dashboard).
-- Lo que vendés y sus precios — alimenta "Agregar del catálogo" en las ofertas.
-- Se precarga con el catálogo actual SOLO si la tabla está vacía.

create table if not exists public.services (
  id          bigint generated always as identity primary key,
  name        text not null,
  phase       text not null default 'Production',   -- Development · Pre-Production · Production · Post-Production · Delivery
  unit        text default 'Fix',                   -- Tag / Std / Fix / Stk / Person / Sprache
  price       numeric default 0,                    -- precio al cliente (CHF, neto)
  cost        numeric default 0,                    -- costo interno (freelancer/alquiler)
  sort        int default 0,
  active      boolean default true,                 -- false = pausado (no aparece en el catálogo)
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table public.services enable row level security;
drop policy if exists services_auth_all on public.services;
create policy services_auth_all on public.services for all to authenticated using (true) with check (true);

-- seed: el catálogo hardcodeado de hoy, solo si está vacía
insert into public.services (name, phase, unit, price, cost, sort)
select * from (values
  ('Concept / Treatment',          'Development',     'Fix',     800::numeric,   0::numeric, 1),
  ('Scriptwriting',                'Development',     'Fix',     600,   0, 2),
  ('Storyboard',                   'Development',     'Fix',     500,   0, 3),
  ('Casting',                      'Development',     'Std',     120,   0, 4),
  ('Producer',                     'Pre-Production',  'Std',     120,   0, 1),
  ('1st AC',                       'Pre-Production',  'Std',      60,   0, 2),
  ('Project Admin',                'Pre-Production',  'Fix',     300,   0, 3),
  ('Scouting (Producer)',          'Pre-Production',  'Std',     120,   0, 4),
  ('Producer',                     'Production',      'Tag',     950,   0, 1),
  ('Director of Photography',      'Production',      'Tag',    1000, 800, 2),
  ('Gaffer',                       'Production',      'Tag',     700, 670, 3),
  ('Sound / Audio',                'Production',      'Tag',     800, 750, 4),
  ('Sony FX6 (Kit)',               'Production',      'Tag',     250,   0, 5),
  ('Lenses Set',                   'Production',      'Tag',     100,   0, 6),
  ('3-Point LED Kit',              'Production',      'Tag',     250,   0, 7),
  ('Ronin RS3 Pro',                'Production',      'Tag',      60,   0, 8),
  ('Van inkl. km',                 'Production',      'Tag',     120,   0, 9),
  ('Per Diems',                    'Production',      'Person',   32,  32, 10),
  ('Editor inkl. Suite + Color',   'Post-Production', 'Tag',     950, 550, 1),
  ('Motion / VFX Animation',       'Post-Production', 'Tag',     900, 750, 2),
  ('Music license',                'Post-Production', 'Stk',      60,  60, 3),
  ('Additional Correction Round',  'Post-Production', 'Tag',     950, 550, 4),
  ('Master exports / Formate',     'Delivery',        'Fix',     200,   0, 1),
  ('Untertitel / Subtitles',       'Delivery',        'Sprache', 120,   0, 2),
  ('Social cutdowns (15s/9:16)',   'Delivery',        'Stk',     250,   0, 3)
) as seed(name, phase, unit, price, cost, sort)
where not exists (select 1 from public.services);

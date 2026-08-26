-- ============================================================================
--  Los técnicos: gente, no texto suelto.
--
--  Sebastián, 26 ago 2026: "vamos a generar en operaciones algo como personas pero de
--  técnicos, crew, etc., así los tengo todos dentro y los puedo linkear con cada
--  proyecto… toda una overview completa."
--
--  ── El problema que resuelve ──
--  Hoy un técnico existe en TRES lugares y en ninguno es alguien:
--    · `projects.crew`  → un jsonb con {rol, nombre}
--    · `project_costs`  → una columna `person` de texto libre
--    · `project_bills`  → un `supplier` que sale del PDF de la factura
--  Medido el 26 ago: "Sofia" y "Sofia Treviño" figuran como DOS personas distintas, y
--  ninguna de las 13 líneas de costo tiene nombre. Con eso no se puede contestar ni
--  "¿cuánto le pagamos a Tobias este año?" ni "¿con quién trabajamos más?".
--
--  ── Por qué `crew_alias` y no un `update` que junte los nombres ──
--  Que dos nombres se parezcan no prueba que sean la misma persona: hay dos Martin y
--  puede haber dos Sofia. La migración NO fusiona a nadie — siembra un técnico por
--  nombre distinto y deja los alias para que la fusión la decida una persona. Adivinar
--  acá mezcla la plata de dos personas, que es el error caro.
--
--  ── Lo que NO va acá ──
--  Los técnicos no son `leads`. Un lead es alguien a quien le vendemos; un técnico es
--  alguien a quien le pagamos. Meterlos en la misma tabla ensucia los números del
--  pipeline —el mes que contratamos seis freelance parecerían seis clientes nuevos— y
--  ya pasó con los tests. (Ver `email_es_prueba`.)
--
--  Idempotente.
-- ============================================================================

create table if not exists public.crew (
  id           bigint generated always as identity primary key,
  name         text not null,
  email        text,
  phone        text,
  roles        text[] not null default '{}',   -- 'DoP', 'Gaffer', 'Editor'…
  ciudad       text,
  tarifa_dia   numeric,
  tarifa_hora  numeric,
  moneda       text not null default 'CHF',
  iban         text,
  empresa      text,                            -- si factura por una GmbH
  interno      boolean not null default false,  -- nosotros no nos facturamos
  activo       boolean not null default true,
  notas        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists crew_name_idx on public.crew (lower(name));
create unique index if not exists crew_email_uniq
  on public.crew (lower(email)) where (email is not null and email <> '');

-- Los nombres con los que aparece esa persona en los datos viejos: "Sofia", "Sofia
-- Treviño", "Treviño Film GmbH" en una factura. Es lo que hace que la plata de todos
-- esos lugares termine en la misma ficha.
create table if not exists public.crew_alias (
  id       bigint generated always as identity primary key,
  crew_id  bigint not null references public.crew(id) on delete cascade,
  alias    text not null
);
create unique index if not exists crew_alias_uniq on public.crew_alias (lower(alias));

-- El vínculo directo, para lo nuevo. Lo viejo se resuelve por alias.
alter table public.project_costs add column if not exists crew_id bigint;
alter table public.project_bills add column if not exists crew_id bigint;
create index if not exists project_costs_crew_idx on public.project_costs (crew_id);
create index if not exists project_bills_crew_idx on public.project_bills (crew_id);

alter table public.crew enable row level security;
alter table public.crew_alias enable row level security;
do $$ begin
  create policy crew_auth_all on public.crew for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy crew_alias_auth_all on public.crew_alias for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create or replace function public.touch_crew()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_crew_touch on public.crew;
create trigger trg_crew_touch before update on public.crew
  for each row execute function public.touch_crew();

-- ── Sembrar desde lo que ya hay, sin fusionar a nadie ──
insert into public.crew (name, roles)
select c->>'nombre',
       array_agg(distinct c->>'rol') filter (where c->>'rol' is not null and c->>'rol' <> '')
  from public.projects p, jsonb_array_elements(p.crew) c
 where coalesce(c->>'nombre', '') <> ''
   and not exists (select 1 from public.crew x where lower(x.name) = lower(c->>'nombre'))
 group by c->>'nombre'
on conflict do nothing;

insert into public.crew_alias (crew_id, alias)
select id, name from public.crew
 where not exists (select 1 from public.crew_alias a where lower(a.alias) = lower(crew.name))
on conflict do nothing;

comment on table public.crew is
  'Los técnicos: gente a la que le PAGAMOS. No son leads —a un lead se le vende— y mezclarlos ensuciaría el pipeline.';
comment on table public.crew_alias is
  'Los nombres con los que esa persona aparece en costos, facturas y el crew de cada proyecto. La fusión la decide una persona: dos nombres parecidos no prueban que sean el mismo.';

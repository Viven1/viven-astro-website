-- ============================================================================
--  El número de proyecto: 1201, 1202, 1203…
--
--  Sebastián, 26 ago 2026: "cuando un proyecto se cree, que cree un número
--  empezando de 1200, o sea 1201, 1202, etc. Ese número es la referencia de ese
--  proyecto y va también en la factura que enviamos a bexio, para los freelance".
--
--  Por qué una SECUENCIA y no max(ref)+1: dos proyectos creados al mismo tiempo
--  —o desde dos ventanas, que acá pasa— sacarían el mismo número con max()+1.
--  Una secuencia de Postgres no repite ni bajo carrera. Y por qué arranca en 1201
--  y no en 1: un número de cuatro cifras se lee por teléfono sin ambigüedad y no
--  parece un contador interno recién estrenado.
--
--  El número NO se reutiliza si se borra un proyecto. Es a propósito: la referencia
--  ya viajó en una factura o en un contrato de freelance, y reciclarla haría que dos
--  papeles distintos digan lo mismo.
--
--  Idempotente.
-- ============================================================================

create sequence if not exists public.proyecto_ref_seq
  as bigint start with 1201 increment by 1 minvalue 1201 no cycle;

alter table public.projects
  add column if not exists ref bigint;

-- Los que ya existen también necesitan número, por orden de creación.
update public.projects p
   set ref = nextval('public.proyecto_ref_seq')
 where p.ref is null;

-- A partir de ahora sale solo: quien inserta no tiene que acordarse.
alter table public.projects
  alter column ref set default nextval('public.proyecto_ref_seq');

-- Único de verdad: es una referencia que sale impresa en facturas.
create unique index if not exists projects_ref_key on public.projects (ref);

comment on column public.projects.ref is
  'Referencia del proyecto (1201, 1202…). Va en la factura al cliente y en las de los freelance. No se reutiliza.';

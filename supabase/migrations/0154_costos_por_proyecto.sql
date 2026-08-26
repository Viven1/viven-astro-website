-- ============================================================================
--  COSTOS REALES POR PROYECTO
--
--  Sebastián, 26 ago 2026: "dejame cargar los costos por proyecto por si cambia el
--  crew, o lo que sea". Es la corrección correcta: el catálogo de servicios tiene un
--  costo interno de referencia —y encima solo 8 de 25 lo tienen cargado—, pero lo que
--  de verdad costó un proyecto depende de a quién contrataste ESA vez. El costo es un
--  hecho del proyecto, no del catálogo.
--
--  Cada línea es una plata que salió: una persona del crew, un alquiler, un viaje.
--  Se siembran desde las posiciones del presupuesto (que ya traen un `cost` por línea,
--  aunque en Sonova solo 4 de 13 lo tengan) y de ahí se editan a mano.
-- ============================================================================

create table if not exists public.project_costs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  project_id  bigint not null references public.projects(id) on delete cascade,
  concept     text not null,
  person      text,                 -- quién lo hizo / a quién se le paga
  kind        text not null default 'crew' check (kind in ('crew','equipo','otros')),
  qty         numeric not null default 1,
  unit        text,
  unit_cost   numeric not null default 0,
  paid        boolean not null default false,
  notes       text,
  sort        int not null default 0
);

comment on table public.project_costs is
  'Lo que REALMENTE costó cada proyecto, línea por línea. Independiente del catálogo de servicios: el crew cambia de proyecto a proyecto.';
comment on column public.project_costs.paid is
  'Ya salió la plata. Sirve para separar comprometido de pagado sin inventar un estado más.';

create index if not exists project_costs_proj_idx on public.project_costs (project_id);

create or replace function public.touch_project_costs()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_project_costs_touch on public.project_costs;
create trigger trg_project_costs_touch before update on public.project_costs
  for each row execute function public.touch_project_costs();

alter table public.project_costs enable row level security;
drop policy if exists authenticated_all_project_costs on public.project_costs;
create policy authenticated_all_project_costs on public.project_costs
  for all using (public.is_member()) with check (public.is_member());

-- ---------------------------------------------------------------------------
--  Sembrar desde el presupuesto. Trae TODAS las posiciones, con el costo que ya
--  tengan (en Sonova, 4 de 13 lo traen: CHF 10.510 sobre CHF 22.358 vendidos). Las
--  que vienen en cero quedan igual, en la lista, esperando el número real — que es
--  mejor que no verlas: una línea en cero se completa, una línea que no está se olvida.
-- ---------------------------------------------------------------------------
create or replace function public.sembrar_costos_proyecto(p_project bigint)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int := 0;
begin
  if not public.is_member() then raise exception 'no autorizado'; end if;
  if exists (select 1 from public.project_costs where project_id = p_project) then
    return 0;   -- ya tiene costos cargados: no se pisa nada
  end if;
  insert into public.project_costs (project_id, concept, kind, qty, unit, unit_cost, sort)
  select p_project,
         coalesce(i->>'name', 'Sin nombre'),
         case when (i->>'name') ~* 'kit|equipment|equipmemt|camera|lens|light|led|dolly|drone|gimbal|monitor|prompter|tripod' then 'equipo'
              when (i->>'name') ~* 'producer|director|photograph|gaffer|editor|engineer|assistant|admin|grip|colorist|operator' then 'crew'
              else 'otros' end,
         coalesce((i->>'qty')::numeric, 1),
         i->>'unit',
         coalesce((i->>'cost')::numeric, 0),
         ord
    from public.projects p,
         lateral jsonb_array_elements(coalesce(p.items,'[]'::jsonb)) with ordinality t(i, ord)
   where p.id = p_project;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

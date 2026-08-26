-- ============================================================================
--  HORAS POR PROYECTO — la mitad que faltaba del "tipo Moco"
--
--  Sebastián: "tenemos que ver costos reales de las personas versus el tiempo invertido
--  para ver si lo mantenemos o no. Como si fuera moco.com dentro de nuestro dashboard".
--
--  Los costos ya se cargan (SQL 0154) y las facturas del crew los respaldan (0156).
--  Falta el otro lado: cuánto TIEMPO se puso. Sin eso, un proyecto con buen margen
--  puede estar comiéndose tres semanas de alguien y no se ve en ningún lado.
--
--  Se anotan horas contra el proyecto, con quién y qué hizo. La tarifa interna sale del
--  perfil de cada persona: así "una hora de Sebastián" y "una hora de un freelance" no
--  valen lo mismo, que es justo el punto.
-- ============================================================================

alter table public.team_profiles add column if not exists costo_hora numeric;
comment on column public.team_profiles.costo_hora is
  'Lo que cuesta una hora de esta persona para la empresa (sueldo + cargas / horas del mes). NO es lo que se le factura al cliente.';

create table if not exists public.project_hours (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  project_id  bigint not null references public.projects(id) on delete cascade,
  fecha       date not null default current_date,
  persona     text not null,          -- email del equipo, o nombre de un freelance
  horas       numeric not null check (horas > 0 and horas <= 24),
  tarea       text,
  fase        text                    -- Pre · Rodaje · Post, para cruzar con el presupuesto
);
comment on table public.project_hours is
  'Tiempo puesto en un proyecto. Con el costo_hora de cada persona, es lo que convierte "margen sobre facturas" en "margen de verdad".';
create index if not exists project_hours_proj_idx on public.project_hours (project_id, fecha);

alter table public.project_hours enable row level security;
drop policy if exists miembros_hours on public.project_hours;
create policy miembros_hours on public.project_hours
  for all using (public.is_member()) with check (public.is_member());

-- Cuánto cuesta el tiempo puesto, por proyecto. Las personas sin tarifa cargada se
-- cuentan aparte en vez de sumar cero: sumar cero es decir que su tiempo es gratis.
create or replace function public.horas_de_proyecto(p_project bigint)
returns table(horas_total numeric, costo_horas numeric, horas_sin_tarifa numeric, personas int)
language sql stable security definer set search_path = public as $$
  select
    coalesce(sum(h.horas), 0),
    coalesce(sum(h.horas * coalesce(t.costo_hora, 0)), 0),
    coalesce(sum(case when coalesce(t.costo_hora, 0) = 0 then h.horas else 0 end), 0),
    count(distinct h.persona)::int
  from public.project_hours h
  left join public.team_profiles t on lower(t.email) = lower(h.persona)
  where h.project_id = p_project;
$$;

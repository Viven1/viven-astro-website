-- ============================================================================
--  FACTURAS DEL CREW → bexio → margen real
--
--  Sebastián, 26 ago 2026: "ideal sería poder subir facturas de la crew al dashboard
--  para enviar a bexio y saber el margen real de cada proyecto".
--
--  El circuito: subís el PDF/foto → la IA lee proveedor, número, fecha e importes →
--  queda como línea de costo del proyecto (así el margen deja de ser una estimación) →
--  y de ahí se manda a bexio como factura de PROVEEDOR, siempre en borrador.
--
--  Probado antes de escribir nada: el token de bexio que ya tenemos llega a
--  4.0/purchase/bills (status 200) y ahí ya hay facturas de crew cargadas a mano.
-- ============================================================================

-- El bucket es PRIVADO: son facturas con datos bancarios de gente real. Se leen con
-- URLs firmadas de vida corta, nunca por link público.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-bills', 'project-bills', false, 20971520,
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set public = false, file_size_limit = 20971520;

create table if not exists public.project_bills (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  project_id   bigint not null references public.projects(id) on delete cascade,
  cost_id      bigint references public.project_costs(id) on delete set null,

  file_path    text not null,
  file_name    text,
  mime         text,
  size_bytes   bigint,

  -- lo que la IA leyó del documento (y se puede corregir a mano)
  supplier     text,
  vendor_ref   text,           -- el número de factura del proveedor
  bill_date    date,
  due_date     date,
  currency     text default 'CHF',
  net          numeric,
  vat          numeric,
  gross        numeric,
  iban         text,
  extracted    jsonb,          -- la lectura completa, para poder auditar qué vio

  estado       text not null default 'nueva'
               check (estado in ('nueva','leida','revisada','en_bexio','descartada')),
  bexio_id     text,
  bexio_no     text,
  subido_por   text,
  notas        text
);

comment on table public.project_bills is
  'Facturas de proveedor (crew, alquileres) de un proyecto. El archivo vive en el bucket privado project-bills.';
comment on column public.project_bills.extracted is
  'Lo que la IA leyó, completo. Se guarda para poder ver DE DÓNDE salió un número cuando no cuadra.';
comment on column public.project_bills.cost_id is
  'La línea de costo que esta factura respalda. Es lo que convierte el margen estimado en margen real.';

create index if not exists project_bills_proj_idx on public.project_bills (project_id);

create or replace function public.touch_project_bills()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_project_bills_touch on public.project_bills;
create trigger trg_project_bills_touch before update on public.project_bills
  for each row execute function public.touch_project_bills();

alter table public.project_bills enable row level security;
drop policy if exists authenticated_all_project_bills on public.project_bills;
create policy authenticated_all_project_bills on public.project_bills
  for all using (public.is_member()) with check (public.is_member());

-- Storage: solo el equipo entra al bucket. Nadie de afuera, ni con el link.
drop policy if exists "project_bills_miembros" on storage.objects;
create policy "project_bills_miembros" on storage.objects
  for all to authenticated
  using (bucket_id = 'project-bills' and public.is_member())
  with check (bucket_id = 'project-bills' and public.is_member());

-- Una factura respaldada vale más que una línea escrita a mano: esta vista dice cuánto
-- del costo del proyecto tiene papel atrás. Sin eso, "margen real" sigue siendo una
-- palabra.
create or replace view public.proyecto_costo_respaldado as
select p.id as project_id,
       coalesce(sum(c.qty * c.unit_cost), 0) as costo_total,
       coalesce(sum(case when exists (select 1 from public.project_bills b where b.cost_id = c.id)
                         then c.qty * c.unit_cost else 0 end), 0) as costo_con_factura,
       count(c.id) as lineas,
       count(c.id) filter (where exists (select 1 from public.project_bills b where b.cost_id = c.id)) as lineas_con_factura
  from public.projects p
  left join public.project_costs c on c.project_id = p.id
 group by p.id;

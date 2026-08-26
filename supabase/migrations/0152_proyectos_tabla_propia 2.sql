-- ============================================================================
--  PROYECTOS — tabla propia (corrige la 0151)
--
--  La 0151 metió los campos del proyecto como columnas de `deals`. Sebastián lo
--  corrigió, y tiene razón por dos motivos distintos:
--
--   1. Navegación: "idealmente menú de proyectos y podemos ver uno por uno, así
--      tenemos mejor overview. Porque buscarlo dentro del deal no se usa jamás."
--   2. Volumen: la lista de campos que pidió —equipo técnico, crew, locación,
--      contacto del cliente, quién edita, plan de rodaje, script, storyboard—
--      son dieciséis campos de PRODUCCIÓN colgando de una tabla que es de VENTA.
--      Ese no es su lugar.
--
--  Un proyecto sigue siendo 1:1 con un deal ganado (deal_id unique), así que no hay
--  dos verdades: el deal dice qué se vendió, el proyecto qué se produce.
--  El portal del cliente pasa a leer projects.stage — existía desde julio y nunca se
--  encendió porque el campo estaba en NULL en los 197 deals.
-- ============================================================================

create table if not exists public.projects (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deal_id       uuid not null unique references public.deals(id) on delete cascade,
  lead_id       bigint,
  title         text,

  -- las cinco etapas que definió Sebastián
  stage         text not null default 'desarrollo'
                check (stage in ('desarrollo','preproduccion','rodaje','post','entregado')),
  started_at    timestamptz,
  delivered_at  timestamptz,

  -- plata: heredada del paquete que el cliente aceptó. COPIA, no referencia —
  -- si mañana se edita la propuesta, lo acordado no cambia solo.
  amount_chf    numeric,
  items         jsonb,

  -- fechas de producción
  shoot_start   date,
  shoot_end     date,
  delivery_due  date,

  -- gente
  crew          jsonb,          -- [{rol, nombre, email, tel}]
  editor        text,           -- quién edita
  client_contact       text,
  client_contact_email text,
  client_contact_phone text,

  -- producción
  location        text,
  gear            jsonb,        -- equipo técnico: [{nombre, notas}]
  shooting_plan   text,         -- plan de rodaje (link o texto)
  script_url      text,
  storyboard_url  text,
  deliverable_url text,
  portal_note     text,         -- lo que el cliente lee en su portal
  notes           text,         -- interno, no lo ve el cliente

  archived      boolean not null default false
);

comment on table public.projects is
  'Un proyecto por deal ganado. Nace solo cuando el deal pasa a ganado (trigger) y hereda el paquete aceptado.';
comment on column public.projects.items is
  'Posiciones del tier que el cliente aceptó. Copia deliberada: editar la propuesta después no cambia el proyecto.';
comment on column public.projects.notes is
  'Notas internas. NO se muestran en el portal del cliente — eso es portal_note.';

create index if not exists projects_stage_idx on public.projects (stage) where not archived;
create index if not exists projects_lead_idx  on public.projects (lead_id);

create or replace function public.touch_projects_updated()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_projects_touch on public.projects;
create trigger trg_projects_touch before update on public.projects
  for each row execute function public.touch_projects_updated();

-- ---------------------------------------------------------------------------
--  Mismos permisos que el resto: solo el equipo. El portal del cliente NO entra
--  por acá — entra por get-portal, que usa service role y valida el token.
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;
drop policy if exists authenticated_select_projects on public.projects;
drop policy if exists authenticated_insert_projects on public.projects;
drop policy if exists authenticated_update_projects on public.projects;
drop policy if exists authenticated_delete_projects on public.projects;
create policy authenticated_select_projects on public.projects for select using (public.is_member());
create policy authenticated_insert_projects on public.projects for insert with check (public.is_member());
create policy authenticated_update_projects on public.projects for update using (public.is_member()) with check (public.is_member());
create policy authenticated_delete_projects on public.projects for delete using (public.is_member());

-- ---------------------------------------------------------------------------
--  El proyecto nace al ganar (reemplaza al trigger de la 0151, que escribía en deals)
-- ---------------------------------------------------------------------------
create or replace function public.deal_ganado_crea_proyecto()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_total numeric;
  v_tier  jsonb;
  v_items jsonb;
  v_nombre text;
  v_email  text;
  v_tel    text;
begin
  if new.stage is distinct from 'ganado' then return new; end if;
  if coalesce(old.stage,'') = 'ganado' then return new; end if;
  if exists (select 1 from public.projects p where p.deal_id = new.id) then return new; end if;

  -- el paquete que el cliente aceptó
  select p.accepted_total,
         (select t from jsonb_array_elements(coalesce(p.content->'tiers','[]'::jsonb)) t
           where t->>'name' = p.accepted_tier limit 1)
    into v_total, v_tier
    from public.proposals p
   where p.status = 'accepted' and (p.deal_id = new.id or p.lead_id::text = new.lead_id::text)
   order by p.accepted_at desc nulls last limit 1;
  v_items := v_tier->'items';

  -- si no hubo propuesta web, la oferta ganada
  if v_items is null then
    select o.items into v_items from public.offers o
     where o.status = 'won' and o.lead_id::text = new.lead_id::text and not coalesce(o.archived,false)
     order by o.updated_at desc limit 1;
  end if;

  -- el contacto del cliente sale de la persona del deal
  select l.name, l.email, l.phone into v_nombre, v_email, v_tel
    from public.leads l where l.id = new.lead_id;

  insert into public.projects (deal_id, lead_id, title, stage, started_at, amount_chf, items,
                               client_contact, client_contact_email, client_contact_phone)
  values (new.id, new.lead_id, new.title, 'desarrollo', coalesce(new.won_at, now()),
          coalesce(v_total, new.deal_value), v_items, v_nombre, v_email, v_tel);
  return new;
end $$;

drop trigger if exists trg_deal_ganado_crea_proyecto on public.deals;
create trigger trg_deal_ganado_crea_proyecto
  after update on public.deals
  for each row execute function public.deal_ganado_crea_proyecto();

-- ---------------------------------------------------------------------------
--  Mudar lo que la 0151 había dejado en deals, y sacarle esas columnas.
--  Sólo los ganados VIVOS: los 172 archivados son cartera histórica de bexio,
--  proyectos que terminaron hace años. Marcarlos "en desarrollo" sería inventar
--  trabajo que no existe.
-- ---------------------------------------------------------------------------
insert into public.projects (deal_id, lead_id, title, stage, started_at, amount_chf, items,
                             client_contact, client_contact_email, client_contact_phone)
select d.id, d.lead_id, d.title,
       coalesce(nullif(d.production_status,''), 'desarrollo'),
       coalesce(d.project_started_at, d.won_at, now()),
       d.project_amount, d.project_items,
       l.name, l.email, l.phone
  from public.deals d left join public.leads l on l.id = d.lead_id
 where d.stage = 'ganado' and not coalesce(d.archived,false)
   and not exists (select 1 from public.projects p where p.deal_id = d.id)
on conflict (deal_id) do nothing;

update public.projects p
   set shoot_start = d.shoot_start, shoot_end = d.shoot_end, delivery_due = d.delivery_due,
       notes = coalesce(p.notes, d.project_notes),
       portal_note = coalesce(p.portal_note, d.portal_note),
       deliverable_url = coalesce(p.deliverable_url, d.deliverable_url)
  from public.deals d where d.id = p.deal_id;

alter table public.deals drop column if exists project_started_at;
alter table public.deals drop column if exists shoot_start;
alter table public.deals drop column if exists shoot_end;
alter table public.deals drop column if exists delivery_due;
alter table public.deals drop column if exists project_amount;
alter table public.deals drop column if exists project_items;
alter table public.deals drop column if exists project_notes;
alter table public.deals drop column if exists production_status;
alter table public.deals drop column if exists portal_note;
alter table public.deals drop column if exists deliverable_url;
-- portal_token SE QUEDA en deals: es el handle público del deal y la URL del portal
-- (/portal/?id=<deal_id>&t=<token>) ya se arma con él. Moverlo rompería links vivos.
drop index if exists deals_produccion_idx;

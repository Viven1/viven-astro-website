-- ============================================================================
--  Los contactos del proyecto, y los pasos.
--
--  Sebastián, 26 ago 2026:
--  · "la info del cliente tiene que estar acá dentro también para poder enviarle cosas.
--     O la toma de la persona ganada, o nos deja elegir una persona, o crear nuevas.
--     Incluso a varias se le puede mandar algo."
--  · "necesito que mires proyecto y simplifiques todo… empezá paso por paso: project
--     brief, guion, crew, plan de rodaje, rodaje, post-producción."
--
--  ── Por qué una tabla y no una columna más en `projects` ──
--  Un proyecto le manda cosas a más de una persona y NO a todas lo mismo: el que aprueba
--  el corte no es el que recibe la factura, y legal solo quiere la entrega final. Eso es
--  una relación, no un campo. `projects.client_contact` (texto suelto) se queda como
--  estaba para no romper nada, y pasa a ser un espejo del contacto principal.
--
--  ── `recibe`, y por qué no es un booleano ──
--  "Activo sí/no" obliga a acordarse de tildar y destildar antes de cada envío. El tipo
--  dice de una qué recibe cada uno, y el envío pre-tilda a los que corresponden. Se puede
--  cambiar en el momento: es un punto de partida, no una regla.
--
--  ── Los pasos ──
--  Se calculan solos —hay crew cargado, pasó la fecha de rodaje, el brief volvió— y por
--  eso NO se guardan. Lo único que se guarda es lo que la app NO puede saber: cuando
--  Sebastián da un paso por hecho igual. Se rodó y no se cargó nada, y una app que le
--  discute eso molesta. Un ✓ automático nunca es un reproche.
--
--  Idempotente.
-- ============================================================================

create table if not exists public.project_contacts (
  id          bigint generated always as identity primary key,
  project_id  bigint not null,
  lead_id     bigint,                        -- si es alguien que ya está en Personas
  name        text,
  email       text,
  role        text,                          -- "Marketing", "Legal"…
  recibe      text not null default 'copia', -- 'principal' | 'copia' | 'entregas' | 'facturas'
  notas       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Una persona una sola vez por proyecto. Sin esto, dos ventanas abiertas la agregan dos
-- veces y el email le llega duplicado — que es exactamente lo que ya pasó con los leads.
create unique index if not exists project_contacts_email_uniq
  on public.project_contacts (project_id, lower(email)) where (email is not null);
create index if not exists project_contacts_proj_idx
  on public.project_contacts (project_id);

-- Un solo principal por proyecto: es el que hereda `projects.client_contact` y el que
-- contesta por defecto. Con dos, no habría a quién escribirle primero.
create unique index if not exists project_contacts_un_principal
  on public.project_contacts (project_id) where (recibe = 'principal');

alter table public.project_contacts enable row level security;
do $$ begin
  create policy project_contacts_auth_all on public.project_contacts
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create or replace function public.touch_project_contacts()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_project_contacts_touch on public.project_contacts;
create trigger trg_project_contacts_touch before update on public.project_contacts
  for each row execute function public.touch_project_contacts();

-- Los pasos que se dieron por hechos a mano. Array de claves: ['crew','rodaje'].
alter table public.projects
  add column if not exists pasos_forzados text[] not null default '{}';

comment on column public.projects.pasos_forzados is
  'Pasos que Sebastián dio por hechos aunque los datos digan que no. Se rodó y no se cargó nada: sin marcar no es sin filmar.';
comment on column public.project_contacts.recibe is
  'principal | copia | entregas | facturas. Decide a quién se pre-tilda en cada envío; siempre se puede cambiar antes de mandar.';

-- ── Sembrar: cada proyecto que ya tiene contacto arranca con él como principal ──
insert into public.project_contacts (project_id, lead_id, name, email, recibe)
select p.id, p.lead_id,
       coalesce(nullif(p.client_contact, ''), l.name),
       lower(coalesce(nullif(p.client_contact_email, ''), l.email)),
       'principal'
  from public.projects p
  left join public.leads l on l.id = p.lead_id
 where coalesce(nullif(p.client_contact_email, ''), l.email) is not null
   and not exists (select 1 from public.project_contacts c where c.project_id = p.id)
on conflict do nothing;

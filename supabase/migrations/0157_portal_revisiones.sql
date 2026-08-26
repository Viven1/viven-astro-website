-- ============================================================================
--  EL PORTAL DEL CLIENTE, VERSIÓN FRAME.IO
--
--  Sebastián, 26 ago 2026: que el cliente entre a un portal privado, vea el video,
--  baje los archivos y deje feedback — y que esas notas se puedan sacar con timecode
--  para Premiere. Acceso elegido por él: link + código de 6 dígitos al email.
--
--  Tres tablas y un detalle de seguridad que vale escribir: el código se manda SIEMPRE
--  a la dirección que está en la ficha del contacto, nunca a una que escriba el
--  visitante. Si no, cualquiera con el link se manda el código a sí mismo y aprueba.
-- ============================================================================

create table if not exists public.project_versions (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  project_id  bigint not null references public.projects(id) on delete cascade,
  n           int not null,
  title       text,
  video_url   text,                -- Vimeo/YouTube: el video sigue donde ya vive
  notes       text,                -- qué cambió en esta versión (lo lee el cliente)
  created_by  text,
  approved_at timestamptz,
  approved_by text,
  approved_ip text,
  unique (project_id, n)
);
comment on table public.project_versions is
  'Cada corte que se le manda al cliente. Los comentarios cuelgan de una versión: sin eso, en la v3 seguís viendo quejas de la v1 y nadie sabe qué sigue vivo.';

create table if not exists public.project_comments (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  project_id  bigint not null references public.projects(id) on delete cascade,
  version_id  bigint references public.project_versions(id) on delete cascade,
  tc_ms       int,                 -- milisegundo exacto del video. null = comentario general
  body        text not null,
  author_name text,
  author_email text,
  from_client boolean not null default true,
  resolved    boolean not null default false,
  resolved_at timestamptz,
  task_id     bigint               -- si se pasó a tarea, cuál
);
comment on column public.project_comments.tc_ms is
  'Milisegundos desde el inicio del video. Es lo que hace que la nota valga: "en el 0:34", no "en algún momento del principio".';
create index if not exists project_comments_proj_idx on public.project_comments (project_id, version_id);

create table if not exists public.project_files (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  project_id  bigint not null references public.projects(id) on delete cascade,
  file_path   text not null,
  file_name   text,
  mime        text,
  size_bytes  bigint,
  visible_cliente boolean not null default true,
  subido_por  text
);
comment on column public.project_files.visible_cliente is
  'Un archivo puede estar cargado y todavía no ser para el cliente. Por defecto sí lo es — lo contrario sorprende.';

-- Acceso del cliente: código de 6 dígitos a SU dirección
create table if not exists public.portal_access (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  project_id   bigint not null references public.projects(id) on delete cascade,
  email        text not null,
  code_hash    text,                -- nunca el código en claro
  code_expires timestamptz,
  intentos     int not null default 0,
  token        text,                -- lo que queda en el navegador del cliente
  token_expires timestamptz,
  last_ip      text
);
create index if not exists portal_access_proj_idx on public.portal_access (project_id);

-- Bucket privado de entregables. Se sirve solo por URL firmada desde la función.
insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 5368709120)
on conflict (id) do update set public = false, file_size_limit = 5368709120;

alter table public.project_versions enable row level security;
alter table public.project_comments enable row level security;
alter table public.project_files    enable row level security;
alter table public.portal_access    enable row level security;

-- El equipo entra por RLS; el cliente NUNCA toca estas tablas directo — pasa por las
-- edge functions, que validan el token y usan service role.
drop policy if exists miembros_versions on public.project_versions;
drop policy if exists miembros_comments on public.project_comments;
drop policy if exists miembros_files    on public.project_files;
drop policy if exists miembros_access   on public.portal_access;
create policy miembros_versions on public.project_versions for all using (public.is_member()) with check (public.is_member());
create policy miembros_comments on public.project_comments for all using (public.is_member()) with check (public.is_member());
create policy miembros_files    on public.project_files    for all using (public.is_member()) with check (public.is_member());
create policy miembros_access   on public.portal_access    for all using (public.is_member()) with check (public.is_member());

drop policy if exists "project_files_miembros" on storage.objects;
create policy "project_files_miembros" on storage.objects
  for all to authenticated
  using (bucket_id = 'project-files' and public.is_member())
  with check (bucket_id = 'project-files' and public.is_member());

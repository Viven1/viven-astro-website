-- 0077: sistema de roles (prerrequisito real para el módulo Cash Flow).
--
-- HOY no existe NINGUNA columna role/is_admin en ninguna tabla, y las RLS
-- son uniformemente `for all to authenticated using (true)` en ~26 tablas:
-- cualquier usuario autenticado (Sofia incluida) tiene acceso total de
-- lectura/escritura a TODO. Esta migración agrega una tabla mínima de roles
-- + una función is_superadmin() para que las tablas nuevas (Cash Flow) puedan
-- restringirse de verdad vía RLS. NO toca las policies de las tablas existentes
-- (eso sería un cambio de alcance mucho mayor, fuera de este pedido puntual).

create table if not exists public.user_roles (
  email text primary key,
  role text not null default 'member' check (role in ('member','superadmin')),
  created_at timestamptz not null default now()
);

insert into public.user_roles (email, role) values ('sebastian@viven.ch', 'superadmin')
  on conflict (email) do update set role = 'superadmin';
insert into public.user_roles (email, role) values ('sofia@viven.ch', 'member')
  on conflict (email) do nothing;

alter table public.user_roles enable row level security;
-- cualquier autenticado puede LEER su propio rol (y los demás, no es sensible) para que el frontend
-- sepa si mostrar el tab; solo escritura vía migraciones/service role, no hay policy de insert/update.
drop policy if exists "user_roles read" on public.user_roles;
create policy "user_roles read" on public.user_roles for select to authenticated using (true);

create or replace function public.is_superadmin()
returns boolean
language sql
security definer
stable
as $$
  select exists(
    select 1 from public.user_roles
    where email = auth.jwt()->>'email' and role = 'superadmin'
  );
$$;

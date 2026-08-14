-- 0127: que "estar logueado" deje de ser lo mismo que "tener acceso".
--
-- QUÉ PASABA (medido el 2026-08-14 contra /auth/v1/settings del proyecto):
--   disable_signup: false  → el alta de usuarios estaba ABIERTA, y la clave
--   publishable está en texto plano en el JS de www.viven.ch/dashboard/.
--   Cualquiera se registraba con su propio email, confirmaba desde su propia
--   casilla y obtenía un token `authenticated` legítimo. Con las policies
--   `for all to authenticated using (true)` de 0001..0126, ese token leía Y
--   escribía TODO: leads con nombre y email, facturas, propuestas, email_log
--   con conversaciones de clientes, plantillas. Datos personales de clientes
--   suizos, o sea Datenschutz, no "un bug".
--
-- LA IDEA: cerrar el alta (se hace por API de Auth, no acá) es la puerta.
-- Esto es la pared. A partir de acá el token no alcanza: hay que estar en
-- public.user_roles. Si el alta se vuelve a abrir por error algún día —o
-- alguien queda con un token viejo— sigue sin poder leer nada.
--
-- POR QUÉ ALTER POLICY Y NO DROP + CREATE: son ~55 policies repartidas en 126
-- migraciones, cada una con su nombre, su comando (select/insert/update/all) y
-- su rol. Reescribirlas a mano es la forma segura de equivocarse en una y
-- dejarla abierta, o de romper una que sí estaba bien. ALTER POLICY cambia
-- SOLO la condición y deja intacto todo lo demás.
--
-- QUÉ NO TOCA (a propósito). Medido contra pg_policies el 2026-08-14, no
-- deducido de las migraciones — que es como se descubrió el segundo caso:
--   · Las 7 policies solo-`anon` (ab_hits, ab_tests, briefs, video_plays…): son
--     el sitio público escribiendo analítica y leyendo tests A/B. Si las
--     cerramos, el sitio deja de medir.
--   · Las 2 que son `anon` Y `authenticated` a la vez —funnel_events_insert_anon
--     y ux_signals_insert_anon—. Un filtro por "tiene authenticated" las agarra,
--     y reescribirlas rompe el tracking del sitio público para los visitantes
--     anónimos, que son todos. Por eso el filtro excluye explícitamente toda
--     policy donde aparezca `anon`.
--   · Las 5 de cashflow: ya son `is_superadmin()`, su condición no es `true`,
--     el filtro las saltea solo.
--
-- Alcance real, ya aplicado y contado el 2026-08-14: 63 policies reescritas.
-- Las 2 compartidas con anon y las 7 solo-anon quedaron intactas, y después de
-- correrla no quedó NINGUNA policy de `authenticated` con condición `true`.

-- ---------------------------------------------------------------------------
-- 1. Quién es "de la casa"
-- ---------------------------------------------------------------------------
-- security definer: la función lee user_roles saltando RLS. Es lo que evita la
-- recursión infinita cuando la propia policy de user_roles la llama.
-- set search_path: sin esto, un search_path manipulado puede hacer que
-- "user_roles" resuelva a otra tabla. is_superadmin() (0077) tampoco lo tenía
-- y se lo agregamos abajo, mismo motivo.
create or replace function public.is_member()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(
    select 1 from public.user_roles
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- el email en el JWT puede venir con mayúsculas según cómo se dio de alta;
-- comparar exacto dejaba afuera a un miembro legítimo (falla cerrada, pero
-- falla). Mismo criterio que is_member().
create or replace function public.is_superadmin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(
    select 1 from public.user_roles
    where lower(email) = lower(auth.jwt() ->> 'email') and role = 'superadmin'
  );
$$;

revoke execute on function public.is_member() from anon;
revoke execute on function public.is_superadmin() from anon;

-- ---------------------------------------------------------------------------
-- 2. Reescribir toda policy de `authenticated` cuya condición sea `true`
-- ---------------------------------------------------------------------------
-- Deja constancia de cada una en una tabla, porque un cambio de permisos que
-- no se puede auditar después es un cambio que nadie se anima a revertir.
create table if not exists public.rls_lockdown_log (
  id bigserial primary key,
  applied_at timestamptz not null default now(),
  tabla text not null,
  policy_name text not null,
  cambio text not null
);
-- Sin esto, la tabla que registra el cierre de permisos nace ella misma abierta:
-- toda tabla nueva en `public` la sirve PostgREST, y sin RLS no hay policy que
-- la proteja. Pasó en la primera pasada de esta misma migración (2026-08-14) y
-- lo cazó la vista rls_auditoria de acá abajo — que es exactamente para lo que
-- está. Es un registro de auditoría: se lee, no se edita.
alter table public.rls_lockdown_log enable row level security;
drop policy if exists rls_lockdown_log_read on public.rls_lockdown_log;
create policy rls_lockdown_log_read on public.rls_lockdown_log
  for select to authenticated using (public.is_superadmin());

do $$
declare
  p record;
  sql text;
begin
  for p in
    select schemaname, tablename, policyname, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and 'authenticated' = any(roles)
      -- el sitio público escribe con rol anon; una policy que lo incluya NO se
      -- toca aunque además tenga authenticated (ver nota de arriba)
      and not ('anon' = any(roles))
      -- solo las abiertas de par en par; si alguien ya puso una condición real,
      -- no la pisamos: puede ser más estricta que la nuestra
      and (qual = 'true' or with_check = 'true')
  loop
    sql := format('alter policy %I on public.%I', p.policyname, p.tablename);

    -- INSERT no tiene USING, solo WITH CHECK. SELECT/DELETE no tienen WITH
    -- CHECK. ALL y UPDATE tienen los dos. Mandar la cláusula que no corresponde
    -- es un error de sintaxis, así que se arma según lo que la policy ya tenga.
    if p.qual is not null then
      sql := sql || ' using (public.is_member())';
    end if;
    if p.with_check is not null then
      sql := sql || ' with check (public.is_member())';
    end if;

    execute sql;

    insert into public.rls_lockdown_log (tabla, policy_name, cambio)
    values (p.tablename, p.policyname, 'true → is_member()');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. La misma pared para la tabla de roles
-- ---------------------------------------------------------------------------
-- Con la policy de 0077 (`using (true)`) cualquier autenticado leía la lista
-- completa del equipo. El paso 2 ya la cerró a miembros; la escritura no tiene
-- policy y sigue siendo solo por service_role — o sea, por la función
-- admin-users, que verifica superadmin antes de tocar nada.
alter table public.user_roles enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Red de seguridad: avisar de lo que quedó afuera
-- ---------------------------------------------------------------------------
-- Una tabla en `public` SIN RLS activada es un agujero abierto, no un descuido
-- menor: PostgREST la expone y ninguna policy la protege porque no hay policies
-- que aplicar. Y una CON RLS pero SIN ninguna policy queda ilegible incluso
-- para nosotros. Las dos cosas hay que verlas, no adivinarlas: esta vista se
-- consulta después de correr la migración.
create or replace view public.rls_auditoria as
select
  c.relname as tabla,
  c.relrowsecurity as rls_activada,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
  case
    when not c.relrowsecurity then '🔴 SIN RLS — expuesta'
    when (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) = 0 then '⚠️ RLS sin policies — nadie puede leerla'
    else '✅'
  end as estado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, c.relname;

-- Después de aplicar, correr y revisar que no quede ningún 🔴:
--   select * from public.rls_auditoria where estado <> '✅';
--   select tabla, policy_name from public.rls_lockdown_log order by id;

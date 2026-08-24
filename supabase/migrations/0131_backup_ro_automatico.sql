-- 0131: que una tabla nueva no vuelva a frenar el respaldo.
--
-- QUÉ PASÓ (2026-08-23): el respaldo diario falló. La guardia del workflow hizo
-- lo suyo y avisó: "Estas tablas quedarían VACÍAS en el respaldo:
-- newsletter_welcomes". Esa tabla la creó la migración 0130 y nadie le dio el
-- permiso de lectura que el usuario de respaldo necesita, así que se habría
-- guardado vacía. Ya había pasado el 19 con otra tabla.
--
-- El diseño estaba bien —frenar es mejor que guardar un respaldo incompleto—
-- pero le faltaba la otra mitad: que el permiso se ponga solo. Si cada tabla
-- nueva exige que alguien se acuerde de un paso manual, el respaldo se va a
-- romper cada vez que el proyecto crezca, que es justo cuando más importa.
--
-- Por qué hace falta el permiso: viven_backup_ro no puede saltarse las políticas
-- de seguridad (eso pide superusuario y en Supabase nadie lo es), así que
-- pg_dump corre CON las políticas puestas y solo ve lo que ellas le dejan ver.

-- ---------------------------------------------------------------------------
-- 1. Ponerle el permiso a lo que hoy le falta (incluida newsletter_welcomes)
-- ---------------------------------------------------------------------------
do $$
declare t record; n int := 0;
begin
  if not exists (select 1 from pg_roles where rolname = 'viven_backup_ro') then
    raise notice 'no existe viven_backup_ro — nada que hacer';
    return;
  end if;
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
      and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = pg_tables.tablename
                        and p.policyname = 'backup_ro_read')
  loop
    execute format('create policy backup_ro_read on public.%I for select to viven_backup_ro using (true)', t.tablename);
    n := n + 1;
  end loop;
  raise notice 'permisos agregados: %', n;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Y que las próximas lo reciban solas
-- ---------------------------------------------------------------------------
create or replace function public.backup_ro_tabla_nueva()
returns event_trigger
language plpgsql
security definer
set search_path = public
as $$
declare obj record;
begin
  -- Si el rol no existe (proyecto nuevo, restore parcial), no hacer nada. Sin
  -- esto, un CREATE TABLE fallaría por culpa del disparador.
  if not exists (select 1 from pg_roles where rolname = 'viven_backup_ro') then
    return;
  end if;

  for obj in select * from pg_event_trigger_ddl_commands() loop
    if obj.schema_name = 'public' and obj.command_tag in ('CREATE TABLE', 'CREATE TABLE AS') then
      begin
        execute format('drop policy if exists backup_ro_read on %s', obj.object_identity);
        execute format('create policy backup_ro_read on %s for select to viven_backup_ro using (true)', obj.object_identity);
      exception when others then
        -- NUNCA romper un CREATE TABLE por esto. Si algo sale mal, avisa y
        -- sigue: la guardia del workflow de respaldo lo va a cazar igual, que
        -- es la red que ya existe. Un disparador que aborta migraciones es
        -- mucho peor que un respaldo que avisa.
        raise warning 'backup_ro_read no se pudo poner en %: %', obj.object_identity, sqlerrm;
      end;
    end if;
  end loop;
end $$;

drop event trigger if exists backup_ro_tabla_nueva_tg;
create event trigger backup_ro_tabla_nueva_tg
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS')
  execute function public.backup_ro_tabla_nueva();

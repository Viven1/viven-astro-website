-- ============================================================
--  VIVEN.CH — ESQUEMA COMPLETO (fuente única de verdad)
--  Pega TODO esto en Supabase → SQL Editor → Run.
--  Es idempotente: se puede correr las veces que quieras sin romper nada.
--  Cada vez que el sitio cambie el backend, vuelve a correr ESTE archivo
--  (y solo este) — así nunca falta una columna ni una policy.
--  El aviso "destructive operations" es normal (por los DROP POLICY): confirma.
-- ============================================================

-- ---------- Columnas de LEADS ----------
alter table public.leads
  add column if not exists first_name   text,
  add column if not exists last_name    text,
  add column if not exists session_id   text,
  add column if not exists channel      text,
  add column if not exists gclid        text,
  add column if not exists utm_source   text,
  add column if not exists utm_campaign text,
  add column if not exists landing_path text,
  add column if not exists lang         text;

-- separar nombre/apellido en leads viejos (mejor esfuerzo)
update public.leads
   set first_name = split_part(trim(name), ' ', 1),
       last_name  = nullif(trim(substr(trim(name), length(split_part(trim(name), ' ', 1)) + 2)), '')
 where first_name is null and name is not null;

-- ---------- Columnas de PAGEVIEWS ----------
alter table public.pageviews
  add column if not exists pv_id        uuid,
  add column if not exists referrer     text,
  add column if not exists channel      text,
  add column if not exists utm_source   text,
  add column if not exists utm_medium   text,
  add column if not exists utm_campaign text,
  add column if not exists utm_term     text,
  add column if not exists utm_content  text,
  add column if not exists gclid        text,
  add column if not exists fbclid       text,
  add column if not exists lang         text,
  add column if not exists is_entry     boolean default false;

create unique index if not exists pageviews_pv_id_key on public.pageviews (pv_id) where pv_id is not null;

-- índices de consulta
create index if not exists leads_created_at_idx     on public.leads (created_at desc);
create index if not exists leads_status_idx         on public.leads (status);
create index if not exists pageviews_created_at_idx on public.pageviews (created_at desc);
create index if not exists pageviews_channel_idx    on public.pageviews (channel);
create index if not exists pageviews_entry_idx      on public.pageviews (is_entry) where is_entry;

-- ---------- Tiempo en página (RPC segura) ----------
create or replace function public.update_duration(pv uuid, secs integer)
returns void language sql security definer set search_path = public as $$
  update public.pageviews
     set duration = greatest(coalesce(duration, 0), least(secs, 7200))
   where pv_id = pv;
$$;
revoke all on function public.update_duration(uuid, integer) from public;
grant execute on function public.update_duration(uuid, integer) to anon, authenticated;

-- ============================================================
--  SEGURIDAD (RLS)
--  Visitantes anónimos: SOLO insertar. Nada de leer/editar/borrar.
--  Dueño (sebastian@viven.ch, logueado): leer todo + editar/borrar leads.
-- ============================================================
alter table public.leads       enable row level security;
alter table public.pageviews   enable row level security;
alter table public.video_stats enable row level security;

-- limpiar policies previas (cualquier nombre/email)
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('leads','pageviews','video_stats')
  loop execute format('drop policy %I on public.%I', p.policyname, p.tablename); end loop;
end $$;

-- visitantes: insertar
create policy "anon insert" on public.leads       for insert to anon with check (true);
create policy "anon insert" on public.pageviews   for insert to anon with check (true);
create policy "anon insert" on public.video_stats for insert to anon with check (true);

-- update_duration corre como definer, pero anon también puede update directo del propio pv:
-- lo dejamos SOLO vía RPC, así que no creamos policy de update para anon.

-- dueño: leer todo
create policy "owner read" on public.leads       for select to authenticated using ((auth.jwt()->>'email') = 'sebastian@viven.ch');
create policy "owner read" on public.pageviews   for select to authenticated using ((auth.jwt()->>'email') = 'sebastian@viven.ch');
create policy "owner read" on public.video_stats for select to authenticated using ((auth.jwt()->>'email') = 'sebastian@viven.ch');

-- dueño: editar y borrar leads (cambiar estado, limpiar spam/pruebas)
create policy "owner update leads" on public.leads for update to authenticated
  using ((auth.jwt()->>'email') = 'sebastian@viven.ch') with check ((auth.jwt()->>'email') = 'sebastian@viven.ch');
create policy "owner delete leads" on public.leads for delete to authenticated
  using ((auth.jwt()->>'email') = 'sebastian@viven.ch');

-- ============================================================================
--  Viven — follow-ups + analytics server-side + notificaciones
--  Correr una vez en el SQL Editor de Supabase (proyecto lumoevaotokgqnpybkyf).
--  Idempotente: se puede correr de nuevo sin romper nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Columnas de follow-up en leads
-- ---------------------------------------------------------------------------
alter table public.leads add column if not exists contacted_at     timestamptz;
alter table public.leads add column if not exists next_follow_up_at timestamptz;
alter table public.leads add column if not exists follow_up_count   int not null default 0;
alter table public.leads add column if not exists last_followup_sent_at timestamptz;

-- Cadencia escalada (días desde "contacted"): +2, +4, +7, +14, luego mensual.
-- Cambiá estos números y listo — el trigger y el cron los usan.
create or replace function public.followup_offsets()
returns int[] language sql immutable as $$ select array[2,4,7,14,44,74]::int[] $$;

-- Cuando un lead pasa a "contacted"/"contactado" por primera vez, programa el 1er follow-up.
create or replace function public.on_lead_contacted()
returns trigger language plpgsql as $$
declare offs int[] := public.followup_offsets();
begin
  if new.status in ('contacted','contactado')
     and (old.status is distinct from new.status)
     and new.contacted_at is null then
    new.contacted_at := now();
    new.follow_up_count := 0;
    new.next_follow_up_at := now() + (offs[1] || ' days')::interval;
  end if;
  -- si se cierra (won/lost/perdido/cerrado) → no más follow-ups
  if new.status in ('won','cerrado','lost','perdido') then
    new.next_follow_up_at := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_lead_contacted on public.leads;
create trigger trg_lead_contacted before update on public.leads
  for each row execute function public.on_lead_contacted();

-- ---------------------------------------------------------------------------
-- 2) Analytics server-side (RPCs) — el dashboard deja de bajar 20k filas
--    SECURITY DEFINER + grant solo a authenticated (nunca anon).
-- ---------------------------------------------------------------------------

-- KPIs de un rango de días
create or replace function public.kpi_summary(days int default 30)
returns table(sessions bigint, pageviews bigint, avg_duration numeric, leads bigint, gclid_leads bigint)
language sql security definer set search_path = public as $$
  with pv as (select * from pageviews where created_at >= now() - (days||' days')::interval),
       ld as (select * from leads     where created_at >= now() - (days||' days')::interval)
  select
    (select count(distinct session_id) from pv),
    (select count(*) from pv),
    (select coalesce(round(avg(nullif(duration,0))::numeric,0),0) from pv),
    (select count(*) from ld),
    (select count(*) from ld where coalesce(gclid,'') <> '');
$$;

-- Tráfico + leads por día
create or replace function public.daily_stats(days int default 30)
returns table(day date, sessions bigint, pageviews bigint, leads bigint)
language sql security definer set search_path = public as $$
  with d as (select generate_series((now()::date - (days-1)), now()::date, '1 day')::date as day),
       pv as (select date_trunc('day', created_at)::date as day, session_id from pageviews
              where created_at >= now()::date - (days-1)),
       ld as (select date_trunc('day', created_at)::date as day from leads
              where created_at >= now()::date - (days-1))
  select d.day,
    (select count(distinct session_id) from pv where pv.day = d.day),
    (select count(*) from pv where pv.day = d.day),
    (select count(*) from ld where ld.day = d.day)
  from d order by d.day;
$$;

-- Canales que traen leads (sesiones → leads → tasa)
create or replace function public.channel_stats(days int default 30)
returns table(channel text, sessions bigint, leads bigint)
language sql security definer set search_path = public as $$
  with pv as (select distinct coalesce(channel,'direct') as channel, session_id from pageviews
              where created_at >= now() - (days||' days')::interval),
       s as (select channel, count(*) as sessions from pv group by 1),
       l as (select coalesce(channel,'direct') as channel, count(*) as leads from leads
             where created_at >= now() - (days||' days')::interval group by 1)
  select coalesce(s.channel,l.channel), coalesce(s.sessions,0), coalesce(l.leads,0)
  from s full outer join l using (channel) order by leads desc, sessions desc;
$$;

-- Páginas de entrada que convierten
create or replace function public.page_stats(days int default 30)
returns table(path text, sessions bigint, leads bigint)
language sql security definer set search_path = public as $$
  with pv as (select distinct path, session_id from pageviews
              where created_at >= now() - (days||' days')::interval and is_entry = true),
       s as (select path, count(*) as sessions from pv group by 1),
       l as (select coalesce(landing_path,'/') as path, count(*) as leads from leads
             where created_at >= now() - (days||' days')::interval group by 1)
  select coalesce(s.path,l.path), coalesce(s.sessions,0), coalesce(l.leads,0)
  from s full outer join l using (path) order by leads desc, sessions desc limit 30;
$$;

grant execute on function public.kpi_summary(int), public.daily_stats(int),
  public.channel_stats(int), public.page_stats(int) to authenticated;
revoke execute on function public.kpi_summary(int), public.daily_stats(int),
  public.channel_stats(int), public.page_stats(int) from anon;

-- ---------------------------------------------------------------------------
-- 3) Cron diario para follow-ups (10:00 UTC ≈ 12:00 CH)
--    Invoca la Edge Function lead-followup. Reemplazá <PROJECT_REF> y el token.
--    Requiere: extensiones pg_cron + pg_net (Database → Extensions).
-- ---------------------------------------------------------------------------
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.schedule('viven-followups','0 10 * * *', $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.functions.supabase.co/lead-followup',
--     headers := jsonb_build_object('Authorization','Bearer <CRON_SECRET>','Content-Type','application/json'),
--     body := '{}'::jsonb
--   );
-- $$);

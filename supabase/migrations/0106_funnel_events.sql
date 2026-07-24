-- ============================================================================
--  Viven — funnels/drop-offs first-party + señales UX (rage/dead/jserror)
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
--
--  · funnel_events: 1 fila por sesión+funnel+step (site.js dedupea client-side)
--    → el dashboard arma el embudo con % de abandono por paso (panel 🧭 Recorridos).
--  · ux_signals: rage clicks / dead clicks / errores JS como datos estructurados.
--  · RPCs security definer (solo authenticated) — el dashboard nunca baja filas crudas.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabla funnel_events
-- ---------------------------------------------------------------------------
create table if not exists public.funnel_events (
  id         bigint generated always as identity primary key,
  session_id text,
  funnel     text not null,          -- 'calc' | 'brief' | 'magnet'
  step       int  not null,          -- 0 = vio la página / el gate
  label      text,                   -- data-group del paso, 'view', 'email_submitted'…
  path       text,
  created_at timestamptz not null default now()
);
alter table public.funnel_events enable row level security;

-- mismo patrón que pageviews/video_plays/ab_hits: el sitio (publishable key)
-- inserta, solo usuarios logueados leen
drop policy if exists funnel_events_insert_anon on public.funnel_events;
create policy funnel_events_insert_anon on public.funnel_events
  for insert to anon, authenticated with check (true);
drop policy if exists funnel_events_select_auth on public.funnel_events;
create policy funnel_events_select_auth on public.funnel_events
  for select to authenticated using (true);

create index if not exists funnel_events_funnel_idx  on public.funnel_events (funnel, created_at);
create index if not exists funnel_events_session_idx on public.funnel_events (session_id);

-- ---------------------------------------------------------------------------
-- 2) Tabla ux_signals (señales de fricción)
-- ---------------------------------------------------------------------------
create table if not exists public.ux_signals (
  id         bigint generated always as identity primary key,
  session_id text,
  kind       text not null,          -- 'rage' | 'dead' | 'jserror'
  selector   text,                   -- tag#id / tag.clase del elemento (null en jserror)
  detail     text,                   -- texto del elemento o mensaje de error
  path       text not null,
  device     text,
  created_at timestamptz not null default now()
);
alter table public.ux_signals enable row level security;

drop policy if exists ux_signals_insert_anon on public.ux_signals;
create policy ux_signals_insert_anon on public.ux_signals
  for insert to anon, authenticated with check (true);
drop policy if exists ux_signals_select_auth on public.ux_signals;
create policy ux_signals_select_auth on public.ux_signals
  for select to authenticated using (true);

create index if not exists ux_signals_kind_idx on public.ux_signals (kind, created_at);

-- ---------------------------------------------------------------------------
-- 3) RPC: pasos de un funnel (sesiones únicas por step, últimos p_days)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_funnel_steps(p_funnel text, p_days int default 28)
returns table(step int, label text, sessions bigint)
language sql security definer set search_path = public as $$
  with fe as (
    select step, label, session_id
    from funnel_events
    where funnel = p_funnel
      and created_at >= now() - (p_days || ' days')::interval
  )
  select fe.step,
         min(fe.label)                       as label,
         count(distinct fe.session_id)::bigint as sessions
  from fe
  group by fe.step
  order by fe.step;
$$;

-- ---------------------------------------------------------------------------
-- 4) RPC: páginas de entrada (landing → rebote → profundidad), últimos p_days
--    CTEs sobre el rango de fechas (usa el índice por created_at), nunca full scan.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_entry_pages(p_days int default 28)
returns table(landing text, sessions bigint, bounces bigint, avg_pages numeric)
language sql security definer set search_path = public as $$
  with pv as (
    select session_id, path, created_at
    from pageviews
    where created_at >= now() - (p_days || ' days')::interval
      and session_id is not null
  ),
  sess as (
    select session_id,
           (array_agg(path order by created_at))[1] as landing,  -- primera path de la sesión
           count(*) as pages
    from pv
    group by session_id
  )
  select sess.landing,
         count(*)::bigint                              as sessions,
         count(*) filter (where sess.pages = 1)::bigint as bounces,
         round(avg(sess.pages)::numeric, 2)             as avg_pages
  from sess
  group by sess.landing
  order by sessions desc
  limit 30;
$$;

-- ---------------------------------------------------------------------------
-- 5) RPC: señales UX agrupadas (top 50 por hits, últimos p_days)
--    Para 'jserror' (selector null) agrupa por el mensaje (detail recortado),
--    así el mismo error en la misma página se acumula en una fila.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_ux_signals(p_days int default 28)
returns table(kind text, path text, selector text, hits bigint, sessions bigint)
language sql security definer set search_path = public as $$
  with ux as (
    select kind, path,
           coalesce(selector, left(coalesce(detail, ''), 120)) as sel,
           session_id
    from ux_signals
    where created_at >= now() - (p_days || ' days')::interval
  )
  select ux.kind, ux.path, ux.sel as selector,
         count(*)::bigint                       as hits,
         count(distinct ux.session_id)::bigint  as sessions
  from ux
  group by ux.kind, ux.path, ux.sel
  order by hits desc
  limit 50;
$$;

-- ---------------------------------------------------------------------------
-- 6) Permisos: los RPCs son SOLO para el dashboard (authenticated)
-- ---------------------------------------------------------------------------
revoke execute on function public.rpc_funnel_steps(text, int),
                           public.rpc_entry_pages(int),
                           public.rpc_ux_signals(int) from public, anon;
grant execute on function public.rpc_funnel_steps(text, int),
                          public.rpc_entry_pages(int),
                          public.rpc_ux_signals(int) to authenticated;

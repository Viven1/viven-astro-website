-- 0115: ✓ Corregir señales de fricción desde el dashboard (pedido 2026-07-26,
-- "hace q ahi se puedan corregir").
--
-- ux_resolutions: una fila por señal (kind+path+selector) marcada desde el
-- panel. status: 'fixed' (✓ Corregido — se oculta de la tabla mientras no
-- REAPAREZCA después de la fecha de resolución) o 'requested' (🤖 Que Claude
-- lo corrija — queda en cola; Claude las revisa cada sesión, las arregla y
-- las pasa a 'fixed').
--
-- rpc_ux_signals ahora devuelve last_at (última ocurrencia): si una señal
-- corregida vuelve a ocurrir DESPUÉS del fix, reaparece sola en el panel.
--
-- Correr una vez en el SQL Editor de Supabase. Idempotente.

create table if not exists public.ux_resolutions (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  path text not null default '',
  selector text not null default '',
  status text not null default 'fixed',      -- 'fixed' | 'requested'
  note text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists ux_resolutions_key_idx on public.ux_resolutions (kind, path, selector);
alter table public.ux_resolutions enable row level security;
do $$ begin
  create policy ux_resolutions_auth on public.ux_resolutions
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
grant select, insert, update, delete on public.ux_resolutions to authenticated;

-- last_at nuevo → hay que dropear la función (cambia el shape del retorno)
drop function if exists public.rpc_ux_signals(int);
create or replace function public.rpc_ux_signals(p_days int default 28)
returns table(kind text, path text, selector text, hits bigint, sessions bigint, last_at timestamptz)
language sql security definer set search_path = public as $$
  with ux as (
    select kind, path,
           coalesce(selector, left(coalesce(detail, ''), 120)) as sel,
           session_id, created_at
    from ux_signals
    where created_at >= now() - (p_days || ' days')::interval
  )
  select ux.kind, ux.path, ux.sel as selector,
         count(*)::bigint                       as hits,
         count(distinct ux.session_id)::bigint  as sessions,
         max(ux.created_at)                     as last_at
  from ux
  group by ux.kind, ux.path, ux.sel
  order by hits desc
  limit 50;
$$;
revoke execute on function public.rpc_ux_signals(int) from public, anon;
grant execute on function public.rpc_ux_signals(int) to authenticated;

-- ============================================================
-- TIEMPO EN PÁGINA — pegar en Supabase → SQL Editor → Run
-- El navegador genera un UUID por pageview (pv_id) y, al salir
-- de la página, reporta los segundos vía una función segura:
-- solo puede actualizar la columna duration de ESA pageview.
-- ⚠️ Correr ANTES de pushear el site.js nuevo.
-- ============================================================

alter table public.pageviews
  add column if not exists pv_id uuid;

create unique index if not exists pageviews_pv_id_key
  on public.pageviews (pv_id) where pv_id is not null;

create or replace function public.update_duration(pv uuid, secs integer)
returns void
language sql
security definer
set search_path = public
as $$
  update public.pageviews
     set duration = greatest(coalesce(duration, 0), least(secs, 7200))  -- tope 2h
   where pv_id = pv;
$$;

revoke all on function public.update_duration(uuid, integer) from public;
grant execute on function public.update_duration(uuid, integer) to anon, authenticated;

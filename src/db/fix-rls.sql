-- ============================================================
-- FIX DE SEGURIDAD — pegar completo en Supabase → SQL Editor → Run
-- Problema detectado: las tablas quedaron legibles y borrables
-- con la key pública. Esto lo corrige:
--   1) elimina TODAS las policies existentes de las 3 tablas
--   2) activa RLS
--   3) crea policies de INSERT-only para visitantes (anon)
-- Resultado: los visitantes solo pueden insertar; leer/borrar
-- solo se puede desde el panel de Supabase.
-- ============================================================

-- 1) borrar todas las policies actuales (sean cuales sean sus nombres)
do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('leads', 'pageviews', 'video_stats')
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- 2) activar Row Level Security
alter table public.leads       enable row level security;
alter table public.pageviews   enable row level security;
alter table public.video_stats enable row level security;

-- 3) visitantes: SOLO insertar
create policy "anon insert only" on public.leads
  for insert to anon with check (true);

create policy "anon insert only" on public.pageviews
  for insert to anon with check (true);

create policy "anon insert only" on public.video_stats
  for insert to anon with check (true);

-- (sin policies de SELECT/UPDATE/DELETE = prohibido por defecto)

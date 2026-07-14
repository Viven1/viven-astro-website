-- 0070: SEO KEYWORD MANAGER — cartera acumulativa de oportunidades de keywords.
-- Hasta ahora "✨ Buscar oportunidades" (ai-keywords) recalculaba todo de cero
-- en cada click y se perdía al cerrar la tab (6 búsquedas web + Claude, cada
-- vez). Esta tabla acumula lo que la función va encontrando (corrida manual
-- o el nuevo cron semanal, SQL 0071) para que sea una cartera que crece sola
-- en vez de reiniciarse — nunca chocó con gsc_daily/gsc_status (SQL 0069),
-- que son el snapshot diario de métricas, no research de oportunidades.
--
-- Escritura: el edge function ai-keywords usa el SERVICE ROLE para el upsert
-- (RLS no le aplica). El dashboard (usuario autenticado) solo lee y actualiza
-- el campo status (marcar accionada / descartar) — nunca inserta directo.
create table if not exists public.keyword_opportunities (
  id         bigint generated always as identity primary key,
  keyword    text not null,
  lang       text not null default 'en',
  type       text not null default 'new_content',   -- quick_win | new_content | page_fix
  priority   int not null default 5,                 -- 1-10
  why        text,
  action     text,
  source     text default 'gsc',                     -- 'gsc' | 'gsc+ads'
  status     text not null default 'new',             -- new | actioned | dismissed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (keyword, lang)
);
create index if not exists keyword_opportunities_status_idx on public.keyword_opportunities (status);
create index if not exists keyword_opportunities_priority_idx on public.keyword_opportunities (priority desc);

alter table public.keyword_opportunities enable row level security;
do $$ begin
  create policy "kwopp_select" on public.keyword_opportunities for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "kwopp_update" on public.keyword_opportunities for update to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
-- sin policy de insert/delete para 'authenticated': solo el service role (usado
-- por el edge function ai-keywords) puede insertar — así el dashboard nunca
-- puede escribir oportunidades "truchas", solo actuar sobre las que ya existen.

-- 0083: tabla mínima para capturar timing real de carga del dashboard en el
-- navegador de cada uno (Sebastián reportó 2026-07-14 que tarda ~30s en
-- entrar y después queda lenta). Server-side todo midió rápido (TTFB, RLS,
-- tamaño de tablas) — falta el dato del lado del cliente: sesión/rol/queries
-- reales en SU red/dispositivo. Best-effort, nunca bloquea la UI.

create table if not exists public.dash_perf_log (
  id bigserial primary key,
  email text,
  at timestamptz not null default now(),
  phases jsonb not null,
  ua text
);

alter table public.dash_perf_log enable row level security;
create policy "dash_perf_log_insert_auth" on public.dash_perf_log for insert to authenticated with check (true);
create policy "dash_perf_log_select_auth" on public.dash_perf_log for select to authenticated using (true);

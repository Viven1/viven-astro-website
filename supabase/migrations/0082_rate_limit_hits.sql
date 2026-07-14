-- 0082: tabla mínima de rate-limit para los 3 endpoints públicos que mandan
-- email a un `to` arbitrario sin login (calc-email, brief-email,
-- booking-create) — hoy sin límite, riesgo de open-relay/spam (auditoría de
-- seguridad 2026-07-14). Cada función cuenta hits por IP en una ventana
-- corta antes de mandar; sin índice compuesto esto sería lento en poco
-- tiempo, así que va desde el día uno.

create table if not exists public.rl_hits (
  id bigserial primary key,
  fn text not null,
  key text not null,
  at timestamptz not null default now()
);

create index if not exists rl_hits_fn_key_at_idx on public.rl_hits (fn, key, at desc);

alter table public.rl_hits enable row level security;
-- solo la accede el service role desde las Edge Functions — nada de policies públicas.

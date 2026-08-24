-- 0053: nurture visible y controlable — a pedido de Sebastián:
-- (1) lista de quién está adentro y qué se le va a mandar,
-- (2) pausar/activar por persona + agregar gente a mano,
-- (3) TODOS los pasos (incluido el ①, antes automático) pasan por la Bandeja
--     de salida — nada sale sin aprobación, mismo mecanismo que los workflows.

create table if not exists public.nurture_state (
  id bigint generated always as identity primary key,
  lead_id bigint not null unique,
  status text not null default 'active',       -- active | paused
  source text not null default 'auto',         -- auto (lead nuevo) | manual (agregado a mano)
  enrolled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.nurture_state enable row level security;
do $$ begin
  create policy "nurture_state_rw" on public.nurture_state for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- la bandeja ahora recibe borradores de dos motores distintos (workflows y
-- nurture) — kind los distingue, step solo lo usa nurture para marcar
-- nurture_log al enviar
alter table public.outbox add column if not exists kind text not null default 'workflow';
alter table public.outbox add column if not exists step int;

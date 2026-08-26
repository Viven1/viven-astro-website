-- ============================================================================
--  Avisos: todo lo que pasa, en la campana.
--
--  Sebastián, 26 ago 2026: "tienen que aparecer como notificación en la campana
--  también. Todas las notificaciones siempre ahí."
--
--  Hasta hoy la campana se armaba mirando tres fuentes concretas (tasks, notas con
--  mención, briefs). Todo lo demás —que el cliente aprobó un corte, que terminó el
--  brief, que entró un lead, que falló un cron— salía por push y por email y nunca
--  quedaba en la campana. Si el teléfono estaba en silencio, no pasó.
--
--  Esta tabla es el buzón único. Y no hay que acordarse de escribir en ella: push-send
--  —por donde YA pasan las 25 funciones que avisan algo— deja el aviso solo. Un aviso
--  nuevo aparece en la campana sin tocar nada.
--
--  Idempotente.
-- ============================================================================

create table if not exists public.avisos (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  kind         text,                    -- 'portal' | 'lead' | 'cron' | 'workflow'…
  title        text not null,
  body         text,
  url          text,                    -- adónde lleva al tocarlo
  para         text,                    -- email de a quién; null = a todo el equipo
  leido_at     timestamptz,
  archivado_at timestamptz
);

create index if not exists avisos_recientes_idx
  on public.avisos (created_at desc) where archivado_at is null;

alter table public.avisos enable row level security;
do $$ begin
  create policy avisos_auth_all on public.avisos
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

/* La campana muestra lo de los últimos 30 días: un aviso de hace dos meses no es un
   aviso, es historia. Se limpian solos para que la tabla no crezca para siempre. */
create or replace function public.avisos_limpiar()
returns void language sql security definer set search_path = public as $$
  delete from public.avisos where created_at < now() - interval '90 days';
$$;

comment on table public.avisos is
  'Buzón único de la campana. Lo escribe push-send: cualquier cosa que mande una push queda acá.';

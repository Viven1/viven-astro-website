-- ============================================================================
--  Guiones y plan de rodaje.
--
--  Sebastián, 26 ago 2026: "¿cómo hago para generar guiones? ¿plan de rodaje
--  completo?" — y después, sobre las tres versiones: "solo yo, y puedo decidir
--  cuál mandar, o mandar los tres si quiero".
--
--  Tres decisiones que se ven en la forma de la tabla:
--
--  · Se generan de a TRES, y las tres se guardan. Un guión solo no se puede
--    comparar; tres ángulos distintos del mismo brief sí. `tanda` es lo que las
--    mantiene juntas: una generación, tres filas.
--
--  · El cuerpo es jsonb y no texto. Un A/V script es una tabla de dos columnas
--    —lo que se ve y lo que se escucha— y guardarlo como párrafo obliga a
--    re-parsearlo cada vez que se muestra, se exporta o se manda. El formato
--    cinematográfico usa las mismas filas con otras claves.
--
--  · `elegido` y `sent_at` son distintos a propósito. Elegir es una decisión
--    interna (con cuál seguimos); mandar es un hecho hacia afuera. Confundirlos
--    haría que marcar un favorito parezca que ya salió.
--
--  El plan de rodaje vive en la misma tabla con tipo='plan': cuelga del guión
--  elegido y no tiene sentido sin él.
--
--  Idempotente.
-- ============================================================================

create table if not exists public.project_scripts (
  id           bigint generated always as identity primary key,
  project_id   bigint not null,
  tanda        uuid   not null default gen_random_uuid(),
  tipo         text   not null default 'guion',   -- 'guion' | 'plan'
  formato      text   not null default 'av',      -- 'av' (video|audio) | 'cine'
  angulo       text,                              -- "El testimonio del técnico"
  premisa      text,                              -- una línea: por qué este ángulo
  titulo       text,
  duracion_seg int,
  cuerpo       jsonb  not null default '[]'::jsonb,
  elegido      boolean not null default false,
  sent_at      timestamptz,
  sent_to      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists project_scripts_proj_idx
  on public.project_scripts (project_id, created_at desc);
create index if not exists project_scripts_tanda_idx
  on public.project_scripts (tanda);

-- Un solo guión elegido por proyecto. El plan de rodaje cuelga del elegido, y con dos
-- elegidos el plan no sabría de cuál sale.
create unique index if not exists project_scripts_un_elegido
  on public.project_scripts (project_id) where (elegido and tipo = 'guion');

alter table public.project_scripts enable row level security;
do $$ begin
  create policy project_scripts_auth_all on public.project_scripts
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create or replace function public.touch_project_scripts()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_project_scripts_touch on public.project_scripts;
create trigger trg_project_scripts_touch before update on public.project_scripts
  for each row execute function public.touch_project_scripts();

comment on table public.project_scripts is
  'Guiones (de a tres por tanda) y el plan de rodaje que sale del elegido. cuerpo: [{n, tc, video, audio}] en A/V; [{n, encabezado, accion, dialogo}] en cine; [{bloque, hora, que, quien, donde, notas}] en plan.';

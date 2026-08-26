-- ============================================================================
--  Project Brief: las 12 preguntas que definen de qué se trata el video.
--
--  Decisiones de Sebastián (26 ago 2026), y en qué se diferencian de lo que propuse:
--
--  · Presentación: NO se decide de antemano. "Toca testear qué es mejor para que no sea
--    overwhelming." Cada brief sale con una de dos presentaciones (todo en una página, o
--    por secciones) y se mide cuál se termina más. De ahí `variante`.
--
--  · El colega invitado ve TODO el portal, no solo el brief: "si da info también va a
--    querer dar feedback". Así que la invitación crea un acceso normal — no hace falta
--    tabla nueva, `portal_access` ya es por proyecto + email.
--
--  · Las respuestas NO se reparten por alcance. Yo proponía mandar unas a la empresa y
--    otras al proyecto; él corrigió: "no sí o sí, ya que en la empresa hay varias
--    secciones y unos hacen algo y otros otra cosa, pero lo dejamos en todos lados como
--    base de lo que ya hicimos". O sea: viven en el PROYECTO, y cuando se abre un brief
--    nuevo de la misma empresa o persona, lo anterior se ofrece como sugerencia — que se
--    acepta o se pisa. Una respuesta heredada a ciegas sería peor que una vacía.
--
--  Idempotente.
-- ============================================================================

create table if not exists public.project_briefs (
  id          bigint generated always as identity primary key,
  project_id  bigint not null,
  key         text   not null,          -- clave de la pregunta (BRIEF en el código)
  value       text,
  answered_by text,                     -- el email de quien la contestó
  updated_at  timestamptz not null default now()
);

-- Una respuesta por pregunta y por proyecto: contestar de nuevo PISA. Sin esto, dos
-- personas del mismo cliente contestando a la vez dejan dos respuestas y ninguna es LA
-- respuesta.
create unique index if not exists project_briefs_uniq
  on public.project_briefs (project_id, key);
create index if not exists project_briefs_proj_idx
  on public.project_briefs (project_id);

alter table public.projects
  add column if not exists brief_variante text,        -- 'largo' | 'pasos' — para el test
  add column if not exists brief_sent_at  timestamptz,
  add column if not exists brief_done_at  timestamptz;

alter table public.project_briefs enable row level security;
do $$ begin
  create policy project_briefs_auth_all on public.project_briefs
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
-- El cliente NUNCA toca esta tabla directo: escribe por la Edge Function (service role),
-- que es la que comprueba su código. Por eso no hay policy para anon.

create or replace function public.touch_project_briefs()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_project_briefs_touch on public.project_briefs;
create trigger trg_project_briefs_touch before update on public.project_briefs
  for each row execute function public.touch_project_briefs();

comment on column public.projects.brief_variante is
  'Cómo se le mostró el brief a ESTE cliente: largo | pasos. Se sortea al enviarlo y sirve para medir cuál se termina más.';

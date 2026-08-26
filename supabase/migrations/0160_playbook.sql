-- ============================================================================
--  Playbook — las preguntas que hacemos en la llamada, y sus respuestas.
--
--  Sebastián, 26 ago 2026: "necesitamos nuestro propio playbook como el de HubSpot
--  en el dashboard, con preguntas a hacer y que las respuestas se queden grabadas en
--  la persona y empresa. así la tenemos a largo plazo. y con eso podemos hacer la
--  oferta también."
--
--  Dos alcances, y la diferencia importa:
--    scope='company' → la respuesta vale para TODA la empresa (a qué se dedican, quién
--                      firma, cómo compran). Se contesta una vez y la ve el que hable
--                      con cualquiera de sus contactos, incluso dentro de dos años.
--    scope='lead'    → la respuesta es de ESTE proyecto/persona (qué necesitan ahora,
--                      para cuándo, con qué presupuesto).
--  Guardar las de empresa en la persona sería tirar el trabajo cada vez que cambia el
--  interlocutor, que es justo lo que pasa en las cuentas grandes.
--
--  Idempotente.
-- ============================================================================

create table if not exists public.playbook_answers (
  id          bigint generated always as identity primary key,
  scope       text not null check (scope in ('lead', 'company')),
  ref         text not null,              -- id del lead, o dominio de la empresa
  key         text not null,              -- clave de la pregunta (PLAYBOOK en el dashboard)
  value       text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- una sola respuesta por pregunta y por sujeto: contestar de nuevo PISA, no acumula.
-- Sin esto, dos ventanas abiertas dejan dos respuestas distintas a la misma pregunta y
-- ninguna de las dos es "la" respuesta.
create unique index if not exists playbook_answers_uniq
  on public.playbook_answers (scope, ref, key);

create index if not exists playbook_answers_ref_idx
  on public.playbook_answers (scope, ref);

alter table public.playbook_answers enable row level security;
do $$ begin
  create policy playbook_answers_auth_all on public.playbook_answers
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

create or replace function public.touch_playbook_answers()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_playbook_touch on public.playbook_answers;
create trigger trg_playbook_touch before update on public.playbook_answers
  for each row execute function public.touch_playbook_answers();

-- ============================================================================
--  0130: 👋 el email de bienvenida del newsletter (EN/DE/ES)
--
--  QUÉ PASABA: alguien dejaba su email en el formulario del footer, veía
--  "✓ Listo — estás en la lista"… y no recibía absolutamente nada hasta la
--  edición mensual siguiente — que puede caer hasta 30 días después. Para esa
--  persona el newsletter era una promesa sin acuse de recibo: ni sabe que la
--  suscripción funcionó, ni con qué frecuencia le vamos a escribir, ni de qué
--  dominio le va a llegar (lo primero que decide si el mes que viene el email
--  cae en Promociones o en Inbox).
--
--  AHORA: la function newsletter-welcome manda un email inmediato EN SU IDIOMA
--  (EN/DE/ES, fallback EN) con el mismo wrapper, el mismo remitente y el mismo
--  link de baja de un click que el resto del newsletter.
--
--  Esta tabla es el LOG y, sobre todo, el CANDADO: índice único por email, así
--  que la bienvenida sale UNA sola vez por dirección, para siempre. El form del
--  footer es público y no tiene captcha — sin este candado, repetir el submit
--  (o un script) sería una forma barata de mandarle N emails a un tercero.
--
--  Correr una vez en el SQL Editor de Supabase. Idempotente.
--  (Mientras no esté corrida, la function manda igual y deja
--   "FALTA_CORRER_0130" en los logs — la suscripción nunca se rompe por esto.)
-- ============================================================================

create table if not exists public.newsletter_welcomes (
  id         bigint generated always as identity primary key,
  email      text not null,
  lead_id    bigint,                       -- leads.id (sin FK: el lead puede borrarse y el log queda)
  lang       text not null default 'en',   -- en | de | es
  resend_id  text,                         -- id del envío en Resend (para rastrearlo ahí)
  sent_at    timestamptz,
  opened_at  timestamptz,                  -- lo estampa resend-events (tag welcome_id)
  clicked_at timestamptz,
  created_at timestamptz not null default now()
);

-- EL CANDADO: una bienvenida por dirección, para siempre. Case-insensitive
-- porque el form guarda el email tal como lo tipearon (Juan@X.ch y juan@x.ch
-- son la misma persona).
create unique index if not exists newsletter_welcomes_email_uq
  on public.newsletter_welcomes (lower(email));
create index if not exists newsletter_welcomes_sent_idx
  on public.newsletter_welcomes (sent_at desc);

alter table public.newsletter_welcomes enable row level security;
-- Solo lectura, y solo para los de la casa (misma regla que 0127: estar
-- logueado no alcanza). Quien escribe es la function con service role, que
-- saltea RLS: el sitio público nunca toca esta tabla directo.
drop policy if exists newsletter_welcomes_select_member on public.newsletter_welcomes;
create policy newsletter_welcomes_select_member on public.newsletter_welcomes
  for select to authenticated using (public.is_member());

-- Verificación (no cambia nada):
--   select lang, count(*), max(sent_at) from public.newsletter_welcomes group by 1;
--   select email, lang, sent_at, opened_at from public.newsletter_welcomes
--     order by sent_at desc nulls last limit 20;

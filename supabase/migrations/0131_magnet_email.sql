-- 0131 — El lead magnet pasa a llegar TAMBIÉN por email, y la casilla del
-- newsletter deja rastro.
--
-- POR QUÉ: hasta hoy el magnet devolvía un link firmado de 5 minutos y el PDF
-- bajaba en el momento. Funciona, pero no deja ningún email en la casilla de
-- esa persona — y ese primer email es el que hace que los siguientes se abran
-- (misma lógica que la bienvenida del newsletter, SQL 0130). Ahora se hacen las
-- dos cosas: descarga inmediata Y mail con un link de 7 días.
--
-- LO SEGUNDO, MÁS IMPORTANTE DE LO QUE PARECE: `leads.newsletter_opt_in`.
-- Hoy la edición mensual se manda a TODOS los leads que no estén dados de baja
-- (ver elegirDestinatarios en newsletter-send): de los 198 destinatarios de
-- hoy, exactamente 2 se suscribieron por el formulario. Los demás escribieron
-- por contacto, usaron la calculadora o entraron importados. Esta columna no
-- cambia a quién se le manda — cambia que a partir de ahora SEPAMOS quién lo
-- pidió de verdad. El día que se quiera separar "los que pidieron" de "los que
-- están", el dato va a existir; sin esta columna, esa decisión no se puede ni
-- tomar.
--
-- Idempotente: se puede correr dos veces.

alter table public.leads
  add column if not exists newsletter_opt_in     timestamptz,
  add column if not exists newsletter_opt_in_src text;

comment on column public.leads.newsletter_opt_in is
  'Cuándo la persona pidió EXPLÍCITAMENTE el newsletter (casilla del lead magnet o formulario del footer). NULL = nunca lo pidió explícitamente, aunque hoy igual reciba la edición mensual.';

-- Una fecha sola no es una prueba de consentimiento: si algún día alguien
-- pregunta "¿dónde dije que sí?", hay que poder contestar CON QUÉ TEXTO y EN
-- QUÉ PÁGINA. Acá se guarda la frase exacta que tenía la casilla al lado, la
-- página donde estaba y de qué formulario salió. Es una línea de texto, no un
-- sistema de gestión de consentimiento — pero es la diferencia entre "sí, lo
-- pidió" y "creemos que lo pidió".
comment on column public.leads.newsletter_opt_in_src is
  'Prueba del consentimiento: origen (magnet/footer), página donde estaba la casilla y el texto EXACTO que la persona aceptó.';

-- El log de los envíos del magnet. Mismo patrón que newsletter_welcomes: una
-- fila por envío, con el id de Resend, para poder estampar apertura y click
-- desde el webhook (resend-events, tag magnet_id) y saber si el mail sirve.
create table if not exists public.magnet_sends (
  id          bigserial primary key,
  email       text not null,
  magnet      text not null,
  lang        text,
  lead_id     bigint,
  resend_id   text,
  sent_at     timestamptz,
  opened_at   timestamptz,
  clicked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists magnet_sends_email_idx on public.magnet_sends (lower(email));
create index if not exists magnet_sends_sent_idx  on public.magnet_sends (sent_at desc);

-- A DIFERENCIA de newsletter_welcomes, acá NO hay índice único por dirección:
-- pedir el mismo PDF dos veces (o pedir el otro magnet) es legítimo y tiene que
-- volver a llegar. El candado de una-sola-vez es para la bienvenida, no para
-- un archivo que la persona está pidiendo.

alter table public.magnet_sends enable row level security;

-- Solo el service role escribe (la function). Lectura para los miembros, igual
-- que el resto del panel (SQL 0127).
drop policy if exists magnet_sends_select_member on public.magnet_sends;
create policy magnet_sends_select_member on public.magnet_sends
  for select to authenticated using (public.is_member());

-- El respaldo diario dumpea con RLS puesta: sin esta política la tabla saldría
-- con CERO filas en el backup y nadie se enteraría (ver viven-respaldo).
drop policy if exists backup_ro_read on public.magnet_sends;
create policy backup_ro_read on public.magnet_sends
  for select to viven_backup_ro
  using (true);

-- Y de paso: newsletter_welcomes (0130) se creó DESPUÉS del respaldo diario y
-- quedó sin la política de backup. pg_dump corre con --enable-row-security y
-- sin esto la tabla se dumpea con CERO filas, en silencio. Medido hoy: era la
-- única de las nuevas que faltaba.
drop policy if exists backup_ro_read on public.newsletter_welcomes;
create policy backup_ro_read on public.newsletter_welcomes
  for select to viven_backup_ro
  using (true);

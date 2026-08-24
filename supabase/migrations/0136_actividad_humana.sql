-- 0136: separar "visitas" de "personas", sin romper el Datenschutz.
--
-- QUÉ PASABA (medido el 2026-08-24, últimos 30 días):
--   7.908 páginas vistas · 6.943 "sesiones" · 1,14 páginas por sesión
--   95,6% de las sesiones tienen UNA sola página
--   5.725 de esas sesiones son channel='direct', con 78,5% de visitas de CERO
--   segundos y 80s de permanencia promedio, contra 249s del resto.
-- Ese bloque es tráfico automático. Es un piso de ~190 por día que no varía, y
-- por eso los números del dashboard se movían tan poco al cambiar el período:
-- la señal real (~1.200 sesiones) estaba tapada por ruido que la cuadruplicaba.
--
-- Y la tarjeta decía "Sesiones (visitantes)" como si fueran lo mismo. No lo son:
-- una persona puede generar varias sesiones. Peor todavía, el session_id vive en
-- sessionStorage y es ÚNICO POR PESTAÑA — tres pestañas contaban como tres.
--
-- LA DECISIÓN: no se agrega un identificador persistente. Contar usuarios únicos
-- con una cookie/localStorage convierte el dato en personal, obliga a pedir
-- consentimiento, y como mucha gente lo rechaza el número pasaría a medir a los
-- que aceptan cookies en vez de a los visitantes. Se cambiaría un número inflado
-- por uno mutilado.
--
-- LO QUE SÍ: registrar que hubo ALGUIEN ahí. Un scroll, un movimiento de mouse,
-- un toque en la pantalla. Un bot que renderiza la página y se va no genera
-- ninguna de esas señales. Es un hecho por sesión, muere con la pestaña, y no
-- identifica a nadie — el tipo de medición que la ley considera anónima y que no
-- necesita consentimiento.

create table if not exists public.session_activity (
  session_id  text primary key,          -- una fila por sesión y basta: el PK lo garantiza
  kind        text,                      -- 'scroll' | 'pointer' | 'touch' | 'key'
  created_at  timestamptz not null default now()
);

create index if not exists session_activity_fecha_idx on public.session_activity (created_at);

alter table public.session_activity enable row level security;

-- El sitio público escribe (mismo patrón que pageviews y ux_signals). Solo
-- INSERT: nadie puede leer ni modificar lo que ya está. Si la misma sesión
-- manda dos veces, el primary key la rebota y el navegador lo ignora.
drop policy if exists session_activity_insert_anon on public.session_activity;
create policy session_activity_insert_anon on public.session_activity
  for insert to anon with check (true);

-- Y el dashboard lee, como todo el resto desde la 0127.
drop policy if exists session_activity_select_auth on public.session_activity;
create policy session_activity_select_auth on public.session_activity
  for select to authenticated using (public.is_member());

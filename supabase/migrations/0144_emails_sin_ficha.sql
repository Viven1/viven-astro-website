-- ============================================================================
--  Viven — emails de gente que no está en el CRM (0144)
--
--  El sync de Gmail lee las casillas cada 5 minutos, pero tenía una línea que decía
--  literalmente "no es un lead conocido, lo ignoramos": si el que escribe no estaba
--  YA en el CRM, el email se descartaba y no quedaba registro en ningún lado. Como
--  info@viven.ch entrega en la casilla de Sebastián, eso significa que las consultas
--  que llegan por la dirección pública —que son las más importantes— eran justo las
--  que se perdían.
--
--  Medido el 25 ago 2026 sobre 60 días: 201 hilos dirigidos a info@. Entre ellos hay
--  prospectos reales y también facturas de proveedores, outreach frío y avisos
--  internos. Por eso NO se crea el contacto solo: se encola acá y Sebastián decide.
--  Es el mismo criterio que rige los emails salientes — nada pasa sin su ✓.
--
--  El cuerpo se guarda para que la decisión se pueda tomar leyendo, sin ir a Gmail.
-- ============================================================================

create table if not exists public.email_pendientes (
  id           bigserial primary key,
  gmail_id     text not null unique,          -- el mismo mensaje nunca se encola dos veces
  mailbox      text not null,                 -- de qué casilla salió (sebastian / sofia)
  from_email   text not null,
  from_name    text,
  subject      text,
  body         text,
  received_at  timestamptz,
  -- pendiente: esperando decisión · creado: ya es una persona · ignorado: no es cliente
  status       text not null default 'pendiente',
  lead_id      bigint,                        -- si se creó, a quién
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists email_pend_status_idx on public.email_pendientes (status, received_at desc);
create index if not exists email_pend_from_idx   on public.email_pendientes (lower(from_email));

alter table public.email_pendientes enable row level security;

-- Solo el equipo, como todo el resto desde la 0127. La función escribe con service role.
drop policy if exists email_pend_todo_auth on public.email_pendientes;
create policy email_pend_todo_auth on public.email_pendientes
  for all to authenticated using (public.is_member()) with check (public.is_member());

-- ---------------------------------------------------------------------------
--  Aprobar: crear la persona y mudarle el email
--
--  Hace las tres cosas en una: crea el lead, pasa el email a su historial y marca
--  el pendiente. Si el email ya existe como contacto (porque entró por un formulario
--  mientras tanto), NO crea un duplicado: usa el que hay. La 0134 lo impediría igual,
--  pero mejor que la función haga lo correcto a que rebote contra una restricción.
-- ---------------------------------------------------------------------------
create or replace function public.aprobar_email_pendiente(p_id bigint, p_nombre text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.email_pendientes%rowtype; lid bigint; nuevo boolean := false;
begin
  if not public.is_member() then return jsonb_build_object('ok', false, 'error', 'sin permiso'); end if;
  select * into p from public.email_pendientes where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'no existe'); end if;
  if p.status <> 'pendiente' then return jsonb_build_object('ok', false, 'error', 'ya estaba decidido'); end if;

  select id into lid from public.leads where lower(btrim(email)) = lower(btrim(p.from_email)) limit 1;
  if lid is null then
    insert into public.leads (name, email, status, channel, message, created_at)
    values (coalesce(nullif(btrim(coalesce(p_nombre, p.from_name, '')), ''), p.from_email),
            lower(btrim(p.from_email)), 'nuevo', 'email',
            'Escribió a ' || p.mailbox || '@viven.ch: ' || coalesce(p.subject, '(sin asunto)'),
            coalesce(p.received_at, now()))
    returning id into lid;
    nuevo := true;
  end if;

  -- el email pasa al historial de la persona (si ya estaba, no se duplica)
  insert into public.email_log (lead_id, to_addr, subject, body, sender_label, source, direction, gmail_id, created_at)
  select lid, p.mailbox || '@viven.ch', p.subject, p.body,
         coalesce(p.from_name, p.from_email), 'gmail-' || p.mailbox, 'in', p.gmail_id, coalesce(p.received_at, now())
  where not exists (select 1 from public.email_log e where e.gmail_id = p.gmail_id);

  update public.leads set last_reply_at = greatest(coalesce(last_reply_at, 'epoch'::timestamptz), coalesce(p.received_at, now()))
   where id = lid;

  update public.email_pendientes
     set status = 'creado', lead_id = lid, decided_at = now()
   where id = p_id;

  return jsonb_build_object('ok', true, 'lead_id', lid, 'nuevo', nuevo);
end $$;

-- ---------------------------------------------------------------------------
--  Descartar: no es un cliente. Se recuerda el remitente para no volver a
--  preguntar por él — si no, la misma factura mensual del proveedor reaparece
--  todos los meses y la lista se vuelve ruido que se aprende a ignorar.
-- ---------------------------------------------------------------------------
create or replace function public.ignorar_email_pendiente(p_id bigint, p_todos_del_remitente boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.email_pendientes%rowtype; n int := 0;
begin
  if not public.is_member() then return jsonb_build_object('ok', false, 'error', 'sin permiso'); end if;
  select * into p from public.email_pendientes where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'no existe'); end if;

  if p_todos_del_remitente then
    update public.email_pendientes set status = 'ignorado', decided_at = now()
     where status = 'pendiente' and lower(from_email) = lower(p.from_email);
    get diagnostics n = row_count;
  else
    update public.email_pendientes set status = 'ignorado', decided_at = now() where id = p_id;
    n := 1;
  end if;
  return jsonb_build_object('ok', true, 'ignorados', n, 'remitente', p.from_email);
end $$;

revoke all on function public.aprobar_email_pendiente(bigint, text),
                      public.ignorar_email_pendiente(bigint, boolean) from public, anon;
grant execute on function public.aprobar_email_pendiente(bigint, text),
                         public.ignorar_email_pendiente(bigint, boolean) to authenticated;

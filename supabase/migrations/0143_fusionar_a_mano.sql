-- ============================================================================
--  Viven — fusionar dos contactos a mano (0143)
--
--  La 0134 impide que se creen duplicados por email y la 0135 unificó los que ya
--  estaban. Pero eso solo agarra a los que comparten el email. La misma persona
--  cargada dos veces con dos direcciones distintas —"MARTIN BABU" y "Martin Babu
--  DJ", vistos en Hoy el 25 ago 2026 como dos tareas idénticas— no la agarra nadie,
--  porque no hay forma automática de saber que son la misma sin equivocarse.
--
--  Esto es la misma mudanza de la 0135, pero disparada a mano desde el dashboard:
--  Sebastián elige cuál queda y cuál se absorbe, y esta función mueve TODO lo que
--  cuelga del absorbido —deals, ofertas, propuestas, notas, tareas, emails, eventos—
--  al que queda.
--
--  REGLA, la misma de siempre: no se borra contenido. Todo se muda primero; la fila
--  vacía se borra recién cuando ya no le cuelga nada. Los campos del que queda solo
--  se completan donde estaban vacíos: nunca se pisa un dato bueno con otro.
--
--  Las tablas hijas NO se listan a mano: salen de information_schema en el momento.
--  Escribir la lista a mano es garantizar que la próxima tabla que alguien agregue
--  deje contenido huérfano sin que nadie se entere.
-- ============================================================================

create or replace function public.fusionar_contactos(p_queda bigint, p_absorbido bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  dup    public.leads%rowtype;
  vive   public.leads%rowtype;
  col    record;
  movidas int;
  total  int := 0;
  detalle jsonb := '{}'::jsonb;
begin
  -- security definer + una función que BORRA una fila: el permiso se comprueba acá
  -- adentro, no solo en el grant. Sin esto, cualquier usuario autenticado —aunque no
  -- esté en user_roles— podría fusionar contactos ajenos.
  if not public.is_member() then
    return jsonb_build_object('ok', false, 'error', 'sin permiso');
  end if;
  if p_queda is null or p_absorbido is null then
    return jsonb_build_object('ok', false, 'error', 'faltan los dos contactos');
  end if;
  if p_queda = p_absorbido then
    return jsonb_build_object('ok', false, 'error', 'son el mismo contacto');
  end if;
  select * into vive from public.leads where id = p_queda;
  if not found then return jsonb_build_object('ok', false, 'error', 'el contacto que queda no existe'); end if;
  select * into dup  from public.leads where id = p_absorbido;
  if not found then return jsonb_build_object('ok', false, 'error', 'el contacto a absorber no existe'); end if;

  -- 1. mudar TODO lo que cuelga, tabla por tabla, según el catálogo
  for col in
    select c.table_name, c.data_type
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'lead_id'
      and t.table_type = 'BASE TABLE' and c.table_name <> 'leads'
  loop
    if col.data_type = 'text' then
      execute format('update public.%I set lead_id = %L where lead_id = %L',
                     col.table_name, p_queda::text, p_absorbido::text);
    else
      execute format('update public.%I set lead_id = %s where lead_id = %s',
                     col.table_name, p_queda, p_absorbido);
    end if;
    get diagnostics movidas = row_count;
    if movidas > 0 then
      detalle := detalle || jsonb_build_object(col.table_name, movidas);
      total := total + movidas;
    end if;
  end loop;

  -- 2. completar lo que al superviviente le falta y el absorbido sí tenía
  update public.leads set
    name         = coalesce(nullif(btrim(coalesce(name,'')),''), dup.name),
    first_name   = coalesce(nullif(btrim(coalesce(first_name,'')),''), dup.first_name),
    last_name    = coalesce(nullif(btrim(coalesce(last_name,'')),''), dup.last_name),
    company      = coalesce(nullif(btrim(coalesce(company,'')),''), dup.company),
    phone        = coalesce(nullif(btrim(coalesce(phone,'')),''), dup.phone),
    email        = coalesce(nullif(btrim(coalesce(email,'')),''), dup.email),
    job_title    = coalesce(job_title, dup.job_title),
    session_id   = coalesce(session_id, dup.session_id),
    channel      = coalesce(channel, dup.channel),
    gclid        = coalesce(gclid, dup.gclid),
    utm_source   = coalesce(utm_source, dup.utm_source),
    utm_campaign = coalesce(utm_campaign, dup.utm_campaign),
    landing_path = coalesce(landing_path, dup.landing_path),
    form_path    = coalesce(form_path, dup.form_path),
    lang         = coalesce(lang, dup.lang),
    -- el mensaje NO se pisa: si el absorbido decía otra cosa, se pega abajo
    message      = case
                     when nullif(btrim(coalesce(dup.message,'')),'') is null then message
                     when nullif(btrim(coalesce(message,'')),'') is null then dup.message
                     when position(btrim(dup.message) in coalesce(message,'')) > 0 then message
                     else coalesce(message,'') || E'\n— — —\n' || dup.message
                   end,
    -- fechas de embudo: la MÁS TEMPRANA de las dos es la verdadera
    contacted_at = least(contacted_at, dup.contacted_at),
    videocall_at = least(videocall_at, dup.videocall_at),
    proposal_at  = least(proposal_at,  dup.proposal_at),
    won_at       = least(won_at,       dup.won_at),
    created_at   = least(created_at,   dup.created_at)
  where id = p_queda;

  -- 3. dejar constancia en el historial: quién absorbió a quién y cuándo
  insert into public.lead_events (lead_id, kind, label, created_at)
  values (p_queda, 'merge',
          'Se unificó a mano con «' || coalesce(nullif(btrim(coalesce(dup.name,'')),''), dup.email, '#' || dup.id)
          || '» (#' || dup.id || ', creado el ' || to_char(dup.created_at, 'DD/MM/YYYY') || ')', now());

  -- 4. recién ahora, con todo mudado, se borra la fila vacía
  delete from public.leads where id = p_absorbido;

  return jsonb_build_object('ok', true, 'movidas', total, 'detalle', detalle,
                            'queda', p_queda, 'absorbido', p_absorbido);
end $$;

-- Solo el dashboard, y solo gente del equipo (is_member) — nunca anon.
revoke all on function public.fusionar_contactos(bigint, bigint) from public, anon;
grant execute on function public.fusionar_contactos(bigint, bigint) to authenticated;

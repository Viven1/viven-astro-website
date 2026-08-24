-- 0133: fusionar los contactos duplicados que quedaron de antes.
--
-- La 0132 impide que se creen nuevos. Esta arregla los que ya estaban: 5 emails
-- repartidos en 12 filas. Dos son prospectos REALES con trabajo encima:
--   pool@agepa.ch                → #49 (2 tareas, 1 deal, 6 emails) y #62 (1 deal, 4 emails)
--   m.hamon@terminal9studios.com → #69 y #88, con un deal CADA UNO
-- o sea que el pipeline también estaba partido en dos.
--
-- REGLA: no se borra contenido. Sebastián: "mergea pero sin borrar el contenido,
-- que uno reciba todo". Todo lo que colgaba del duplicado se muda al que queda;
-- recién cuando no le cuelga nada, se borra la fila vacía.
--
-- Las tablas hijas NO se listan a mano: se sacan de information_schema en el
-- momento (19 hoy). Escribir la lista a mano es garantizar que la próxima tabla
-- que alguien agregue deje contenido huérfano sin que nadie se entere.
-- Ojo con los tipos: lead_id es bigint en unas y text en otras.

do $$
declare
  grupo   record;
  dup     record;
  col     record;
  quedan  bigint;
  movidas int;
  total   int := 0;
begin
  for grupo in
    select lower(btrim(email)) as email, min(created_at) as primera
    from public.leads
    where email is not null and btrim(email) <> ''
    group by 1
    having count(*) > 1
  loop
    -- el que queda: el más viejo (es al que apuntan los links que ya se mandaron)
    select id into quedan from public.leads
     where lower(btrim(email)) = grupo.email
     order by created_at asc, id asc limit 1;

    for dup in
      select * from public.leads
       where lower(btrim(email)) = grupo.email and id <> quedan
       order by created_at asc
    loop
      -- 1. mudar TODO lo que cuelga, tabla por tabla, según el catálogo
      movidas := 0;
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
                         col.table_name, quedan::text, dup.id::text);
        else
          execute format('update public.%I set lead_id = %s where lead_id = %s',
                         col.table_name, quedan, dup.id);
        end if;
        get diagnostics movidas = row_count;
        total := total + movidas;
      end loop;

      -- 2. quedarse con lo que el duplicado tenía y al superviviente le falta
      update public.leads set
        name         = coalesce(nullif(btrim(coalesce(name,'')),''), dup.name),
        first_name   = coalesce(nullif(btrim(coalesce(first_name,'')),''), dup.first_name),
        last_name    = coalesce(nullif(btrim(coalesce(last_name,'')),''), dup.last_name),
        company      = coalesce(nullif(btrim(coalesce(company,'')),''), dup.company),
        phone        = coalesce(nullif(btrim(coalesce(phone,'')),''), dup.phone),
        job_title    = coalesce(job_title, dup.job_title),
        session_id   = coalesce(session_id, dup.session_id),
        channel      = coalesce(channel, dup.channel),
        gclid        = coalesce(gclid, dup.gclid),
        utm_source   = coalesce(utm_source, dup.utm_source),
        utm_campaign = coalesce(utm_campaign, dup.utm_campaign),
        landing_path = coalesce(landing_path, dup.landing_path),
        form_path    = coalesce(form_path, dup.form_path),
        lang         = coalesce(lang, dup.lang),
        message      = case
                         when nullif(btrim(coalesce(dup.message,'')),'') is null then message
                         when nullif(btrim(coalesce(message,'')),'') is null then dup.message
                         when position(btrim(dup.message) in message) > 0 then message
                         else message || E'\n— — —\n' || dup.message
                       end,
        -- fechas de embudo: la MÁS TEMPRANA de las dos es la verdadera
        contacted_at = least(contacted_at, dup.contacted_at),
        videocall_at = least(videocall_at, dup.videocall_at),
        proposal_at  = least(proposal_at,  dup.proposal_at),
        won_at       = least(won_at,       dup.won_at)
      where id = quedan;

      -- 3. dejar constancia en el historial de la persona
      insert into public.lead_events (lead_id, kind, label, created_at)
      values (quedan, 'merge',
              'Se unificó con un contacto duplicado (#' || dup.id || ') creado el '
              || to_char(dup.created_at, 'DD/MM/YYYY'), dup.created_at);

      -- 4. recién ahora, con todo mudado, se borra la fila vacía
      delete from public.leads where id = dup.id;
      raise notice 'fusionado #% en #% (% filas mudadas)', dup.id, quedan, total;
    end loop;
  end loop;
  raise notice 'total de filas hijas mudadas: %', total;
end $$;

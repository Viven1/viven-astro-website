-- ============================================================================
--  Viven — que los crons esperen la respuesta (0142)
--
--  net.http_post tiene un timeout por defecto de CINCO SEGUNDOS. Ninguno de los 23
--  crons lo pisaba, así que todos usaban ese default. Cualquier función que tarde
--  más —y las que llaman a la IA tardan entre diez segundos y un minuto— deja a la
--  base sin enterarse nunca de cómo salió: pg_net corta la espera, no guarda
--  respuesta, y cron.job_run_details igual anota "succeeded", porque el POST se
--  hizo bien. El resultado es un motor que puede estar fallando hace semanas con
--  todos los semáforos en verde.
--
--  Caso concreto del 25 ago 2026: keyword_opportunities tenía CERO filas después de
--  cuatro corridas semanales seguidas marcadas como exitosas. Llamando a la misma
--  función a mano, sin límite de tiempo, escribió 21 oportunidades a la primera.
--
--  Subir el timeout no cambia lo que hace cada tarea ni cuándo corre: solo hace que
--  la base espere la respuesta en vez de colgar el teléfono a los cinco segundos.
--  Dos minutos alcanza para la más lenta y sigue muy por debajo de cualquier riesgo
--  de acumular conexiones (son 23 tareas, casi todas una vez por día).
-- ============================================================================

do $$
declare j record; nuevo text; n int := 0;
begin
  for j in select jobid, jobname, command from cron.job loop
    -- solo las que llaman a una edge function por http; las de SQL puro no aplican
    if j.command !~ 'net\.http_post' then continue; end if;
    if j.command ~* 'timeout_milliseconds' then continue; end if;   -- ya lo tiene
    -- se agrega el parámetro al final de la llamada, sin tocar url, headers ni body
    nuevo := regexp_replace(j.command, '\)\s*;?\s*$', E',\n    timeout_milliseconds := 120000\n  );');
    perform cron.alter_job(j.jobid, command := nuevo);
    n := n + 1;
  end loop;
  raise notice 'crons actualizados: %', n;
end $$;

-- El builder del newsletter tiene un WHERE después del http_post (solo corre el
-- primer martes del mes), así que el paréntesis final no es el de la llamada y la
-- regla de arriba no lo tocó. Se le agrega el parámetro donde corresponde.
do $$
declare j record;
begin
  select jobid, command into j from cron.job where jobname = 'viven-newsletter-builder';
  if found and j.command !~* 'timeout_milliseconds' then
    perform cron.alter_job(j.jobid, command :=
      replace(j.command, E'body := ''{}''::jsonb\n  )', E'body := ''{}''::jsonb,\n    timeout_milliseconds := 120000\n  )'));
  end if;
end $$;

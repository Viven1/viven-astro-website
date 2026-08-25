-- ============================================================================
--  Viven — ¿las tablas se están llenando? (0141)
--
--  El panel "Salud de los crons" pregunta si la TAREA corrió. El 11 ago 2026 eso
--  no alcanzó: Google apagó la versión v21 de su API, el sync de Google Ads empezó
--  a recibir 404, y sin embargo el cron siguió diciendo "succeeded" todos los días
--  —porque el POST se hizo bien— y la función siguió devolviendo ok:true, porque la
--  otra mitad de su trabajo (el Sheet) sí funcionaba. Resultado: ads_daily quedó
--  congelada del 11 al 25 de agosto y el panel de Ads siguió mostrando gasto, CPL y
--  ROAS como si nada, solo que con dos semanas menos de datos adentro.
--
--  Esta función pregunta otra cosa: cuándo fue la última vez que cada tabla RECIBIÓ
--  una fila. Es la misma diferencia que entre "¿mandaste la carta?" y "¿llegó?".
--  Un proceso puede reportar éxito y no dejar nada; una tabla con datos frescos no
--  miente.
--
--  `horas_tolerancia` sale del ritmo real de cada cosa, con margen:
--    · lo continuo (visitas, actividad) tolera 24 h — de madrugada no entra nadie
--    · lo diario tolera 48 h — el de hoy puede no haber corrido todavía
--    · lo semanal, 10 días; lo mensual, 40
--  Si nunca hubo una fila, no se marca error: puede ser algo que todavía no arrancó.
-- ============================================================================

create or replace function public.frescura_de_datos()
returns table (
  tabla text, que_es text, ultima timestamptz, horas numeric,
  horas_tolerancia int, estado text
)
language plpgsql stable security definer set search_path = public as $$
declare
  esperado constant jsonb := jsonb_build_array(
    jsonb_build_object('t','pageviews',            'q','Visitas de la web',              'h',24,  'c','created_at'),
    jsonb_build_object('t','session_activity',     'q','Personas detectadas (sin bots)', 'h',24,  'c','created_at'),
    jsonb_build_object('t','ads_daily',            'q','Gasto diario de Google Ads',     'h',48,  'c','date'),
    jsonb_build_object('t','gsc_daily',            'q','Búsquedas de Google',            'h',96,  'c','date'),
    -- Bing publica sus datos con varios días de atraso POR DISEÑO: el 25 ago, con la
    -- función corriendo bien y devolviendo 2.064 filas, el dato más nuevo era del 21.
    -- Con 96 h de tolerancia esto salía en rojo estando sano, que es la peor clase de
    -- alarma: la que enseña a ignorar el panel.
    jsonb_build_object('t','bing_daily',           'q','Búsquedas de Bing',              'h',168, 'c','date'),
    jsonb_build_object('t','video_plays',          'q','Reproducciones de video',        'h',72,  'c','created_at'),
    jsonb_build_object('t','leads',                'q','Personas nuevas',                'h',336, 'c','created_at'),
    jsonb_build_object('t','email_log',            'q','Emails que salieron',            'h',336, 'c','created_at'),
    jsonb_build_object('t','blogs',                'q','Posts del blog',                 'h',240, 'c','created_at'),
    jsonb_build_object('t','cro_ideas',            'q','Ideas del motor de CRO',         'h',240, 'c','created_at'),
    jsonb_build_object('t','keyword_opportunities','q','Oportunidades de keywords',      'h',240, 'c','created_at'),
    jsonb_build_object('t','site_health_runs',     'q','Chequeo de salud del sitio',     'h',240, 'c','created_at'),
    jsonb_build_object('t','newsletter_issues',    'q','Ediciones del newsletter',       'h',960, 'c','created_at')
  );
  fila jsonb;
  ult timestamptz;
begin
  for fila in select * from jsonb_array_elements(esperado) loop
    -- la tabla puede no existir todavía (migración pendiente): se saltea, no se rompe
    if to_regclass('public.' || (fila->>'t')) is null then continue; end if;
    execute format('select max(%I)::timestamptz from public.%I', fila->>'c', fila->>'t') into ult;
    tabla := fila->>'t';
    que_es := fila->>'q';
    ultima := ult;
    horas := case when ult is null then null else round(extract(epoch from (now() - ult)) / 3600.0, 1) end;
    horas_tolerancia := (fila->>'h')::int;
    estado := case
      when ult is null then 'sin_datos'
      when extract(epoch from (now() - ult)) / 3600.0 > (fila->>'h')::int then 'viejo'
      else 'ok'
    end;
    return next;
  end loop;
end;
$$;

revoke all on function public.frescura_de_datos() from public, anon;
grant execute on function public.frescura_de_datos() to authenticated;

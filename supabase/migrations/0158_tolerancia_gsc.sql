-- gsc_daily se llena una vez por semana (viven-gsc-snapshot, lunes 07:15) y la
-- tolerancia estaba en 96 h: o sea que TODOS los jueves el panel se ponía en rojo
-- estando perfecto. Una alarma que suena con todo bien enseña a ignorar el panel, que
-- es exactamente lo que no queremos de este panel. La tolerancia pasa a 8 días: un
-- ciclo semanal más un día de gracia, así solo suena cuando de verdad se salteó una
-- corrida. (Mismo criterio que se aplicó a Bing, que publica con atraso por diseño.)
create or replace function public.frescura_de_datos()
returns table(tabla text, que_es text, ultima timestamptz, horas numeric, horas_tolerancia int, estado text)
language plpgsql security definer set search_path = public as $$
declare v record; v_sql text; v_ts timestamptz;
begin
  if not public.is_member() then raise exception 'no autorizado'; end if;
  for v in select * from jsonb_array_elements('[
      {"t":"pageviews","q":"Visitas de la web","h":24,"c":"created_at"},
      {"t":"session_activity","q":"Personas detectadas (sin bots)","h":24,"c":"created_at"},
      {"t":"ads_daily","q":"Gasto diario de Google Ads","h":48,"c":"date"},
      {"t":"gsc_daily","q":"Búsquedas de Google","h":192,"c":"date"},
      {"t":"bing_daily","q":"Búsquedas de Bing","h":168,"c":"date"},
      {"t":"video_plays","q":"Reproducciones de video","h":72,"c":"created_at"},
      {"t":"leads","q":"Personas nuevas","h":336,"c":"created_at"},
      {"t":"email_log","q":"Emails que salieron","h":336,"c":"created_at"},
      {"t":"blogs","q":"Posts del blog","h":240,"c":"created_at"},
      {"t":"cro_ideas","q":"Ideas del motor de CRO","h":240,"c":"created_at"},
      {"t":"keyword_opportunities","q":"Oportunidades de keywords","h":240,"c":"created_at"},
      {"t":"site_health_runs","q":"Chequeo de salud del sitio","h":240,"c":"created_at"},
      {"t":"newsletter_issues","q":"Ediciones del newsletter","h":960,"c":"created_at"}
    ]'::jsonb) as x(j)
  loop
    v_sql := format('select max(%I)::timestamptz from public.%I', v.j->>'c', v.j->>'t');
    begin execute v_sql into v_ts; exception when others then v_ts := null; end;
    tabla := v.j->>'t'; que_es := v.j->>'q'; ultima := v_ts;
    horas := case when v_ts is null then null else round(extract(epoch from (now() - v_ts))/3600.0, 1) end;
    horas_tolerancia := (v.j->>'h')::int;
    estado := case when v_ts is null then 'sin_datos'
                   when horas > horas_tolerancia then 'atrasado' else 'ok' end;
    return next;
  end loop;
end $$;

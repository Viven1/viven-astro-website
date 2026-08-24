-- 0128: saber si los 25 crons siguen vivos.
--
-- POR QUÉ: el sistema tiene 25 trabajos programados (gmail-sync cada 5 min,
-- automations cada 20, newsletter-dispatch, los follow-ups, los avisos de
-- licencias…). Si uno se apaga, NADIE se entera: no hay panel, no hay aviso, y
-- la única forma de mirarlo era abrir cron.job_run_details a mano en el SQL
-- Editor. Un motor apagado se parece muchísimo a un motor andando — hasta que
-- pasa un mes sin que salga un solo follow-up.
--
-- Esto expone ese dato al dashboard. La UI la hace la otra ventana contra este
-- contrato; acá está la fuente.

create or replace function public.cron_health()
returns table (
  jobname text,
  schedule text,
  activo boolean,
  last_run timestamptz,
  last_status text,
  last_message text,
  minutos_desde numeric,
  esperado_cada_min integer,
  estado text
)
language plpgsql
security definer            -- cron.* es del rol postgres; sin esto nadie lo lee
set search_path = public, cron
stable
as $$
begin
  -- Los datos de qué corre y qué falla no son públicos: quién no está en la
  -- lista no pregunta. Mismo criterio que el resto de la base desde la 0127.
  if not public.is_member() then
    raise exception 'no autorizado';
  end if;

  return query
  with ultima as (
    -- la corrida más reciente de cada job (no el histórico entero: son miles)
    select distinct on (d.jobid) d.jobid, d.status, d.return_message, d.start_time
    from cron.job_run_details d
    order by d.jobid, d.start_time desc
  ),
  base as (
    select
      j.jobname::text as jobname,
      j.schedule::text as schedule,
      j.active as activo,
      u.start_time as last_run,
      u.status::text as last_status,
      left(coalesce(u.return_message, ''), 200)::text as last_message,
      round(extract(epoch from (now() - u.start_time)) / 60.0, 1) as minutos_desde,
      -- Cada cuánto DEBERÍA correr. Es una aproximación a propósito: cubre los
      -- patrones que este proyecto usa de verdad, no el estándar cron completo.
      -- Si aparece uno raro devuelve null y el estado queda en 'sin_referencia'
      -- en vez de inventar una alarma.
      case
        -- '*/15 5-16 * * 1-5' es un patrón real de este proyecto
        -- (newsletter-dispatch): cada 15 min pero solo en horario laboral. El
        -- primer intento solo aceptaba '*/N * * * *' y lo dejaba en
        -- 'sin_referencia', o sea sin vigilancia justo sobre el motor que manda
        -- newsletters. Se acepta cualquier resto en hora/día.
        when j.schedule ~ '^\*/[0-9]+ '
          -- fuera de la franja horaria puede pasar toda la noche sin correr sin
          -- que esté roto: se le da margen de un día cuando la hora está acotada
          then case when j.schedule ~ '^\*/[0-9]+ \* '
                    then (regexp_match(j.schedule, '^\*/([0-9]+)'))[1]::int
                    else 1440 end
        when j.schedule ~ '^[0-9]+ \* \* \* \*$'  then 60
        when j.schedule ~ '^[0-9]+ [0-9,\-]+ \* \* \*$' then 1440
        when j.schedule ~ '^[0-9]+ [0-9]+ \* \* [0-9\-,]+$' then 10080
        when j.schedule ~ '^[0-9]+ [0-9]+ [0-9\-,]+ \* \*$' then 43200
        else null
      end as esperado_cada_min
    from cron.job j
    left join ultima u on u.jobid = j.jobid
  )
  select
    b.jobname, b.schedule, b.activo, b.last_run, b.last_status, b.last_message,
    b.minutos_desde, b.esperado_cada_min,
    case
      when not b.activo                              then 'apagado'
      when b.last_run is null                        then 'nunca_corrio'
      when b.last_status <> 'succeeded'              then 'fallo'
      when b.esperado_cada_min is null               then 'sin_referencia'
      -- dos ciclos de gracia: un cron puede atrasarse uno sin que pase nada.
      -- Alarmar al primero convierte el panel en ruido y se deja de mirar.
      when b.minutos_desde > b.esperado_cada_min * 2 then 'atrasado'
      else 'ok'
    end::text as estado
  from base b
  order by
    case
      when not b.activo then 0
      when b.last_run is null then 1
      when b.last_status <> 'succeeded' then 2
      when b.esperado_cada_min is not null and b.minutos_desde > b.esperado_cada_min * 2 then 3
      else 9
    end,
    b.jobname;
end $$;

revoke execute on function public.cron_health() from anon;
grant execute on function public.cron_health() to authenticated;

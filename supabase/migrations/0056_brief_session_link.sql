-- 0056: conectar el brief con la sesión web del visitante.
-- Sebastián: "quiero ver todo lo que vio en la web, landing pages, etc." — para un lead
-- nacido del brief eso era imposible: la página /brief/ no mandaba session_id, así que
-- el lead creado por el trigger quedaba sin conexión con sus pageviews/videos.
-- (1) briefs.session_id nuevo; (2) el trigger lo propaga al lead (al crearlo, o
-- backfill si el lead existente no tenía sesión). Aditivo, sin tocar datos existentes.

alter table public.briefs add column if not exists session_id text;

create or replace function public.brief_autolead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lid bigint;
  msg text;
begin
  if new.email is null or btrim(new.email) = '' then
    return new;
  end if;

  -- ¿ya existe la persona?
  select id into lid from public.leads where lower(email) = lower(new.email) limit 1;

  if lid is null then
    msg := concat_ws(' · ',
      case when new.goal         is not null then 'Objetivo: '    || new.goal         end,
      case when new.distribution is not null then 'Canales: '     || new.distribution end,
      case when new.timeline     is not null then 'Timing: '      || new.timeline     end,
      case when new.budget       is not null then 'Presupuesto: ' || new.budget       end,
      case when new.extra        is not null then new.extra                            end);
    insert into public.leads (name, email, status, channel, lang, message, session_id)
    values (
      coalesce(nullif(btrim(new.name), ''), initcap(replace(split_part(new.email, '@', 1), '.', ' '))),
      lower(new.email),
      'new',
      'brief',
      coalesce(new.lang, 'en'),
      nullif('📋 Vía brief — ' || coalesce(msg, ''), '📋 Vía brief — '),
      new.session_id
    )
    returning id into lid;
  elsif new.session_id is not null then
    -- lead existente sin sesión conocida → ahora sabemos cuál es su sesión web
    update public.leads set session_id = new.session_id
      where id = lid and (session_id is null or session_id = '');
  end if;

  -- ligar el brief a la persona (si no venía con ?lead= del email)
  if new.lead_id is null or btrim(new.lead_id) = '' then
    new.lead_id := lid::text;
  end if;

  return new;
end;
$$;

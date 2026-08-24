-- 0028: brief → contacto automático.
-- Si llega un brief con un email que NO existe en leads, se crea la persona
-- (channel 'brief', con el resumen de sus respuestas como mensaje) y el brief
-- queda ligado. Si el email ya existe, solo se liga el brief a esa persona.
-- Así nadie que se toma el tiempo de completar el brief queda fuera del CRM.

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
    insert into public.leads (name, email, status, channel, lang, message)
    values (
      coalesce(nullif(btrim(new.name), ''), initcap(replace(split_part(new.email, '@', 1), '.', ' '))),
      lower(new.email),
      'new',
      'brief',
      coalesce(new.lang, 'en'),
      nullif('📋 Vía brief — ' || coalesce(msg, ''), '📋 Vía brief — ')
    )
    returning id into lid;
  end if;

  -- ligar el brief a la persona (si no venía con ?lead= del email)
  if new.lead_id is null or btrim(new.lead_id) = '' then
    new.lead_id := lid::text;
  end if;

  return new;
end;
$$;

drop trigger if exists briefs_autolead on public.briefs;
create trigger briefs_autolead
  before insert on public.briefs
  for each row execute function public.brief_autolead();

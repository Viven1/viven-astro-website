-- 0132: una persona = un contacto, con TODO lo que hizo a la vista.
--
-- QUÉ PASABA (2026-08-23): cada formulario insertaba un contacto nuevo sin
-- fijarse si esa persona ya existía. Quien bajaba dos guías, o usaba la
-- calculadora y después escribía, aparecía dos o tres veces como personas
-- distintas. Medido: 5 emails duplicados, incluidos dos prospectos reales
-- (pool@agepa.ch y m.hamon@…) con un deal colgando de CADA fila — o sea que el
-- pipeline también estaba partido.
--
-- Hay TRES puertas de entrada (el sitio inserta directo en /rest/v1/leads, más
-- las functions magnet-download y bexio-import-clients). Arreglar cliente por
-- cliente es garantía de que la próxima puerta que alguien agregue vuelva a
-- duplicar. Por eso se arregla acá abajo, donde pasan las tres.
--
-- NO ROMPE A QUIEN INSERTA: los tres mandan sin pedir la fila de vuelta (el
-- sitio usa `Prefer: return=minimal`), así que un trigger que devuelve NULL les
-- contesta 201 igual. Verificado en site.js antes de escribir esto.

-- ---------------------------------------------------------------------------
-- 1. Historial: qué hizo cada persona, sin depender de crear filas nuevas
-- ---------------------------------------------------------------------------
create table if not exists public.lead_events (
  id          bigserial primary key,
  lead_id     bigint not null references public.leads(id) on delete cascade,
  kind        text not null,              -- 'form' | 'magnet' | 'newsletter' | 'calculadora'
  label       text,                       -- qué pidió/bajó, en palabras
  lang        text,
  form_path   text,
  created_at  timestamptz not null default now()
);
create index if not exists lead_events_lead_idx on public.lead_events (lead_id, created_at desc);

alter table public.lead_events enable row level security;
drop policy if exists lead_events_select_auth on public.lead_events;
create policy lead_events_select_auth on public.lead_events
  for select to authenticated using (public.is_member());

-- ---------------------------------------------------------------------------
-- 2. El de-duplicador
-- ---------------------------------------------------------------------------
create or replace function public.leads_un_contacto_por_persona()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ya public.leads%rowtype;
  etiqueta text;
begin
  if new.email is null or btrim(new.email) = '' then
    return new;                     -- sin email no hay forma de saber si es la misma persona
  end if;

  select * into ya from public.leads
   where lower(email) = lower(btrim(new.email))
   order by created_at asc
   limit 1;

  if not found then
    return new;                     -- persona nueva: se crea normalmente
  end if;

  /* Rellenar SOLO lo que está vacío. Nunca pisar lo que ya hay: alguien puede
     haber corregido el nombre o la empresa a mano en el CRM, y una carga
     posterior desde un formulario no puede deshacer ese trabajo. */
  update public.leads set
    name           = coalesce(nullif(btrim(coalesce(name,'')),''), new.name),
    first_name     = coalesce(nullif(btrim(coalesce(first_name,'')),''), new.first_name),
    last_name      = coalesce(nullif(btrim(coalesce(last_name,'')),''), new.last_name),
    company        = coalesce(nullif(btrim(coalesce(company,'')),''), new.company),
    phone          = coalesce(nullif(btrim(coalesce(phone,'')),''), new.phone),
    session_id     = coalesce(session_id, new.session_id),
    channel        = coalesce(channel, new.channel),
    gclid          = coalesce(gclid, new.gclid),
    utm_source     = coalesce(utm_source, new.utm_source),
    utm_campaign   = coalesce(utm_campaign, new.utm_campaign),
    landing_path   = coalesce(landing_path, new.landing_path),
    lang           = coalesce(lang, new.lang),
    /* El mensaje SÍ se acumula: es lo que la persona dijo cada vez, y perder el
       segundo pedido por quedarnos con el primero sería justo lo contrario de
       "que se vea todo lo que hizo". */
    message        = case
                       when new.message is null or btrim(new.message) = '' then message
                       when message is null or btrim(message) = '' then new.message
                       when position(btrim(new.message) in message) > 0 then message
                       else message || E'\n— — —\n' || new.message
                     end
  where id = ya.id;

  -- y queda registrado como un hecho aparte, con su fecha propia
  etiqueta := nullif(btrim(coalesce(new.message,'')),'');
  insert into public.lead_events (lead_id, kind, label, lang, form_path)
  values (ya.id,
          case
            when coalesce(new.message,'') ilike '%lead magnet%'  then 'magnet'
            when coalesce(new.message,'') ilike '%newsletter%'   then 'newsletter'
            when coalesce(new.message,'') ilike '%CALCULADORA%'  then 'calculadora'
            else 'form'
          end,
          etiqueta, new.lang, new.form_path);

  return null;                      -- no se crea fila nueva
end $$;

drop trigger if exists leads_un_contacto_por_persona_tg on public.leads;
create trigger leads_un_contacto_por_persona_tg
  before insert on public.leads
  for each row execute function public.leads_un_contacto_por_persona();

-- ---------------------------------------------------------------------------
-- 3. Historial de lo que YA pasó (para que la ficha no arranque vacía)
-- ---------------------------------------------------------------------------
insert into public.lead_events (lead_id, kind, label, lang, form_path, created_at)
select l.id,
       case
         when coalesce(l.message,'') ilike '%lead magnet%' then 'magnet'
         when coalesce(l.message,'') ilike '%newsletter%'  then 'newsletter'
         when coalesce(l.message,'') ilike '%CALCULADORA%' then 'calculadora'
         else 'form'
       end,
       nullif(btrim(coalesce(l.message,'')),''),
       l.lang, l.form_path, l.created_at
from public.leads l
where nullif(btrim(coalesce(l.message,'')),'') is not null
  and not exists (select 1 from public.lead_events e where e.lead_id = l.id);
